// Dice notation parser and roller. No Obsidian imports, so it is unit-testable.
//
// Reads the notation the Dice Roller plugin's `dice:` blocks use:
//   3d6 + 2, (1d4+2)*2, d20, 2d20kh1, 4d6dl1, 1d6!, 1d6!!, 1d6!i, 1d6!>4,
//   4d6r, 4d6ri, 4d6r<3, 5d10>=8 (count successes), 4dF, d%, d66%, 3d[2,5],
//   8d6s, 8d6sd, 3d6u, 1dS (Fantasy AGE stunt dice).
// Names of numbers from the note (frontmatter or `field:: 3`) can stand in for
// numbers when they are passed as `vars`: 1d20 + dex.

export type Rng = () => number; // uniform in [0, 1)

export type Cmp = '=' | '!=' | '>' | '<' | '>=' | '<=';
export interface Condition { cmp: Cmp; value: number }

export interface Die {
	value: number;
	kept: boolean;
	exploded?: boolean; // this die came from an explosion
	rerolled?: boolean; // this die was rerolled (shown struck out)
	stunt?: boolean; // the stunt die of a Fantasy AGE roll
}

export interface DiceGroup {
	notation: string; // e.g. "2d20kh1"
	faces: string; // "20", "F", "%", "66%", "[2,5]"
	dice: Die[];
	total: number;
	successes?: number; // set when a success condition was given
	stuntPoints?: number; // Fantasy AGE: doubles were rolled, worth the stunt die
}

export interface RollResult {
	expression: string;
	total: number;
	groups: DiceGroup[];
}

export interface RollOptions {
	rng?: Rng;
	defaultFaces?: number; // for a bare "d" with no faces, default 100 like Dice Roller
	vars?: Record<string, number>; // named numbers from the note
}

const MAX_DICE = 1000;
const MAX_REPEAT = 100; // cap for infinite explode / reroll / unique

export class DiceError extends Error {}

// ---------- tokens ----------

type Tok =
	| { t: 'num'; v: number; raw: string }
	| { t: 'dice'; raw: string; spec: DiceSpec }
	| { t: 'op'; v: '+' | '-' | '*' | '/' | '^' }
	| { t: '('; }
	| { t: ')'; };

interface DiceSpec {
	count: number;
	faces: string;
	min: number;
	max: number;
	fudge: boolean;
	d66: boolean;
	stunt: boolean;
	keep?: { high: boolean; n: number };
	drop?: { high: boolean; n: number };
	explode?: { times: number; compound: boolean; cond?: Condition };
	reroll?: { times: number; cond?: Condition };
	sort?: 'asc' | 'desc';
	unique: boolean;
	success?: Condition;
}

const DICE_RE =
	/^(\d*)[dD](\d+%?|%|[fF]|S|\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\])?/;
const COND_RE = /^(>=|<=|=!|!=|>|<|=)(-?\d+)/;

function parseCond(s: string, i: number): [Condition | undefined, number] {
	const m = COND_RE.exec(s.slice(i));
	if (!m) return [undefined, i];
	let cmp = m[1] as string;
	if (cmp === '=!') cmp = '!=';
	return [{ cmp: cmp as Cmp, value: Number(m[2]) }, i + m[0].length];
}

