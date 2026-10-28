import {
	App,
	Component,
	editorInfoField,
	editorLivePreviewField,
	ItemView,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownRenderer,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	SettingDefinitionItem,
	TFile,
	WorkspaceLeaf,
	setIcon,
} from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { liveRolls, writeOver } from './live';
import { average, describe, DiceError, formatNumber, roll, RollResult, spelledOut } from './dice';
import { addDie, emptyPool, FACES, poolFormula, type Edge, type Face, type Pool } from './pool';
import { isNarrative, narrativeDetail, narrativeText, rollNarrative } from './narrative';
import { isLookupTable, lookupRow, NoteRoll, noteFields, parseLines, replaceInSection, parseList, parseNoteRoll, parseTable, pick, tableRows } from './notes';

interface DiceTraySettings {
	defaultFaces: number;
	showFormula: boolean; // show the notation next to the result
	animate: boolean;
	rounding: 'none' | 'nearest' | 'up' | 'down';
	history: string[]; // last expressions typed into the roll modal
	saved: string[]; // formulas kept in the dice panel
}

const DEFAULT_SETTINGS: DiceTraySettings = {
	defaultFaces: 100,
	showFormula: false,
	animate: true,
	rounding: 'none',
	history: [],
	saved: [],
};

export const PANEL = 'dice-tray-panel';

// A `dice:` block is   dice: <expression> [|flag ...]
// Flags understood from the Dice Roller plugin: nodice, noform, form, avg, none, text(...)
// `dice+:` keeps its result in the note, as the line after its last " -> ": `dice+: 1d20 + 5 -> [17] + 5 -> 22`.
// `dice-mod:` is rolled once and replaced by the plain text of the roll.
interface Parsed {
	expression: string;
	flags: Set<string>;
	text?: string;
	note?: NoteRoll;
	mode: 'roll' | 'save' | 'mod';
	saved?: string; // dice+: the result written after the expression
}

// Where an inline roll sits in its note: its section's element, its text, and which copy of that text it is.
// `gone` is shared by the section's rolls: copies already rewritten, so a later copy's count goes down by those before it.
interface Place {
	el: HTMLElement;
	src: string;
	n: number;
	gone: { src: string; n: number }[];
	// Live Preview writes through the editor instead
	write?: (to: string) => Promise<boolean>;
}

function parseBlock(src: string): Parsed | null {
	const m = /^dice(\+|-mod|-)?:\s*(.+)$/is.exec(src.trim());
	if (!m) return null;
	const mode = m[1] === '+' ? 'save' : m[1] === '-mod' ? 'mod' : 'roll';
	let body = m[2] as string;
	let saved: string | undefined;
	if (mode === 'save') {
		const at = body.indexOf(' -> ');
		if (at >= 0) { saved = body.slice(at + 4).trim(); body = body.slice(0, at); }
	}
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
	return { expression, flags, text, note: note ?? undefined, mode, saved };
}

