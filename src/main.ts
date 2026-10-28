import {
	App,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownRenderer,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	SettingDefinitionItem,
	TFile,
	setIcon,
} from 'obsidian';
import { average, describe, DiceError, formatNumber, roll, RollResult } from './dice';
import { isNarrative, narrativeDetail, narrativeText, rollNarrative } from './narrative';
import { isLookupTable, lookupRow, NoteRoll, noteFields, parseLines, parseList, parseNoteRoll, parseTable, pick, tableRows } from './notes';

interface DiceTraySettings {
	defaultFaces: number;
	showFormula: boolean; // show the notation next to the result
	animate: boolean;
	rounding: 'none' | 'nearest' | 'up' | 'down';
	history: string[]; // last expressions typed into the roll modal
}

const DEFAULT_SETTINGS: DiceTraySettings = {
	defaultFaces: 100,
	showFormula: false,
	animate: true,
	rounding: 'none',
	history: [],
};

// A `dice:` block is   dice: <expression> [|flag ...]
// Flags understood from the Dice Roller plugin: nodice, noform, form, avg, none, text(...)
interface Parsed {
	expression: string;
	flags: Set<string>;
	text?: string;
	note?: NoteRoll;
}

function parseBlock(src: string): Parsed | null {
	const m = /^dice(?:\+|-|-mod)?:\s*(.+)$/is.exec(src.trim());
	if (!m) return null;
	const body = m[1] as string;
	const note = parseNoteRoll(body);
	const parts = body.split('|').map((s) => s.trim());
	const expression = note ? body : (parts.shift() ?? '');
	const flags = new Set<string>();
	let text: string | undefined;
	for (const p of note ? parts.slice(1) : parts) {
		const t = /^text\((.*)\)$/s.exec(p);
		if (t) text = t[1];
		else flags.add(p.toLowerCase());
	}
	return { expression, flags, text, note: note ?? undefined };
}

