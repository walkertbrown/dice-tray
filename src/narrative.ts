// Genesys and Star Wars narrative dice. No Obsidian imports, so it is unit-testable.
//
// Letters name the dice, with an optional count before each:
//   g/a ability, y proficiency, p difficulty (proficiency if a, c or d is used),
//   d difficulty, r/c challenge, b boost, s/k setback, w/f force.
//   `dice: 2g1y2p`, `dice: GGYPP`, `dice: 3g4d`

import { DiceError, Rng, tokenize } from './dice';

export type Kind = 'ability' | 'proficiency' | 'difficulty' | 'challenge' | 'boost' | 'setback' | 'force';

// s success, f failure, a advantage, t threat, T triumph, D despair, L light, N dark
const FACES: Record<Kind, string[]> = {
	boost: ['', '', 's', 'sa', 'aa', 'a'],
	setback: ['', '', 'f', 'f', 't', 't'],
	ability: ['', 's', 's', 'ss', 'a', 'a', 'sa', 'aa'],
	difficulty: ['', 'f', 'ff', 't', 't', 't', 'tt', 'ft'],
	proficiency: ['', 's', 's', 'ss', 'ss', 'a', 'sa', 'sa', 'sa', 'aa', 'aa', 'T'],
	challenge: ['', 'f', 'f', 'ff', 'ff', 't', 't', 'ft', 'ft', 'tt', 'tt', 'D'],
	force: ['N', 'N', 'N', 'N', 'N', 'N', 'NN', 'L', 'L', 'LL', 'LL', 'LL'],
};

export interface NarrativeDie { kind: Kind; face: string }

export interface NarrativeResult {
	expression: string;
	dice: NarrativeDie[];
	success: number; // net: negative means failures
	advantage: number; // net: negative means threat
	triumph: number;
	despair: number;
	light: number;
	dark: number;
}

export function isNarrative(src: string): boolean {
	const s = src.replace(/\s+/g, '');
	if (!/^(\d*[gaypdrcbskwf])+$/i.test(s) || !/[gaypcrbskw]/i.test(s) || /^\d*dS$/.test(s)) return false;
	// "4d6r" and "8d6sd" are ordinary dice; "2g2d1s" isn't, so the ordinary parser decides
	if (!/d\d/i.test(s)) return true;
	try { tokenize(s); return false; } catch { return true; }
}

export function parseNarrative(src: string): Kind[] {
	const s = src.replace(/\s+/g, '').toLowerCase();
	const pIsProficiency = /[acd]/.test(s);
	const kinds: Kind[] = [];
	for (const m of s.matchAll(/(\d*)([a-z])/g)) {
		const n = m[1] ? Number(m[1]) : 1;
		const l = m[2]!;
		const kind: Kind | undefined =
			l === 'g' || l === 'a' ? 'ability'
			: l === 'y' ? 'proficiency'
			: l === 'p' ? (pIsProficiency ? 'proficiency' : 'difficulty')
			: l === 'd' ? 'difficulty'
			: l === 'r' || l === 'c' ? 'challenge'
			: l === 'b' ? 'boost'
			: l === 's' || l === 'k' ? 'setback'
			: l === 'w' || l === 'f' ? 'force'
			: undefined;
		if (!kind) throw new DiceError(`Unknown narrative die "${l}"`);
		if (n > 100) throw new DiceError(`Too many dice (${n})`);
		for (let i = 0; i < n; i++) kinds.push(kind);
	}
	return kinds;
}

export function rollNarrative(src: string, rng: Rng = Math.random): NarrativeResult {
	const dice = parseNarrative(src).map((kind) => {
		const faces = FACES[kind];
		return { kind, face: faces[Math.floor(rng() * faces.length)]! };
	});
	const r: NarrativeResult = { expression: src.trim(), dice, success: 0, advantage: 0, triumph: 0, despair: 0, light: 0, dark: 0 };
	for (const d of dice) {
		for (const c of d.face) {
			if (c === 's') r.success++;
			else if (c === 'f') r.success--;
			else if (c === 'a') r.advantage++;
			else if (c === 't') r.advantage--;
			else if (c === 'T') { r.triumph++; r.success++; }
			else if (c === 'D') { r.despair++; r.success--; }
			else if (c === 'L') r.light++;
			else if (c === 'N') r.dark++;
		}
	}
	return r;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// "2 successes, 1 advantage, 1 triumph" or "1 failure, 2 threat"
export function narrativeText(r: NarrativeResult): string {
	const parts: string[] = [];
	const onlyForce = r.dice.every((d) => d.kind === 'force');
	if (!onlyForce) {
		if (r.success > 0) parts.push(plural(r.success, 'success', 'successes'));
		else if (r.success < 0) parts.push(plural(-r.success, 'failure'));
		else parts.push('no successes');
		if (r.advantage > 0) parts.push(`${r.advantage} advantage`);
		else if (r.advantage < 0) parts.push(`${-r.advantage} threat`);
		if (r.triumph) parts.push(`${r.triumph} triumph`);
		if (r.despair) parts.push(`${r.despair} despair`);
	}
	if (r.light) parts.push(`${r.light} light`);
	if (r.dark) parts.push(`${r.dark} dark`);
	return parts.join(', ');
}

const SYMBOL: Record<string, string> = { s: 'success', f: 'failure', a: 'advantage', t: 'threat', T: 'triumph', D: 'despair', L: 'light', N: 'dark' };

// Each die and what it showed, for the hover card.
export function narrativeDetail(r: NarrativeResult): string {
	return r.dice.map((d) => `${d.kind}: ${d.face ? [...d.face].map((c) => SYMBOL[c]).join(' + ') : 'blank'}`).join('; ');
}