// a word in the formula that isn't dice notation, like "dex" in `1d20 + dex`
function hasField(expression: string): boolean {
	return /(^|[^\dA-Za-z])(?![dD](\d|%|[fFS]\b|\[|\b))[A-Za-z_]/.test(expression);
}

// A roll someone made on purpose (a click, or the roll modal), not the roll a note makes as it opens.
// Other plugins can listen with app.workspace.on('dice-tray:roll', (e) => ...); Session Log writes it into the log.
export interface RollEvent {
	sourcePath: string; // the note the roll is in, or the open note for the modal; '' if none
	expression: string;
	text: string; // the roll written out: "1d20 + 5 -> [17] + 5 -> 22", "2g1p: 1 success", "[[Weather]]: Rain"
}

export default class DiceTrayPlugin extends Plugin {
	settings: DiceTraySettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();
		this.registerMarkdownPostProcessor((el, ctx) => this.processInline(el, ctx));
		this.registerEditorExtension(liveRolls((src, whole, view) => this.liveChip(src, whole, view), (s) => s.field(editorLivePreviewField, false) ?? false));
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
		this.registerView(PANEL, (leaf) => new DicePanel(leaf, this));
		this.addRibbonIcon('dices', 'Open the dice panel', () => void this.openPanel());
		this.addCommand({
			id: 'open-panel',
			name: 'Open the dice panel',
			callback: () => void this.openPanel(),
		});
		this.addSettingTab(new DiceTraySettingTab(this.app, this));
	}

	async openPanel() {
		const { workspace } = this.app;
		const leaf = workspace.getLeavesOfType(PANEL)[0] ?? workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: PANEL, active: true });
		await workspace.revealLeaf(leaf);
	}

	/** A roll typed or built by hand (the roll window, the dice panel): rolled, announced, and kept in the recent list.
	 *  Fields like `dex` come from the note that is open. Throws DiceError on a formula it can't read. */
	async rollTyped(expr: string, notePath: string | undefined): Promise<{ total: string; detail: string; text: string }> {
		let out;
		if (isNarrative(expr)) {
			const n = rollNarrative(expr);
			out = { total: narrativeText(n), detail: narrativeDetail(n), text: `${expr}: ${narrativeText(n)}` };
		} else {
			const vars = await this.noteVars(expr, notePath);
			const r = this.doRoll(expr, vars);
			const text = spelledOut(r, vars);
			// the roll as it happened, modifiers and all ("2d6 + 1 -> [2, 3] + 1 -> 6")
			out = { total: formatNumber(r.total), detail: text, text };
		}
		this.announce(notePath, expr, out.text);
		this.settings.history = [expr, ...this.settings.history.filter((h) => h !== expr)].slice(0, 8);
		await this.saveSettings();
		return out;
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

	announce(sourcePath: string | undefined, expression: string, text: string) {
		const ev: RollEvent = { sourcePath: sourcePath ?? '', expression, text };
		this.app.workspace.trigger('dice-tray:roll', ev);
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
		const copies = new Map<string, number>();
		const gone: Place['gone'] = [];
		for (const code of Array.from(codes)) {
			if (code.closest('pre')) continue;
			const src = code.textContent ?? '';
			const n = copies.get(src) ?? 0;
			copies.set(src, n + 1);
			const p = parseBlock(src);
			if (!p) continue;
			code.replaceWith(this.renderRoll(p, ctx, { el, src, n, gone }));
		}
	}

	// Rewrites an inline roll in the note's text. False when its place can't be found (an embed, a hover, a changed note).
	async rewrite(ctx: MarkdownPostProcessorContext, at: Place, to: string): Promise<boolean> {
		if (at.write) return at.write(to);
		const info = ctx.getSectionInfo(at.el);
		const file = this.app.vault.getFileByPath(ctx.sourcePath);
		if (!info || !file) return false;
		let done = false;
		const was = { src: at.src, n: at.n };
		await this.app.vault.process(file, (data) => {
			// counted here, as writes happen one at a time, after any earlier copy's
			const n = was.n - at.gone.filter((g) => g.src === was.src && g.n < was.n).length;
			const out = replaceInSection(data, info.lineStart, info.lineEnd, '`' + was.src + '`', n, to);
			if (out === null) return data;
			done = true;
			at.gone.push(was);
			return out;
		});
		return done;
	}

	// A roll in Live Preview: the reading view's chip, with any result written back through the editor.
	liveChip(src: string, whole: string, view: EditorView): HTMLElement {
		const p = parseBlock(src);
		if (!p) return createEl('code', { text: src });
		const sourcePath = view.state.field(editorInfoField, false)?.file?.path ?? '';
		const ctx = { sourcePath, addChild: (c: Component) => this.addChild(c), getSectionInfo: () => null } as unknown as MarkdownPostProcessorContext;
		let chip: HTMLElement | null = null;
		chip = this.renderRoll(p, ctx, { el: view.dom, src, n: 0, gone: [], write: (to) => writeOver(view, () => chip, whole, to) });
		return chip;
	}

	renderRoll(p: Parsed, ctx: MarkdownPostProcessorContext, at?: Place): HTMLElement {
		if (p.note) return this.renderNoteRoll(p, p.note, ctx);
		if (isNarrative(p.expression)) return this.renderNarrative(p, ctx.sourcePath);
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

		const go = async (clicked = false) => {
			let r: RollResult;
			let vars: Record<string, number> | undefined;
			try {
				// most rolls name no field, and those land at once, without waiting on the note
				vars = hasField(p.expression) ? await this.noteVars(p.expression, ctx.sourcePath) : undefined;
				r = this.doRoll(p.expression, vars);
			} catch (e) {
				this.renderError(chip, e);
				return;
			}
			const line = spelledOut(r, vars);
			if (clicked) this.announce(ctx.sourcePath, p.expression, line);
			if (at && p.mode === 'mod') {
				// replaced by its text for good; if it can't be, it stays a roll
				if (await this.rewrite(ctx, at, line)) return;
			}
			if (at && p.mode === 'save') {
				const src = `dice+: ${p.expression} -> ${line.slice(line.indexOf(' -> ') + 4)}`;
				if (await this.rewrite(ctx, at, '`' + src + '`')) at.src = src;
			}
			if (this.settings.animate && !p.flags.has('none')) this.tumble(chip, total, () => showResult(r));
			else showResult(r);
		};

		chip.setAttr('role', 'button');
		chip.setAttr('aria-label', `Roll ${p.expression}`);
		chip.addEventListener('click', (ev) => {
			ev.preventDefault();
			this.peek(chip);
			void go(true);
		});
		if (p.mode === 'save' && p.saved !== undefined) {
			// already rolled: show what the note says, and roll again only on a click
			const cut = p.saved.lastIndexOf(' -> ');
			const last = cut < 0 ? p.saved : p.saved.slice(cut + 4);
			total.setText(p.text ?? last);
			chip.title = `${p.expression} -> ${p.saved}`;
			chip.addClass('dice-tray-saved');
		} else void go();
		return chip;
	}

	// Genesys and Star Wars pools: the net result, each die on hover
	private renderNarrative(p: Parsed, sourcePath: string): HTMLElement {
		const chip = createSpan({ cls: 'dice-tray dice-tray-narrative' });
		const icon = chip.createSpan({ cls: 'dice-tray-icon' });
		setIcon(icon, 'dices');
		if (p.flags.has('nodice')) icon.hide();
		const total = chip.createSpan({ cls: 'dice-tray-total' });
		const go = (clicked = false) => {
			try {
				const r = rollNarrative(p.expression);
				chip.removeClass('dice-tray-error');
				total.setText(p.text ?? narrativeText(r));
				chip.title = `${p.expression}: ${narrativeDetail(r)}`;
				chip.querySelector('.dice-tray-card')?.remove();
				this.fit(chip.createDiv({ cls: 'dice-tray-card', text: narrativeDetail(r) }));
				if (clicked) this.announce(sourcePath, p.expression, `${p.expression}: ${narrativeText(r)}`);
			} catch (e) {
				this.renderError(chip, e);
			}
		};
		chip.setAttr('role', 'button');
		chip.setAttr('aria-label', `Roll ${p.expression}`);
		chip.addEventListener('click', (ev) => {
			ev.preventDefault();
			this.peek(chip);
			go(true);
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

		const go = async (clicked = false) => {
			try {
				const picks = await this.rollNote(n, sourcePath);
				if (clicked) this.announce(sourcePath, p.expression, `[[${n.link}${n.block ? '#^' + n.block : n.heading ? '#' + n.heading : ''}]]: ${picks.join('; ')}`);
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
			void go(true);
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

	// A phone has no hover, so a tap that rolls also opens the dice for a few seconds.
	private peek(chip: HTMLElement) {
		if (!window.matchMedia?.('(hover: none)').matches) return;
		chip.doc.querySelectorAll('.dice-tray-peek').forEach((o) => o !== chip && o.removeClass('dice-tray-peek'));
		chip.addClass('dice-tray-peek');
		const card = chip.querySelector<HTMLElement>('.dice-tray-card');
		if (card) this.fit(card);
		window.clearTimeout(this.peeks.get(chip));
		this.peeks.set(chip, window.setTimeout(() => chip.removeClass('dice-tray-peek'), 4000));
	}
	private peeks = new WeakMap<HTMLElement, number>();

	// an open card that would run off the right of the screen moves left. A phone
	// widens the page to fit the card, so the screen's own width is the edge.
	private fit(card: HTMLElement) {
		if (!card.parentElement?.classList.contains('dice-tray-peek')) return;
		card.setCssProps({ '--dice-tray-shift': '0px' });
		const edge = Math.min(window.innerWidth, window.screen?.width || Infinity) - 8;
		const over = card.getBoundingClientRect().right - edge;
		if (over > 0) card.setCssProps({ '--dice-tray-shift': `${-over}px` });
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
		this.fit(card);
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
				// fields come from the note that was open when the modal was
				const r = await this.plugin.rollTyped(expr, this.notePath);
				out.createDiv({ cls: 'dice-tray-modal-total', text: r.total });
				out.createDiv({ cls: 'dice-tray-modal-detail', text: r.detail });
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

/** The dice panel in the sidebar: tap dice into a pool, set a modifier and advantage, roll. Keeps formulas you save,
 *  and this session's rolls, newest first, each a click from rolling again. */
export class DicePanel extends ItemView {
	pool: Pool = emptyPool();
	rolls: { expr: string; text: string; total: string }[] = [];
	private typed = false;
	private input!: HTMLInputElement;
	private out!: HTMLElement;
	private savedEl!: HTMLElement;
	private recentEl!: HTMLElement;
	private dieButtons = new Map<Face, HTMLButtonElement>();
	private edgeButtons = new Map<Edge, HTMLButtonElement>();
	private modEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private plugin: DiceTrayPlugin) {
		super(leaf);
	}
	getViewType() { return PANEL; }
	getDisplayText() { return 'Dice'; }
	getIcon() { return 'dices'; }

	async onOpen() {
		const el = this.contentEl;
		el.empty();
		el.addClass('dice-tray-panel');
		const dice = el.createDiv({ cls: 'dice-tray-panel-dice' });
		for (const f of FACES) {
			const b = dice.createEl('button', { cls: 'dice-tray-panel-die', attr: { 'aria-label': `Add a d${f}; right-click takes one away` } });
			b.onclick = () => this.change(addDie(this.pool, f));
			b.oncontextmenu = (e) => {
				e.preventDefault();
				this.change(addDie(this.pool, f, -1));
			};
			this.dieButtons.set(f, b);
		}
		const row = el.createDiv({ cls: 'dice-tray-panel-row' });
		const minus = row.createEl('button', { text: '−', attr: { 'aria-label': 'Modifier down' } });
		this.modEl = row.createSpan({ cls: 'dice-tray-panel-mod' });
		const plus = row.createEl('button', { text: '+', attr: { 'aria-label': 'Modifier up' } });
		minus.onclick = () => this.change({ ...this.pool, mod: this.pool.mod - 1 });
		plus.onclick = () => this.change({ ...this.pool, mod: this.pool.mod + 1 });
		for (const [edge, label] of [['advantage', 'Adv'], ['disadvantage', 'Dis']] as const) {
			const b = row.createEl('button', { text: label, cls: 'dice-tray-panel-edge', attr: { 'aria-label': edge === 'advantage' ? 'Advantage' : 'Disadvantage' } });
			b.onclick = () => this.change({ ...this.pool, edge: this.pool.edge === edge ? 'none' : edge });
			this.edgeButtons.set(edge, b);
		}
		this.input = el.createEl('input', { type: 'text', cls: 'dice-tray-input', attr: { placeholder: 'Tap dice, or type 2d20kh1 + 5' } });
		this.input.addEventListener('input', () => (this.typed = true));
		this.input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') void this.roll(this.input.value);
		});
		const actions = el.createDiv({ cls: 'dice-tray-panel-row' });
		actions.createEl('button', { text: 'Roll', cls: 'mod-cta' }).onclick = () => void this.roll(this.input.value);
		actions.createEl('button', { text: 'Clear' }).onclick = () => this.clear();
		actions.createEl('button', { text: 'Save', attr: { 'aria-label': 'Keep this formula in the panel' } }).onclick = () => void this.save(this.input.value);
		this.out = el.createDiv({ cls: 'dice-tray-panel-out' });
		el.createEl('h6', { text: 'Saved' });
		this.savedEl = el.createDiv({ cls: 'dice-tray-recent' });
		el.createEl('h6', { text: 'This session' });
		this.recentEl = el.createEl('ol', { cls: 'dice-tray-panel-rolls' });
		this.draw();
	}

	async onClose() {
		this.contentEl.empty();
	}

	change(p: Pool) {
		this.pool = p;
		this.typed = false;
		this.draw();
	}

	clear() {
		this.change(emptyPool());
		this.out.empty();
	}

	async roll(expr: string) {
		expr = expr.trim();
		if (!expr) return;
		try {
			const r = await this.plugin.rollTyped(expr, this.app.workspace.getActiveFile()?.path);
			this.out.empty();
			this.out.createDiv({ cls: 'dice-tray-modal-total', text: r.total });
			this.out.createDiv({ cls: 'dice-tray-modal-detail', text: r.detail });
			this.rolls = [{ expr, text: r.text, total: r.total }, ...this.rolls].slice(0, 50);
			this.drawRolls();
		} catch (e) {
			new Notice(e instanceof DiceError ? e.message : 'Could not roll');
		}
	}

	async save(expr: string) {
		expr = expr.trim();
		if (!expr || this.plugin.settings.saved.includes(expr)) return;
		this.plugin.settings.saved = [...this.plugin.settings.saved, expr];
		await this.plugin.saveSettings();
		this.drawSaved();
	}

	private draw() {
		for (const [f, b] of this.dieButtons) {
			const n = this.pool.dice[f] ?? 0;
			b.setText(n ? `${n}d${f}` : `d${f}`);
			b.toggleClass('is-active', n > 0);
		}
		for (const [edge, b] of this.edgeButtons) b.toggleClass('is-active', this.pool.edge === edge);
		this.modEl.setText(this.pool.mod > 0 ? `+${this.pool.mod}` : String(this.pool.mod));
		if (!this.typed) this.input.value = poolFormula(this.pool);
		this.drawSaved();
		this.drawRolls();
	}

	private drawSaved() {
		this.savedEl.empty();
		for (const expr of this.plugin.settings.saved) {
			const chip = this.savedEl.createSpan({ cls: 'dice-tray-panel-saved' });
			chip.createEl('button', { text: expr }).onclick = () => void this.roll(expr);
			chip.createEl('button', { text: '×', cls: 'dice-tray-panel-forget', attr: { 'aria-label': `Forget ${expr}` } }).onclick = async () => {
				this.plugin.settings.saved = this.plugin.settings.saved.filter((x) => x !== expr);
				await this.plugin.saveSettings();
				this.drawSaved();
			};
		}
		if (!this.plugin.settings.saved.length) this.savedEl.createSpan({ cls: 'dice-tray-panel-empty', text: 'Save a formula to keep it here.' });
	}

	private drawRolls() {
		this.recentEl.empty();
		for (const r of this.rolls) {
			const li = this.recentEl.createEl('li', { attr: { 'aria-label': 'Roll again' } });
			li.createSpan({ cls: 'dice-tray-panel-total', text: r.total });
			li.createSpan({ text: r.text });
			li.onclick = () => void this.roll(r.expr);
		}
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
