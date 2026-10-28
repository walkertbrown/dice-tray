import { describe as suite, expect, it } from 'vitest';
import { isNarrative, narrativeDetail, narrativeText, parseNarrative, rollNarrative } from '../src/narrative';
import { describe, roll, spelledOut, DiceError } from '../src/dice';

// rng that lands on the given 0-based face indexes, for dice of the given sizes
function faces(idx: number[], sizes: number[]) {
	let i = 0;
	return () => { const k = i++; return (idx[k]! + 0.5) / sizes[k]!; };
}

suite('narrative dice', () => {
	it('tells narrative pools from ordinary dice', () => {
		for (const s of ['2g1y2p', 'GGYPP', '3g4d', '2g2d1s', 'bb', '1w']) expect(isNarrative(s)).toBe(true);
		for (const s of ['3d6', 'd20', '4d6r', '8d6sd', '4dF', '1dS', 'd%', '1d20 + dex', 'ddd']) expect(isNarrative(s)).toBe(false);
	});
	it('reads p as difficulty unless a, c or d is used', () => {
		expect(parseNarrative('2g2p')).toEqual(['ability', 'ability', 'difficulty', 'difficulty']);
		expect(parseNarrative('2a1p2d')).toEqual(['ability', 'ability', 'proficiency', 'difficulty', 'difficulty']);
	});
	it('nets successes against failures and advantage against threat', () => {
		// ability "ss", proficiency "T", difficulty "ft", challenge "D"
		const r = rollNarrative('gyrd', faces([3, 11, 11, 7], [8, 12, 12, 8]));
		expect(r.dice.map((d) => d.face)).toEqual(['ss', 'T', 'D', 'ft']);
		expect(r).toMatchObject({ success: 1, advantage: -1, triumph: 1, despair: 1 });
		expect(narrativeText(r)).toBe('1 success, 1 threat, 1 triumph, 1 despair');
		expect(narrativeDetail(r)).toBe('ability: success + success; proficiency: triumph; challenge: despair; difficulty: failure + threat');
	});
	it('gives force dice as light and dark only', () => {
		const r = rollNarrative('2w', faces([6, 9], [12, 12]));
		expect(narrativeText(r)).toBe('2 light, 2 dark');
	});
	it('refuses unknown letters and huge pools', () => {
		expect(() => parseNarrative('2x')).toThrow(DiceError);
		expect(() => parseNarrative('101g')).toThrow(DiceError);
	});
});

suite('stunt dice', () => {
	it('rolls three d6 and gives stunt points on doubles', () => {
		const r = roll('1dS', { rng: faces([2, 2, 4], [6, 6, 6]) });
		expect(r.total).toBe(3 + 3 + 5);
		expect(r.groups[0]!.stuntPoints).toBe(5);
		expect(describe(r)).toBe('1dS [3, 3, 5] (5 stunt points) = 11');
	});
	it('gives none without doubles, and takes one at a time', () => {
		expect(roll('1dS', { rng: faces([0, 1, 2], [6, 6, 6]) }).groups[0]!.stuntPoints).toBeUndefined();
		expect(() => roll('2dS')).toThrow(DiceError);
	});
});

suite('fields from the note', () => {
	it('uses named numbers, any case', () => {
		expect(roll('1d1 + DEX * 2', { vars: { dex: 3 } }).total).toBe(7);
	});
	it('says when a field is missing', () => {
		expect(() => roll('1d20 + dex')).toThrow('No field "dex" in this note');
	});
	it('still reads dice that start with a letter', () => {
		expect(roll('d1 + dF * 0').total).toBe(1);
	});
});

suite('spelledOut', () => {
	it('writes the dice in place of their notation', () => {
		const r = roll('3d100 + 12', { rng: faces([74, 19, 74], [100, 100, 100]) });
		expect(spelledOut(r)).toBe('3d100 + 12 -> [75, 20, 75] + 12 -> 182');
	});
	it('writes fields from the note as their numbers', () => {
		const r = roll('1d20 + DEX', { rng: faces([16], [20]), vars: { dex: 3 } });
		expect(spelledOut(r, { dex: 3 })).toBe('1d20 + DEX -> [17] + 3 -> 20');
	});
	it('skips the middle when there are no dice', () => {
		expect(spelledOut(roll('2 + 3'))).toBe('2 + 3 -> 5');
	});
});