function parseDice(s: string, start: number, opts: RollOptions): [Tok, number] {
	const m = DICE_RE.exec(s.slice(start));
	if (!m) throw new DiceError(`Bad dice at "${s.slice(start, start + 8)}"`);
	let i = start + m[0].length;
	const count = m[1] ? Number(m[1]) : 1;
	if (count > MAX_DICE) throw new DiceError(`Too many dice (${count})`);
	const faceRaw = m[2] ?? String(opts.defaultFaces ?? 100);
	const spec: DiceSpec = {
		count,
		faces: faceRaw,
		min: 1,
		max: 0,
		fudge: false,
		d66: false,
		stunt: false,
		unique: false,
	};
	if (faceRaw === 'S') {
		// Fantasy AGE: three d6, one of them the stunt die
		if (count !== 1) throw new DiceError('Roll stunt dice one at a time: 1dS');
		spec.stunt = true;
		spec.count = 3;
		spec.max = 6;
	} else if (faceRaw === '%') {
		spec.max = 100;
		spec.faces = '%';
	} else if (faceRaw === 'F' || faceRaw === 'f') {
		spec.fudge = true;
		spec.min = -1;
		spec.max = 1;
		spec.faces = 'F';
	} else if (faceRaw.startsWith('[')) {
		spec.min = Number(m[3]);
		spec.max = Number(m[4]);
		spec.faces = `[${spec.min},${spec.max}]`;
		if (spec.max < spec.min) throw new DiceError(`Bad range ${spec.faces}`);
	} else if (faceRaw.endsWith('%')) {
		// d66% style: each digit is its own d6 (d88% -> two d8, and so on)
		const digits = faceRaw.slice(0, -1);
		if (!/^(\d)\1$/.test(digits)) throw new DiceError(`Bad dice d${faceRaw}`);
		spec.d66 = true;
		spec.max = Number(digits[0]);
		spec.faces = faceRaw;
	} else {
		spec.max = Number(faceRaw);
		if (spec.max < 1) throw new DiceError(`A die needs at least one face`);
	}

	// modifiers, in any order
	for (;;) {
		const rest = s.slice(i);
		let mm: RegExpExecArray | null;
		if ((mm = /^(kh|kl|k)(\d*)/.exec(rest))) {
			spec.keep = { high: mm[1] !== 'kl', n: mm[2] ? Number(mm[2]) : 1 };
			i += mm[0].length;
		} else if ((mm = /^(dh|dl|d)(\d*)(?![dD\d%fF[])/.exec(rest)) && !/^d\d*[dD]/.test(rest)) {
			spec.drop = { high: mm[1] === 'dh', n: mm[2] ? Number(mm[2]) : 1 };
			i += mm[0].length;
		} else if ((mm = /^(!!|!i|!)(\d*)/.exec(rest))) {
			const [cond, j] = parseCond(s, i + mm[0].length);
			spec.explode = {
				times: mm[1] === '!i' ? Infinity : mm[2] ? Number(mm[2]) : 1,
				compound: mm[1] === '!!',
				cond,
			};
			i = j;
		} else if ((mm = /^(ri|r)(\d*)/.exec(rest))) {
			const [cond, j] = parseCond(s, i + mm[0].length);
			spec.reroll = { times: mm[1] === 'ri' ? Infinity : mm[2] ? Number(mm[2]) : 1, cond };
			i = j;
		} else if ((mm = /^(sd|sa|s)/.exec(rest))) {
			spec.sort = mm[1] === 'sd' ? 'desc' : 'asc';
			i += mm[0].length;
		} else if ((mm = /^u/.exec(rest))) {
			spec.unique = true;
			i += 1;
		} else if (COND_RE.test(rest)) {
			const [cond, j] = parseCond(s, i);
			spec.success = cond;
			i = j;
		} else break;
	}
	return [{ t: 'dice', raw: s.slice(start, i), spec }, i];
}

export function tokenize(src: string, opts: RollOptions = {}): Tok[] {
	const s = src.replace(/\s+/g, '');
	const out: Tok[] = [];
	let i = 0;
	while (i < s.length) {
		const c = s[i] as string;
		if (c === '(') { out.push({ t: '(' }); i++; continue; }
		if (c === ')') { out.push({ t: ')' }); i++; continue; }
		if (/[A-Za-z_]/.test(c)) {
			// a named number from the note, if there is one by that name
			const name = /^[A-Za-z_]\w*/.exec(s.slice(i))![0];
			const vars = opts.vars ?? {};
			const key = Object.keys(vars).find((k) => k.toLowerCase() === name.toLowerCase());
			if (key !== undefined) {
				out.push({ t: 'num', v: vars[key]!, raw: name });
				i += name.length;
				continue;
			}
			if (!/^[dD](\d|%|[fFS]|\[|$)/.test(name) || (name.length > 1 && /^[dD][a-zA-Z_]/.test(name) && !/^[dD][fFS]$/.test(name)))
				throw new DiceError(`No field "${name}" in this note`);
		}
		if ('+-*/^'.includes(c)) { out.push({ t: 'op', v: c as '+' }); i++; continue; }
		if (/[\dDd]/.test(c)) {
			// dice if a "d" follows the optional count
			const dm = /^\d*[dD]/.exec(s.slice(i));
			if (dm) {
				const [tok, j] = parseDice(s, i, opts);
				out.push(tok);
				i = j;
				continue;
			}
			const nm = /^\d+(\.\d+)?/.exec(s.slice(i));
			if (nm) {
				out.push({ t: 'num', v: Number(nm[0]), raw: nm[0] });
				i += nm[0].length;
				continue;
			}
		}
		throw new DiceError(`Unexpected "${c}" in "${src}"`);
	}
	return out;
}

// ---------- rolling one dice group ----------

function test(c: Condition | undefined, v: number): boolean {
	if (!c) return false;
	switch (c.cmp) {
		case '=': return v === c.value;
		case '!=': return v !== c.value;
		case '>': return v > c.value;
		case '<': return v < c.value;
		case '>=': return v >= c.value;
		case '<=': return v <= c.value;
	}
}

function rollOne(spec: DiceSpec, rng: Rng): number {
	if (spec.d66) {
		// each digit is a separate die; d66% -> 11..66
		const faces = spec.max;
		const tens = Math.floor(rng() * faces) + 1;
		const ones = Math.floor(rng() * faces) + 1;
		return tens * 10 + ones;
	}
	const span = spec.max - spec.min + 1;
	return Math.floor(rng() * span) + spec.min;
}

export function rollGroup(spec: DiceSpec, raw: string, rng: Rng): DiceGroup {
	const dice: Die[] = [];
	const maxFace = spec.d66 ? spec.max * 11 : spec.max;
	const minFace = spec.d66 ? 11 : spec.min;
	const explodeOn = (v: number) =>
		spec.explode ? (spec.explode.cond ? test(spec.explode.cond, v) : v === maxFace) : false;
	const rerollOn = (v: number) =>
		spec.reroll ? (spec.reroll.cond ? test(spec.reroll.cond, v) : v === minFace) : false;

	for (let n = 0; n < spec.count; n++) {
		let v = rollOne(spec, rng);
		// reroll
		if (spec.reroll) {
			let left = Math.min(spec.reroll.times, MAX_REPEAT);
			while (left > 0 && rerollOn(v)) {
				dice.push({ value: v, kept: false, rerolled: true });
				v = rollOne(spec, rng);
				left--;
			}
		}
		// explode
		if (spec.explode) {
			let left = Math.min(spec.explode.times, MAX_REPEAT);
			if (spec.explode.compound) {
				let sum = v;
				let last = v;
				while (left > 0 && explodeOn(last)) {
					last = rollOne(spec, rng);
					sum += last;
					left--;
				}
				dice.push({ value: sum, kept: true, exploded: sum !== v });
				continue;
			}
			dice.push({ value: v, kept: true });
			let last = v;
			while (left > 0 && explodeOn(last)) {
				last = rollOne(spec, rng);
				dice.push({ value: last, kept: true, exploded: true });
				left--;
			}
			continue;
		}
		dice.push({ value: v, kept: true });
	}

	// unique: reroll duplicates among kept dice
	if (spec.unique) {
		const seen = new Set<number>();
		for (const d of dice) {
			if (!d.kept) continue;
			let tries = MAX_REPEAT;
			while (seen.has(d.value) && tries-- > 0) d.value = rollOne(spec, rng);
			seen.add(d.value);
		}
	}

	// keep / drop operate on kept dice only
	const live = dice.filter((d) => d.kept);
	if (spec.keep) {
		const order = [...live].sort((a, b) => (spec.keep!.high ? b.value - a.value : a.value - b.value));
		for (const d of order.slice(spec.keep.n)) d.kept = false;
	}
	if (spec.drop) {
		const order = [...live].sort((a, b) => (spec.drop!.high ? b.value - a.value : a.value - b.value));
		for (const d of order.slice(0, spec.drop.n)) d.kept = false;
	}
	if (spec.sort) {
		dice.sort((a, b) => (spec.sort === 'asc' ? a.value - b.value : b.value - a.value));
	}

	const kept = dice.filter((d) => d.kept);
	const group: DiceGroup = { notation: raw, faces: spec.faces, dice, total: 0 };
	if (spec.stunt) {
		const last = dice[dice.length - 1]!;
		last.stunt = true;
		const values = dice.map((d) => d.value);
		if (new Set(values).size < values.length) group.stuntPoints = last.value;
	}
	if (spec.success) {
		group.successes = kept.filter((d) => test(spec.success, d.value)).length;
		group.total = group.successes;
	} else {
		group.total = kept.reduce((a, d) => a + d.value, 0);
	}
	return group;
}

// ---------- expression evaluation ----------

class Parser {
	private i = 0;
	groups: DiceGroup[] = [];
	constructor(private toks: Tok[], private rng: Rng) {}

	private peek(): Tok | undefined { return this.toks[this.i]; }
	private next(): Tok | undefined { return this.toks[this.i++]; }

	parse(): number {
		if (this.toks.length === 0) throw new DiceError('Nothing to roll');
		const v = this.additive();
		if (this.i < this.toks.length) throw new DiceError('Unexpected input after expression');
		return v;
	}
	private additive(): number {
		let v = this.multiplicative();
		for (;;) {
			const t = this.peek();
			if (t?.t === 'op' && (t.v === '+' || t.v === '-')) {
				this.next();
				const r = this.multiplicative();
				v = t.v === '+' ? v + r : v - r;
			} else return v;
		}
	}
	private multiplicative(): number {
		let v = this.power();
		for (;;) {
			const t = this.peek();
			if (t?.t === 'op' && (t.v === '*' || t.v === '/')) {
				this.next();
				const r = this.power();
				if (t.v === '/' && r === 0) throw new DiceError('Division by zero');
				v = t.v === '*' ? v * r : v / r;
			} else return v;
		}
	}
	private power(): number {
		const base = this.unary();
		const t = this.peek();
		if (t?.t === 'op' && t.v === '^') {
			this.next();
			return Math.pow(base, this.power()); // right-associative
		}
		return base;
	}
	private unary(): number {
		const t = this.peek();
		if (t?.t === 'op' && (t.v === '-' || t.v === '+')) {
			this.next();
			const v = this.unary();
			return t.v === '-' ? -v : v;
		}
		return this.atom();
	}
	private atom(): number {
		const t = this.next();
		if (!t) throw new DiceError('Expression ended early');
		if (t.t === 'num') return t.v;
		if (t.t === 'dice') {
			const g = rollGroup(t.spec, t.raw, this.rng);
			this.groups.push(g);
			return g.total;
		}
		if (t.t === '(') {
			const v = this.additive();
			const close = this.next();
			if (!close || close.t !== ')') throw new DiceError('Missing ")"');
			return v;
		}
		throw new DiceError('Unexpected operator');
	}
}

export function roll(expression: string, opts: RollOptions = {}): RollResult {
	const rng = opts.rng ?? Math.random;
	const toks = tokenize(expression, opts);
	const p = new Parser(toks, rng);
	const total = p.parse();
	return { expression: expression.trim(), total, groups: p.groups };
}

// Average result, used for the |avg flag. Dice groups contribute their mean.
export function average(expression: string, opts: RollOptions = {}): number {
	const toks = tokenize(expression, opts);
	const rngAvg: Rng = () => 0.5; // not used; we substitute below
	const p = new Parser(
		toks.map((t) => {
			if (t.t !== 'dice') return t;
			const s = t.spec;
			let mean: number;
			if (s.d66) mean = ((s.max + 1) / 2) * 11;
			else mean = (s.min + s.max) / 2;
			let n = s.count;
			if (s.keep) n = Math.min(n, s.keep.n);
			if (s.drop) n = Math.max(0, n - s.drop.n);
			return { t: 'num', v: mean * n, raw: t.raw };
		}),
		rngAvg,
	);
	return p.parse();
}

// Plain-text breakdown, e.g. "3d6 [4, 2, 5] + 2 = 11"
export function describe(r: RollResult): string {
	const parts = r.groups.map((g) => {
		const dice = g.dice
			.map((d) => (d.kept ? String(d.value) : `~${d.value}~`) + (d.exploded ? '!' : ''))
			.join(', ');
		const s = g.successes !== undefined ? ` (${g.successes} successes)` : '';
		const sp = g.stuntPoints !== undefined ? ` (${g.stuntPoints} stunt points)` : '';
		return `${g.notation} [${dice}]${s}${sp}`;
	});
	return `${parts.join('; ')} = ${formatNumber(r.total)}`;
}

export function formatNumber(n: number): string {
	return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// The roll written out the way it happened, for writing into a note:
// "3d100 + 12 -> [75, 20, 75] + 12 -> 182"
export function spelledOut(r: RollResult): string {
	let rest = r.expression;
	let mid = '';
	for (const g of r.groups) {
		const at = rest.indexOf(g.notation);
		const kept = '[' + g.dice.filter((d) => d.kept).map((d) => d.value).join(', ') + ']';
		if (at < 0) { mid += kept; continue; }
		mid += rest.slice(0, at) + kept;
		rest = rest.slice(at + g.notation.length);
	}
	mid += rest;
	return mid === r.expression ? `${r.expression} -> ${formatNumber(r.total)}` : `${r.expression} -> ${mid} -> ${formatNumber(r.total)}`;
}
