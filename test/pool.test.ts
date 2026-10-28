import { describe, expect, it } from 'vitest';
import { addDie, emptyPool, poolFormula } from '../src/pool';

describe('the dice panel pool', () => {
	it('writes the dice out in order, with the modifier', () => {
		let p = emptyPool();
		p = addDie(addDie(addDie(p, 20), 6), 6);
		expect(poolFormula(p)).toBe('2d6 + 1d20');
		expect(poolFormula({ ...p, mod: 3 })).toBe('2d6 + 1d20 + 3');
		expect(poolFormula({ ...p, mod: -2 })).toBe('2d6 + 1d20 - 2');
		expect(poolFormula(addDie(p, 'F', 4))).toBe('2d6 + 1d20 + 4dF');
	});
	it('takes a die back out, and never goes below none', () => {
		const p = addDie(addDie(emptyPool(), 8), 8, -1);
		expect(p.dice).toEqual({});
		expect(addDie(p, 8, -1).dice).toEqual({});
		expect(poolFormula(p)).toBe('');
		expect(poolFormula({ ...p, mod: 5 })).toBe('5');
	});
	it('rolls advantage and disadvantage as two d20s, keeping one', () => {
		expect(poolFormula({ ...emptyPool(), edge: 'advantage', mod: 5 })).toBe('2d20kh1 + 5');
		expect(poolFormula({ ...addDie(emptyPool(), 20), edge: 'disadvantage' })).toBe('2d20kl1');
		expect(poolFormula({ ...addDie(emptyPool(), 20, 2), edge: 'advantage' })).toBe('2d20');
	});
});
