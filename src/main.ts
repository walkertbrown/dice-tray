import { App, MarkdownPostProcessorContext, Modal, Notice, Plugin, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { average, describe, DiceError, formatNumber, roll, RollResult } from './dice';

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
}

function parseBlock(src: string): Parsed | null {
	const m = /^dice(?:\+|-|-mod)?:\s*(.+)$/is.exec(src.trim());
	if (!m) return null;
	const parts = (m[1] as string).split('|').map((s) => s.trim());
	const expression = parts.shift() ?? '';
	const flags = new Set<string>();
	let text: string | undefined;
	for (const p of parts) {
		const t = /^text\((.*)\)$/s.exec(p);
		if (t) text = t[1];
		else flags.add(p.toLowerCase());
	}
	return { expression, flags, text };
}

export default class DiceTrayPlugin extends Plugin {
	settings: DiceTraySettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();
		this.registerMarkdownPostProcessor((el, ctx) => this.processInline(el, ctx));
		this.registerMarkdownCodeBlockProcessor('dice', (source, el) => {
			// ```dice
			// 3d6 + 2
			// ```  -> one roll per non-empty line
			for (const line of source.split('\n')) {
				if (!line.trim()) continue;
				const p = parseBlock(line.startsWith('dice') ? line : `dice: ${line}`);
				if (p) el.appendChild(this.renderRoll(p));
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

	doRoll(expression: string): RollResult {
		const r = roll(expression, { defaultFaces: this.settings.defaultFaces });
		r.total = this.round(r.total);
		return r;
	}

	private processInline(el: HTMLElement, _ctx: MarkdownPostProcessorContext) {
		const codes = el.querySelectorAll('code');
		for (const code of Array.from(codes)) {
			if (code.closest('pre')) continue;
			const p = parseBlock(code.textContent ?? '');
			if (!p) continue;
			code.replaceWith(this.renderRoll(p));
		}
	}

	renderRoll(p: Parsed): HTMLElement {
		const chip = createSpan({ cls: 'dice-tray' });
		if (p.flags.has('avg')) {
			try {
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
				total.setText(formatNumber(r.total));
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

		const go = () => {
			let r: RollResult;
			try {
				r = this.doRoll(p.expression);
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
			go();
		});
		go();
		return chip;
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
			}
			if (g.successes !== undefined) {
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
		const msg = e instanceof DiceError ? e.message : 'Could not roll';
		chip.setText(msg);
		chip.title = msg;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class RollModal extends Modal {
	constructor(app: App, private plugin: DiceTrayPlugin) {
		super(app);
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('dice-tray-modal');
		contentEl.createEl('h3', { text: 'Roll dice' });
		const input = contentEl.createEl('input', { type: 'text', placeholder: '2d20kh1 + 5' });
		input.addClass('dice-tray-input');
		const out = contentEl.createDiv({ cls: 'dice-tray-modal-out' });
		const recent = contentEl.createDiv({ cls: 'dice-tray-recent' });
		const showRecent = () => {
			recent.empty();
			for (const h of this.plugin.settings.history) {
				const b = recent.createEl('button', { text: h });
				b.onclick = () => { input.value = h; go(); };
			}
		};
		const go = async () => {
			const expr = input.value.trim();
			if (!expr) return;
			try {
				const r = this.plugin.doRoll(expr);
				out.empty();
				out.createDiv({ cls: 'dice-tray-modal-total', text: formatNumber(r.total) });
				out.createDiv({ cls: 'dice-tray-modal-detail', text: describe(r) });
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
	display() {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName('Default die')
			.setDesc('Faces used when a roll says "d" with no number, like "3d".')
			.addText((t) =>
				t.setValue(String(this.plugin.settings.defaultFaces)).onChange(async (v) => {
					const n = Number(v);
					if (Number.isInteger(n) && n > 0) {
						this.plugin.settings.defaultFaces = n;
						await this.plugin.saveSettings();
					}
				}),
			);
		new Setting(containerEl)
			.setName('Show the formula')
			.setDesc('Show the dice notation next to each result.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showFormula).onChange(async (v) => {
					this.plugin.settings.showFormula = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName('Animate rolls')
			.setDesc('Tumble the number briefly when a roll happens.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.animate).onChange(async (v) => {
					this.plugin.settings.animate = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName('Round results')
			.setDesc('How to round results that are not whole numbers.')
			.addDropdown((d) =>
				d
					.addOptions({ none: 'Do not round', nearest: 'Nearest', up: 'Up', down: 'Down' })
					.setValue(this.plugin.settings.rounding)
					.onChange(async (v) => {
						this.plugin.settings.rounding = v as DiceTraySettings['rounding'];
						await this.plugin.saveSettings();
					}),
			);
	}
}
