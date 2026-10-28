import { describe, expect, it } from 'vitest';
import { isLookupTable, lookupRow, noteFields, parseLines, replaceInSection, parseList, parseNoteRoll, parseTable, pick, tableRows } from '../src/notes';

const TABLE = `
| d6 | Weather | Note |
|---:|:--------|------|
| 1-2 | Rain | wet \\| cold |
| 3 | Fog | |
| 4-6 | Clear | |
`;

describe('parseTable', () => {
	it('reads headers and rows, with escaped pipes', () => {
		const t = parseTable(TABLE)!;
		expect(t.headers).toEqual(['d6', 'Weather', 'Note']);
		expect(t.rows).toHaveLength(3);
		expect(t.rows[0]).toEqual(['1-2', 'Rain', 'wet | cold']);
	});
	it('returns null for non-tables', () => {
		expect(parseTable('just text')).toBeNull();
		expect(parseTable('| a |\n| b |')).toBeNull();
	});
	it('gives rows by column or whole', () => {
		const t = parseTable(TABLE)!;
		expect(tableRows(t, 'weather')).toEqual(['Rain', 'Fog', 'Clear']);
		expect(tableRows(t)[1]).toBe('3 | Fog | ');
		expect(() => tableRows(t, 'Nope')).toThrow();
	});
	it('detects and resolves lookup tables', () => {
		const t = parseTable(TABLE)!;
		expect(isLookupTable(t)).toBe(true);
		expect(lookupRow(t, 2)).toBe('Rain | wet | cold');
		expect(lookupRow(t, 5)).toBe('Clear | ');
		expect(lookupRow(t, 9)).toBeNull();
		expect(isLookupTable(parseTable('| a | b |\n|---|---|\n| x | y |')!)).toBe(false);
	});
});

describe('parseList and parseLines', () => {
	it('flattens list items of any marker', () => {
		expect(parseList('- a\n  - b\n1. c\n2) d\n- [ ] e\n\ntext')).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(parseList('no list')).toBeNull();
	});
	it('keeps content lines only', () => {
		expect(parseLines('# Title\n\nfirst\n---\nsecond\n|---|\n')).toEqual(['first', 'second']);
	});
});

describe('parseNoteRoll', () => {
	it('reads links, counts, blocks, headings and columns', () => {
		expect(parseNoteRoll('[[Encounters]]')).toMatchObject({ count: 1, link: 'Encounters', mode: 'section' });
		expect(parseNoteRoll('3d[[Encounters]]')).toMatchObject({ count: 3 });
		expect(parseNoteRoll('[[Tables/Loot^gems]]|Item')).toMatchObject({ link: 'Tables/Loot', block: 'gems', column: 'Item', mode: 'auto' });
		expect(parseNoteRoll('[[Note#Heading]]|line')).toMatchObject({ heading: 'Heading', mode: 'line' });
		expect(parseNoteRoll('[[Note|alias]]')).toMatchObject({ link: 'Note' });
		expect(parseNoteRoll('3d6')).toBeNull();
	});
});

describe('pick', () => {
	it('uses the rng', () => {
		expect(pick(['a', 'b', 'c'], () => 0.99)).toBe('c');
		expect(() => pick([])).toThrow();
	});
});

describe('noteFields', () => {
	it('reads frontmatter numbers and field lines, field lines winning', () => {
		const text = 'Str:: 16\n- dex:: 3\nThe [prof:: 2] bonus, (ac:: 15).\nname:: Vex\nwis: 4';
		expect(noteFields(text, { level: 5, dex: 1, hp: '22', class: 'rogue' })).toEqual({ level: 5, dex: 3, hp: 22, Str: 16, prof: 2, ac: 15 });
	});
	it('turns spaces in names into underscores', () => {
		expect(noteFields('Armor Class:: 15')).toEqual({ Armor_Class: 15 });
	});
});

describe('replaceInSection', () => {
	const note = 'a `x`\nb `x` `x`\nc `x`';
	it('replaces the nth copy inside the section only', () => {
		expect(replaceInSection(note, 1, 1, '`x`', 1, 'Y')).toBe('a `x`\nb `x` Y\nc `x`');
		expect(replaceInSection(note, 1, 2, '`x`', 2, 'Y')).toBe('a `x`\nb `x` `x`\nc Y');
	});
	it('gives null when that copy is gone', () => {
		expect(replaceInSection(note, 0, 0, '`x`', 1, 'Y')).toBeNull();
	});
});
