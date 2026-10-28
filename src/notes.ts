// Rolling on things inside notes: table rows, list items, lines. Pure
// functions over markdown text so they are unit-testable; main.ts fetches the
// text from the vault.

export interface TableData {
	headers: string[];
	rows: string[][];
}

// Parse a markdown pipe table. Returns null when the text is not a table.
export function parseTable(md: string): TableData | null {
	const lines = md
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.startsWith('|'));
	if (lines.length < 2) return null;
	const cells = (l: string) =>
		l
			.replace(/^\|/, '')
			.replace(/\|$/, '')
			.split(/(?<!\\)\|/)
			.map((c) => c.replace(/\\\|/g, '|').trim());
	const headers = cells(lines[0]!);
	if (!/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(lines[1]!)) return null;
	const rows = lines.slice(2).map(cells).filter((r) => r.some((c) => c));
	return { headers, rows };
}

// Items of a markdown list (any nesting flattened); null if there are none.
export function parseList(md: string): string[] | null {
	const items: string[] = [];
	for (const line of md.split('\n')) {
		const m = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?(.*\S)\s*$/.exec(line);
		if (m) items.push(m[1]!);
	}
	return items.length ? items : null;
}

// Non-empty lines, headings and table rules removed.
export function parseLines(md: string): string[] {
	return md
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l && !/^#{1,6}\s/.test(l) && !/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(l) && !/^---+$/.test(l));
}

// Rows of a table as text: one column by header (case-insensitive) or the
// whole row joined with " | ".
export function tableRows(t: TableData, header?: string): string[] {
	if (header) {
		const i = t.headers.findIndex((h) => h.toLowerCase() === header.toLowerCase());
		if (i < 0) throw new Error(`No column "${header}"`);
		return t.rows.map((r) => r[i] ?? '').filter((c) => c);
	}
	return t.rows.map((r) => r.join(' | '));
}

// A table whose first column is a dice range ("1-3", "4", "5-6") is a lookup
// table: roll the dice named in its header, then pick the matching row.
export function lookupRow(t: TableData, roll: number): string | null {
	for (const r of t.rows) {
		const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(r[0] ?? '');
		if (!m) return null;
		const lo = Number(m[1]);
		const hi = m[2] ? Number(m[2]) : lo;
		if (roll >= lo && roll <= hi) return r.slice(1).join(' | ');
	}
	return null;
}

export function isLookupTable(t: TableData): boolean {
	return t.rows.length > 0 && t.rows.every((r) => /^\s*\d+\s*(?:[-–]\s*\d+)?\s*$/.test(r[0] ?? ''));
}

export function pick<T>(items: T[], rng: () => number = Math.random): T {
	if (!items.length) throw new Error('Nothing to pick from');
	return items[Math.floor(rng() * items.length)]!;
}

// The parts of a note roll:  3d[[Note^block]]|Header
export interface NoteRoll {
	count: number;
	link: string; // "Note" or "Folder/Note"
	block?: string; // after ^
	heading?: string; // after #
	column?: string; // |Header
	mode: 'section' | 'line' | 'table' | 'list' | 'auto';
}

export function parseNoteRoll(src: string): NoteRoll | null {
	const m = /^(?:(\d+)d)?\s*\[\[([^\]|#^]+)(?:#([^\]|^]+))?(?:\^([^\]|]+))?(?:\|[^\]]*)?\]\]\s*(.*)$/s.exec(src.trim());
	if (!m) return null;
	const flags = (m[5] ?? '')
		.split('|')
		.map((s) => s.trim())
		.filter(Boolean);
	const r: NoteRoll = {
		count: m[1] ? Number(m[1]) : 1,
		link: m[2]!.trim(),
		block: m[4]?.trim(),
		heading: m[3]?.trim(),
		mode: m[4] ? 'auto' : 'section',
	};
	for (const f of flags) {
		const lf = f.toLowerCase();
		if (lf === 'line') r.mode = 'line';
		else if (lf === 'table') r.mode = 'table';
		else if (lf === 'list') r.mode = 'list';
		else if (lf === 'paragraph' || lf === 'section') r.mode = 'section';
		else if (!['render', 'norender', 'nodice', 'noform', 'form'].includes(lf)) r.column = f;
	}
	return r;
}

// Numbers a note names, for formulas like `1d20 + dex`: frontmatter values first, then
// Dataview-style `field:: 3` lines and `[field:: 3]` inline, which win. Names keep only
// letters, digits and underscores, so "Armor Class:: 15" is `Armor_Class`.
export function noteFields(text: string, frontmatter?: Record<string, unknown>): Record<string, number> {
	const out: Record<string, number> = {};
	const put = (k: string, v: unknown) => {
		const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
		const name = k.trim().replace(/\W+/g, '_');
		if (Number.isFinite(n) && /^[A-Za-z_]/.test(name)) out[name] = n;
	};
	for (const [k, v] of Object.entries(frontmatter ?? {})) put(k, v);
	for (const m of text.matchAll(/^[ \t]*(?:[-*+][ \t]+)?([A-Za-z_][\w ]*?)::[ \t]*(-?\d+(?:\.\d+)?)[ \t]*$/gm)) put(m[1]!, m[2]);
	for (const m of text.matchAll(/[[(]([A-Za-z_][\w ]*?)::[ \t]*(-?\d+(?:\.\d+)?)[ \t]*[\])]/g)) put(m[1]!, m[2]);
	return out;
}
