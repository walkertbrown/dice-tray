// A tiny stand-in for the `obsidian` module so main.ts can run under jsdom.
// Only what Dice Tray touches is here.

type Opts = { cls?: string; text?: string; type?: string; placeholder?: string };

function make(this: HTMLElement | void, tag: string, o?: Opts): HTMLElement {
	const el = document.createElement(tag);
	if (o?.cls) el.className = o.cls;
	if (o?.text) el.textContent = o.text;
	if (o?.type) el.setAttribute('type', o.type);
	if (o?.placeholder) el.setAttribute('placeholder', o.placeholder);
	if (this && this !== (globalThis as unknown)) (this as HTMLElement).appendChild(el);
	return el;
}

export function installDomHelpers() {
	const P = HTMLElement.prototype as unknown as Record<string, unknown>;
	P.createSpan = function (this: HTMLElement, o?: Opts) { return make.call(this, 'span', o); };
	P.createDiv = function (this: HTMLElement, o?: Opts) { return make.call(this, 'div', o); };
	P.createEl = function (this: HTMLElement, tag: string, o?: Opts) { return make.call(this, tag, o); };
	P.setText = function (t: string) { (this as HTMLElement).textContent = t; };
	P.empty = function () { (this as HTMLElement).replaceChildren(); };
	P.addClass = function (...c: string[]) { (this as HTMLElement).classList.add(...c); };
	P.removeClass = function (...c: string[]) { (this as HTMLElement).classList.remove(...c); };
	P.hide = function () { (this as HTMLElement).style.display = 'none'; };
	P.show = function () { (this as HTMLElement).style.display = ''; };
	P.setAttr = function (k: string, v: string) { (this as HTMLElement).setAttribute(k, v); };
	(globalThis as unknown as Record<string, unknown>).createSpan = (o?: Opts) => make.call(undefined, 'span', o);
	(globalThis as unknown as Record<string, unknown>).createDiv = (o?: Opts) => make.call(undefined, 'div', o);
}

export class TFile {
	constructor(public path: string, public basename = path.replace(/\.md$/, '')) {}
}

export interface FakeNote { path: string; content: string }

// offsets for headings, blocks and sections, the way Obsidian's cache gives them
function cacheFor(content: string) {
	const headings: unknown[] = [];
	const blocks: Record<string, unknown> = {};
	const sections: unknown[] = [];
	const lines = content.split('\n');
	let off = 0;
	let secStart = -1;
	let secType = 'paragraph';
	const pos = (s: number, e: number) => ({ start: { offset: s, line: 0, col: 0 }, end: { offset: e, line: 0, col: 0 } });
	const closeSec = (end: number) => {
		if (secStart >= 0) sections.push({ type: secType, position: pos(secStart, end) });
		secStart = -1;
	};
	lines.forEach((line, i) => {
		const h = /^(#+)\s+(.*)$/.exec(line);
		if (h) {
			closeSec(off - 1);
			headings.push({ heading: h[2], level: h[1]!.length, position: pos(off, off + line.length) });
			sections.push({ type: 'heading', position: pos(off, off + line.length) });
		} else if (!line.trim()) {
			closeSec(off - 1);
		} else if (/^\^[\w-]+$/.test(line.trim())) {
			// block id on its own line applies to the section above
			const id = line.trim().slice(1);
			const last = sections[sections.length - 1] as { position: { start: { offset: number } } } | undefined;
			const start = secStart >= 0 ? secStart : last?.position.start.offset ?? 0;
			closeSec(off - 1);
			blocks[id] = { id, position: pos(start, off - 1) };
		} else {
			if (secStart < 0) {
				secStart = off;
				secType = line.startsWith('|') ? 'table' : /^\s*[-*+]\s/.test(line) ? 'list' : 'paragraph';
			}
		}
		off += line.length + (i < lines.length - 1 ? 1 : 0);
	});
	closeSec(content.length);
	return { headings, blocks, sections };
}

export class App {
	notes = new Map<string, FakeNote>();
	metadataCache = {
		getFirstLinkpathDest: (link: string): TFile | null => {
			const n = this.notes.get(link) ?? this.notes.get(link + '.md');
			return n ? new TFile(n.path) : null;
		},
		getFileCache: (f: TFile) => {
			const n = this.notes.get(f.path) ?? this.notes.get(f.basename);
			return n ? cacheFor(n.content) : null;
		},
	};
	vault = {
		cachedRead: async (f: TFile) => (this.notes.get(f.path) ?? this.notes.get(f.basename))!.content,
	};
}

export class Component {
	load() {}
	unload() {}
}
export class MarkdownRenderChild extends Component {
	constructor(public containerEl: HTMLElement) { super(); }
}

export class Plugin extends Component {
	postProcessors: ((el: HTMLElement, ctx: Ctx) => void)[] = [];
	codeBlocks: Record<string, (src: string, el: HTMLElement, ctx: Ctx) => void> = {};
	commands: { id: string; name: string; callback: () => void }[] = [];
	settingTab: unknown;
	data: unknown = null;
	constructor(public app: App, public manifest: unknown) { super(); }
	registerMarkdownPostProcessor(fn: (el: HTMLElement, ctx: Ctx) => void) { this.postProcessors.push(fn); }
	registerMarkdownCodeBlockProcessor(lang: string, fn: (src: string, el: HTMLElement, ctx: Ctx) => void) { this.codeBlocks[lang] = fn; }
	addCommand(c: { id: string; name: string; callback: () => void }) { this.commands.push(c); }
	addSettingTab(t: unknown) { this.settingTab = t; }
	async loadData() { return this.data; }
	async saveData(d: unknown) { this.data = d; }
}

export interface Ctx { sourcePath: string; addChild: (c: Component) => void }
export function ctx(sourcePath = 'Game.md'): Ctx {
	return { sourcePath, addChild: () => {} };
}

export class Modal {
	contentEl = document.createElement('div');
	titleEl = document.createElement('div');
	constructor(public app: App) {}
	open() { this.onOpen(); }
	close() { this.onClose(); }
	onOpen() {}
	onClose() {}
	setTitle(t: string) { this.titleEl.textContent = t; }
}

export class PluginSettingTab {
	containerEl = document.createElement('div');
	constructor(public app: App, public plugin: Plugin) {}
}

export class Notice {
	static last = '';
	constructor(msg: string) { Notice.last = msg; }
}

export const MarkdownRenderer = {
	render: async (_app: App, md: string, el: HTMLElement) => {
		el.textContent = md;
	},
};

export function setIcon(el: HTMLElement, name: string) {
	el.setAttribute('data-icon', name);
}