// a word in the formula that isn't dice notation, like "dex" in `1d20 + dex`
function hasField(expression: string): boolean {
	return /(^|[^\dA-Za-z])(?![dD](\d|%|[fFS]\b|\[|\b))[A-Za-z_]/.test(expression);
}

export default class DiceTrayPlugin extends Plugin {
	settings: DiceTraySettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();
		this.registerMarkdownPostProcessor((el, ctx) => this.processInline(el, ctx));
		this.registerMarkdownCodeBlockProcessor('dice', (source, el, ctx) => {
			// ```dice
			// 3d6 + 2
			// ```  -> one roll per non-empty line
			for (const line of source.split('\n')) {
				if (!line.trim()) continue;
				const p = parseBlock(line.startsWith('dice') ? line : `dice: ${line}`);
				if (p) el.appendChild(this.renderRoll(p, ctx));
			}
		});
		this.addCommand({
			id: 'roll',
			name: 'Roll dice',
			callback: () => new RollModal(this.app, this).open(),
		});
		this.addSettingTab(new DiceTraySettingTab(this.app, this));
	}

	round(n: number): number {
		switch (this.settings.rounding) {
			case 'nearest': return Math.round(n);
			case 'up': return Math.ceil(n);
			case 'down': return Math.floor(n);
			default: return n;
		}
	}

	doRoll(expression: string, vars?: Record<string, number>): RollResult {
		const r = roll(expression, { defaultFaces: this.settings.defaultFaces, vars });
		r.total = this.round(r.total);
		return r;
	}

	// Numbers named in the note, read only when the formula has a word in it besides dice
	async noteVars(expression: string, path: string | undefined): Promise<Record<string, number> | undefined> {
		if (!path || !hasField(expression)) return undefined;
		const file = this.app.vault.getFileByPath(path);
		if (!file) return undefined;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return noteFields(await this.app.vault.cachedRead(file), fm);
	}

	private processInline(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const codes = el.querySelectorAll('code');
		for (const code of Array.from(codes)) {
			if (code.closest('pre')) continue;
			const p = parseBlock(code.textContent ?? '');
			if (!p) continue;
			code.replaceWith(this.renderRoll(p, ctx));
		}
	}

	renderRoll(p: Parsed, ctx: MarkdownPostProcessorContext): HTMLElement {
		if (p.note) return this.renderNoteRoll(p, p.note, ctx);
		if (isNarrative(p.expression)) return this.renderNarrative(p);
		const chip = createSpan({ cls: 'dice-tray' });
		if (p.flags.has('avg')) {
			try {
				// the average can't wait for the note, so a field in it shows as missing
				const avg = average(p.expression, { defaultFaces: this.settings.defaultFaces });
				chip.addClass('dice-tray-avg');
				chip.createSpan({ cls: 'dice-tray-total', text: formatNumber(this.round(avg)) });
				chip.title = `${p.expression}: average`;
			} catch (e) {
				this.renderError(chip, e);
			}
			return chip;
		}

		const icon = chip.createSpan({ cls: 'dice-tray-icon' });
		setIcon(icon, 'dices');
		const total = chip.createSpan({ cls: 'dice-tray-total' });
		const formula = chip.createSpan({ cls: 'dice-tray-formula' });
		if (p.flags.has('noform') || !(this.settings.showFormula || p.flags.has('form'))) formula.hide();
		if (p.flags.has('nodice')) icon.hide();
		formula.setText(p.expression);

		const showResult = (r: RollResult) => {
			if (p.text !== undefined) {
				total.setText(p.text);
			} else if (p.flags.has('none')) {
				total.setText('');
			} else {
				const sp = r.groups.find((g) => g.stuntPoints !== undefined)?.stuntPoints;
				total.setText(formatNumber(r.total) + (sp !== undefined ? ` (${sp} SP)` : ''));
			}
			chip.title = describe(r);
			chip.removeClass('dice-tray-crit', 'dice-tray-fumble');
			const single = r.groups.length === 1 && r.groups[0]!.dice.length === 1 ? r.groups[0]! : null;
			if (single && single.faces === '20' && single.successes === undefined) {
				const v = single.dice[0]!.value;
				if (v === 20) chip.addClass('dice-tray-crit');
				if (v === 1) chip.addClass('dice-tray-fumble');
			}
			this.renderPips(chip, r);
		};

		const go = async () => {
			let r: RollResult;
			try {
				// most rolls name no field, and those land at once, without waiting on the note
				const vars = hasField(p.expression) ? await this.noteVars(p.expression, ctx.sourcePath) : undefined;
				r = this.doRoll(p.expression, vars);
			} catch (e) {
				this.renderError(chip, e);
				return;
			}
			if (this.settings.animate && !p.flags.has('none')) this.tumble(chip, total, () => showResult(r));
			else showResult(r);
		};

		chip.setAttr('role', 'button');
		chip.setAttr('aria-label', `Roll ${p.expression}`);
		chip.addEventListener('click', (ev) => {
			ev.preventDefault();
			void go();
		});
		void go();
		return chip;
	}

	// Genesys and Star Wars pools: the net result, each die on hover
	private renderNarrative(p: Parsed): HTMLElement {
		const chip = createSpan({ cls: 'dice-tray dice-tray-narrative' });
		const icon = chip.createSpan({ cls: 'dice-tray-icon' });
		setIcon(icon, 'dices');
		if (p.flags.has('nodice')) icon.hide();
		const total = chip.createSpan({ cls: 'dice-tray-total' });
		const go = () => {
			try {
				const r = rollNarrative(p.expression);
				chip.removeClass('dice-tray-error');
				total.setText(p.text ?? narrativeText(r));
				chip.title = `${p.expression}: ${narrativeDetail(r)}`;
			} catch (e) {
				this.renderError(chip, e);
			}
		};
		chip.setAttr('role', 'button');
		chip.setAttr('aria-label', `Roll ${p.expression}`);
		chip.addEventListener('click', (ev) => {
			ev.preventDefault();
			go();
		});
		go();
		return chip;
	}

	// `dice: [[Note]]`, `dice: 2d[[Note^table]]|Column`: pick from a note.
	private renderNoteRoll(p: Parsed, n: NoteRoll, ctx: MarkdownPostProcessorContext): HTMLElement {
		const sourcePath = ctx.sourcePath;
		const wrap = createSpan({ cls: 'dice-tray dice-tray-note' });
		// a render child scoped to this element, so rendered markdown is cleaned up with it
		const child = new MarkdownRenderChild(wrap);
		ctx.addChild(child);
		const icon = wrap.createSpan({ cls: 'dice-tray-icon' });
		setIcon(icon, 'dices');
		if (p.flags.has('nodice')) icon.hide();
		const out = wrap.createSpan({ cls: 'dice-tray-note-out' });
		wrap.setAttr('role', 'button');
		wrap.setAttr('aria-label', `Roll on ${n.link}`);

		const go = async () => {
			try {
				const picks = await this.rollNote(n, sourcePath);
				out.empty();
				wrap.removeClass('dice-tray-error');
				for (const text of picks) {
					const item = out.createSpan({ cls: 'dice-tray-note-item' });
					if (p.flags.has('norender')) item.setText(text);
					else await MarkdownRenderer.render(this.app, text, item, sourcePath, child);
				}
				wrap.title = `${n.count > 1 ? n.count + ' from ' : ''}${n.link}${n.block ? '^' + n.block : ''}`;
			} catch (e) {
				this.renderError(wrap, e);
			}
		};
		wrap.addEventListener('click', (ev) => {
			// let links inside the result work
			if ((ev.target as HTMLElement).closest('a')) return;
			ev.preventDefault();
			void go();
		});
		void go();
		return wrap;
	}

	private async rollNote(n: NoteRoll, sourcePath: string): Promise<string[]> {
		const file = this.app.metadataCache.getFirstLinkpathDest(n.link, sourcePath);
		if (!(file instanceof TFile)) throw new DiceError(`No note "${n.link}"`);
		const cache = this.app.metadataCache.getFileCache(file);
		const content = await this.app.vault.cachedRead(file);
		const slice = (from: number, to: number) => content.slice(from, to);

		// narrow to a block or a heading's section: [from, to) offsets in the note
		let from = 0;
		let to = content.length;
		if (n.block) {
			const b = cache?.blocks?.[n.block];
			if (!b) throw new DiceError(`No block ^${n.block} in "${n.link}"`);
			from = b.position.start.offset;
			to = b.position.end.offset;
		} else if (n.heading) {
			const hs = cache?.headings ?? [];
			const i = hs.findIndex((h) => h.heading.toLowerCase() === n.heading!.toLowerCase());
			if (i < 0) throw new DiceError(`No heading "${n.heading}" in "${n.link}"`);
			from = hs[i]!.position.end.offset;
			const next = hs.slice(i + 1).find((h) => h.level <= hs[i]!.level);
			if (next) to = next.position.start.offset;
		} else if (cache?.frontmatterPosition) {
			from = cache.frontmatterPosition.end.offset;
		}
		const text = slice(from, to);

		const table = n.mode === 'auto' || n.mode === 'table' ? parseTable(text) : null;
		let pool: string[];
		if (table) {
			if (isLookupTable(table) && !n.column) {
				// header names the dice, e.g. "d20" or "2d6"
				const head = table.headers[0] ?? '';
				const expr = /\d*d\d+/i.test(head) ? head : `1d${table.rows.length}`;
				const picks: string[] = [];
				for (let i = 0; i < n.count; i++) {
					const r = this.doRoll(expr);
					const row = lookupRow(table, r.total);
					picks.push(row === null ? `${r.total}: no row` : `**${r.total}** ${row}`);
				}
				return picks;
			}
			pool = tableRows(table, n.column);
		} else if (n.mode === 'line') {
			pool = parseLines(text);
		} else if (n.mode === 'list' || (n.mode === 'auto' && parseList(text))) {
			pool = parseList(text) ?? [];
		} else if (n.mode === 'section') {
			// whole sections of the note (or of the heading), by the metadata cache
			const secs = (cache?.sections ?? []).filter(
				(s) => s.type !== 'heading' && s.type !== 'yaml' && s.type !== 'thematicBreak' &&
					s.position.start.offset >= from && s.position.end.offset <= to,
			);
			pool = secs.map((s) => slice(s.position.start.offset, s.position.end.offset).trim()).filter(Boolean);
			if (pool.length === 1) {
				// one list or table under the heading: pick from inside it
				const only = pool[0]!;
				const t = parseTable(only);
				pool = t ? tableRows(t) : (parseList(only) ?? pool);
			}
		} else {
			pool = parseLines(text);
		}
		if (!pool.length) throw new DiceError(`Nothing to roll on in "${n.link}"`);
		const picks: string[] = [];
		const left = [...pool];
		for (let i = 0; i < n.count; i++) {
			const src = left.length ? left : pool;
			const v = pick(src);
			left.splice(left.indexOf(v), 1);
			picks.push(v);
		}
		return picks;
	}

	// Brief number tumble before the real result lands.
	private tumble(chip: HTMLElement, total: HTMLElement, done: () => void) {
		chip.addClass('dice-tray-rolling');
		let ticks = 0;
		const timer = window.setInterval(() => {
			total.setText(String(Math.floor(Math.random() * 20) + 1));
			if (++ticks >= 6) {
				window.clearInterval(timer);
				chip.removeClass('dice-tray-rolling');
				done();
			}
		}, 45);
	}

	// The individual dice, shown as little tiles under the hover card.
	private renderPips(chip: HTMLElement, r: RollResult) {
		chip.querySelector('.dice-tray-card')?.remove();
		const card = chip.createDiv({ cls: 'dice-tray-card' });
		for (const g of r.groups) {
			const row = card.createDiv({ cls: 'dice-tray-row' });
			row.createSpan({ cls: 'dice-tray-row-label', text: g.notation });
			const tiles = row.createSpan({ cls: 'dice-tray-tiles' });
			for (const d of g.dice) {
				const t = tiles.createSpan({ cls: 'dice-tray-die', text: String(d.value) });
				if (!d.kept) t.addClass('dice-tray-die-dropped');
				if (d.exploded) t.addClass('dice-tray-die-exploded');
				if (d.stunt) t.addClass('dice-tray-die-stunt');
			}
			if (g.stuntPoints !== undefined) {
				row.createSpan({ cls: 'dice-tray-row-total', text: `${g.stuntPoints} SP` });
			} else if (g.successes !== undefined) {
				row.createSpan({ cls: 'dice-tray-row-total', text: `${g.successes} ✓` });
			} else if (g.dice.length > 1) {
				row.createSpan({ cls: 'dice-tray-row-total', text: `= ${g.total}` });
			}
		}
		if (r.groups.length !== 1 || r.groups[0]!.dice.length > 1 || /[+\-*/^]/.test(r.expression.slice(1))) {
			card.createDiv({ cls: 'dice-tray-card-total', text: `${r.expression} = ${formatNumber(r.total)}` });
		}
	}

	private renderError(chip: HTMLElement, e: unknown) {
		chip.empty();
		chip.addClass('dice-tray-error');
		const msg = e instanceof Error ? e.message : 'Could not roll';
		chip.setText(msg);
		chip.title = msg;
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<DiceTraySettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class RollModal extends Modal {
	private notePath = this.app.workspace.getActiveFile()?.path;
	constructor(app: App, private plugin: DiceTrayPlugin) {
		super(app);
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('dice-tray-modal');
		this.setTitle('Roll dice');
		const input = contentEl.createEl('input', { type: 'text', placeholder: '2d20kh1 + 5' });
		input.addClass('dice-tray-input');
		const out = contentEl.createDiv({ cls: 'dice-tray-modal-out' });
		const recent = contentEl.createDiv({ cls: 'dice-tray-recent' });
		const showRecent = () => {
			recent.empty();
			for (const h of this.plugin.settings.history) {
				const b = recent.createEl('button', { text: h });
				b.onclick = () => { input.value = h; void go(); };
			}
		};
		const go = async () => {
			const expr = input.value.trim();
			if (!expr) return;
			try {
				out.empty();
				if (isNarrative(expr)) {
					const n = rollNarrative(expr);
					out.createDiv({ cls: 'dice-tray-modal-total', text: narrativeText(n) });
					out.createDiv({ cls: 'dice-tray-modal-detail', text: narrativeDetail(n) });
				} else {
					// fields come from the note that was open when the modal was
					const r = this.plugin.doRoll(expr, await this.plugin.noteVars(expr, this.notePath));
					out.createDiv({ cls: 'dice-tray-modal-total', text: formatNumber(r.total) });
					out.createDiv({ cls: 'dice-tray-modal-detail', text: describe(r) });
				}
				const hist = [expr, ...this.plugin.settings.history.filter((h) => h !== expr)].slice(0, 8);
				this.plugin.settings.history = hist;
				await this.plugin.saveSettings();
				showRecent();
			} catch (e) {
				new Notice(e instanceof DiceError ? e.message : 'Could not roll');
			}
		};
		input.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter') void go();
		});
		showRecent();
		input.focus();
	}
	onClose() {
		this.contentEl.empty();
	}
}

class DiceTraySettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: DiceTrayPlugin) {
		super(app, plugin);
	}
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Default die',
				desc: 'Faces used when a roll says "d" with no number, like "3d".',
				control: { type: 'number', key: 'defaultFaces', min: 1, step: 1, defaultValue: 100 },
			},
			{
				name: 'Show the formula',
				desc: 'Show the dice notation next to each result.',
				control: { type: 'toggle', key: 'showFormula', defaultValue: false },
			},
			{
				name: 'Animate rolls',
				desc: 'Tumble the number briefly when a roll happens.',
				control: { type: 'toggle', key: 'animate', defaultValue: true },
			},
			{
				name: 'Round results',
				desc: 'How to round results that are not whole numbers.',
				control: {
					type: 'dropdown',
					key: 'rounding',
					options: { none: 'Do not round', nearest: 'Nearest', up: 'Up', down: 'Down' },
					defaultValue: 'none',
				},
			},
		];
	}
	getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof DiceTraySettings];
	}
	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
	}
}
