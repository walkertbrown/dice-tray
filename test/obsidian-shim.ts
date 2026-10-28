// A tiny stand-in for the `obsidian` module so main.ts can run under jsdom.
// Only what Dice Tray touches is here.
import { StateField, type Extension } from '@codemirror/state';

type Opts = { cls?: string; text?: string; type?: string; placeholder?: string; attr?: Record<string, string> };

function make(this: HTMLElement | void, tag: string, o?: Opts): HTMLElement {
	const el = document.createElement(tag);
	if (o?.cls) el.className = o.cls;
	if (o?.text) el.textContent = o.text;
	if (o?.type) el.setAttribute('type', o.type);
	if (o?.placeholder) el.setAttribute('placeholder', o.placeholder);
	for (const [k, v] of Object.entries(o?.attr ?? {})) el.setAttribute(k, v);
	if (this && this !== (globalThis as unknown)) (this as HTMLElement).appendChild(el);
	return el;
}

export function installDomHelpers() {
	const P = HTMLElement.prototype as unknown as Record<string, unknown>;
	P.createSpan = function (this: HTMLElement, o?: Opts) { return make.call(this, 'span', o); };
	P.createDiv = function (this: HTMLElement, o?: Opts) { return make.call(this, 'div', o); };
	P.createEl = function (this: HTMLElement, tag: string, o?: Opts) { return make.call(this, tag, o); };
	P.toggleClass = function (this: HTMLElement, c: string, on: boolean) { this.classList.toggle(c, on); };
	P.setText = function (this: HTMLElement, t: string) { this.textContent = t; };
	P.empty = function (this: HTMLElement) { this.replaceChildren(); };
	P.addClass = function (this: HTMLElement, ...c: string[]) { this.classList.add(...c); };
	P.removeClass = function (this: HTMLElement, ...c: string[]) { this.classList.remove(...c); };
	P.hide = function (this: HTMLElement) { this.style.display = 'none'; };
	P.show = function (this: HTMLElement) { this.style.display = ''; };
	P.setCssProps = function (this: HTMLElement, props: Record<string, string>) { for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v); };
	Object.defineProperty(P, 'doc', { get(this: HTMLElement) { return this.ownerDocument; }, configurable: true });
	P.setAttr = function (this: HTMLElement, k: string, v: string) { this.setAttribute(k, v); };
	(globalThis as unknown as Record<string, unknown>).createSpan = (o?: Opts) => make.call(undefined, 'span', o);
	(globalThis as unknown as Record<string, unknown>).createDiv = (o?: Opts) => make.call(undefined, 'div', o);
	Object.defineProperty(globalThis, 'activeDocument', { get: () => document, configurable: true });
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
	// frontmatter is its own `yaml` section, as in Obsidian
	const fmLines = /^---\n[\s\S]*?\n---(\n|$)/.exec(content)?.[0].replace(/\n$/, '').split('\n').length ?? 0;
	let frontmatterPosition: ReturnType<typeof pos> | undefined;
	lines.forEach((line, i) => {
		if (i < fmLines) {
			if (i === fmLines - 1) {
				frontmatterPosition = pos(0, off + line.length);
				sections.push({ type: 'yaml', position: frontmatterPosition });
			}
			off += line.length + 1;
			return;
		}
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
	// flat `key: value` frontmatter, numbers as numbers
	let frontmatter: Record<string, unknown> | undefined;
	const fm = /^---\n([\s\S]*?)\n---/.exec(content);
	if (fm) {
		frontmatter = {};
		for (const m of fm[1]!.matchAll(/^(\w[\w ]*):\s*(.*)$/gm)) frontmatter[m[1]!] = /^-?\d+(\.\d+)?$/.test(m[2]!) ? Number(m[2]) : m[2];
	}
	// #tags in the text (not headings), as Obsidian lists them
	const tags = [...content.replace(/^---\n[\s\S]*?\n---/, '').matchAll(/(?:^|\s)(#[A-Za-z][\w/-]*)/g)].map((m) => ({ tag: m[1]! }));
	return { headings, blocks, sections, frontmatter, frontmatterPosition, tags };
}

// Body tags and frontmatter `tags: [a, b]` (or `a, b`), each with its #.
export function getAllTags(cache: { tags?: { tag: string }[]; frontmatter?: Record<string, unknown> }): string[] {
	const fm = String(cache.frontmatter?.tags ?? '').split(/[\s,[\]]+/).filter(Boolean).map((t) => '#' + t.replace(/^#/, ''));
	return [...(cache.tags ?? []).map((t) => t.tag), ...fm];
}

export class App {
	notes = new Map<string, FakeNote>();
	events: { name: string; data: unknown }[] = [];
	workspace = {
		getActiveFile: (): TFile | null => null,
		trigger: (name: string, data: unknown) => { this.events.push({ name, data }); },
	};
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
	fileManager = {
		generateMarkdownLink: (f: TFile) => `[[${f.basename.split('/').pop()}]]`,
	};
	vault = {
		getMarkdownFiles: (): TFile[] => [...this.notes.values()].filter((n) => n.path.endsWith('.md')).map((n) => new TFile(n.path)),
		cachedRead: async (f: TFile) => (this.notes.get(f.path) ?? this.notes.get(f.basename))!.content,
		getFileByPath: (p: string): TFile | null => (this.notes.has(p) ? new TFile(p) : null),
		process: async (f: TFile, fn: (data: string) => string) => {
			const n = (this.notes.get(f.path) ?? this.notes.get(f.basename))!;
			n.content = fn(n.content);
			return n.content;
		},
	};
}

export class Component {
	children: Component[] = [];
	load() {}
	unload() {}
	addChild<T extends Component>(c: T): T { this.children.push(c); return c; }
}

// The editor's own fields: in Obsidian, whether it is in Live Preview, and the note it shows.
export const editorLivePreviewField = StateField.define<boolean>({ create: () => true, update: (v) => v });
export const editorInfoField = StateField.define<{ file: TFile | null }>({ create: () => ({ file: null }), update: (v) => v });
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
	views: Record<string, (leaf: WorkspaceLeaf) => unknown> = {};
	registerView(type: string, fn: (leaf: WorkspaceLeaf) => unknown) { this.views[type] = fn; }
	ribbon: { icon: string; title: string; fn: () => void }[] = [];
	addRibbonIcon(icon: string, title: string, fn: () => void) { this.ribbon.push({ icon, title, fn }); return document.createElement('div'); }
	addSettingTab(t: unknown) { this.settingTab = t; }
	editorExtensions: Extension[] = [];
	registerEditorExtension(e: Extension) { this.editorExtensions.push(e); }
	async loadData() { return this.data; }
	async saveData(d: unknown) { this.data = d; }
}

export interface Section { text: string; lineStart: number; lineEnd: number }
export interface Ctx { sourcePath: string; addChild: (c: Component) => void; getSectionInfo: (el: HTMLElement) => Section | null }
export function ctx(sourcePath = 'Game.md', section: Section | null = null): Ctx {
	return { sourcePath, addChild: () => {}, getSectionInfo: () => section };
}

export class WorkspaceLeaf {
	view: unknown = null;
	constructor(public app: App) {}
}
export class ItemView {
	app: App;
	contentEl = document.createElement('div');
	constructor(public leaf: WorkspaceLeaf) { this.app = leaf.app; }
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
