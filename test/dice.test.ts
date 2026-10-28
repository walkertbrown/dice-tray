import { describe as suite, expect, it } from 'vitest';
import { average, describe, roll, tokenize, DiceError } from '../src/dice';

// deterministic rng: hands out the given die values in order (1-based faces)
function seq(values: number[], faces = 6) {
	let i = 0;
	return () => {
		const v = values[i++ % values.length] ?? 1;
		return (v - 1) / faces;
	};
}

suite('tokenize', () => {
	it('splits numbers, dice and operators', () => {
		const t = tokenize('3d6 + 2 * (1d4-1)');
		expect(t.map((x) => x.t)).toEqual(['dice', 'op', 'num', 'op', '(', 'dice', 'op', 'num', ')']);
	});
	it('rejects junk', () => {
		expect(() => tokenize('3d6 & 2')).toThrow(DiceError);
	});
});

suite('roll', () => {
	it('adds dice and modifiers', () => {
		const r = roll('3d6 + 2', { rng: seq([4, 2, 5]) });
		expect(r.total).toBe(13);
		expect(describe(r)).toBe('3d6 [4, 2, 5] = 13');
	});
	it('does arithmetic with precedence and parens', () => {
		expect(roll('2 + 3 * 4').total).toBe(14);
		expect(roll('(2 + 3) * 4').total).toBe(20);
		expect(roll('2 ^ 3 ^ 2').total).toBe(512);
		expect(roll('-1d6 + 10', { rng: seq([3]) }).total).toBe(7);
	});
	it('rolls a bare d20 and d%', () => {
		expect(roll('d20', { rng: seq([17], 20) }).total).toBe(17);
		expect(roll('d%', { rng: seq([63], 100) }).total).toBe(63);
	});
	it('uses the default faces for a lone d', () => {
		expect(roll('2d', { rng: seq([5, 5], 8), defaultFaces: 8 }).total).toBe(10);
	});
	it('keeps highest and lowest', () => {
		expect(roll('2d20kh1', { rng: seq([5, 17], 20) }).total).toBe(17);
		expect(roll('2d20kl1', { rng: seq([5, 17], 20) }).total).toBe(5);
		expect(roll('2d20k', { rng: seq([5, 17], 20) }).total).toBe(17);
		const r = roll('4d6kh3', { rng: seq([1, 6, 4, 3]) });
		expect(r.total).toBe(13);
		expect(r.groups[0]!.dice.filter((d) => !d.kept).map((d) => d.value)).toEqual([1]);
	});
	it('drops lowest and highest', () => {
		expect(roll('4d6dl1', { rng: seq([1, 6, 4, 3]) }).total).toBe(13);
		expect(roll('4d6dh1', { rng: seq([1, 6, 4, 3]) }).total).toBe(8);
		expect(roll('4d6d1', { rng: seq([1, 6, 4, 3]) }).total).toBe(13);
	});
	it('explodes once, n times and compound', () => {
		expect(roll('1d6!', { rng: seq([6, 6, 2]) }).total).toBe(12); // one extra die only
		expect(roll('1d6!2', { rng: seq([6, 6, 2]) }).total).toBe(14);
		expect(roll('1d6!i', { rng: seq([6, 6, 6, 1]) }).total).toBe(19);
		const c = roll('1d6!!', { rng: seq([6, 3]) });
		expect(c.total).toBe(9);
		expect(c.groups[0]!.dice).toHaveLength(1);
	});
	it('explodes on a condition', () => {
		expect(roll('1d6!>4', { rng: seq([5, 2]) }).total).toBe(7);
		expect(roll('1d6!>4', { rng: seq([4, 2]) }).total).toBe(4);
	});
	it('rerolls ones once, n times, forever, or on a condition', () => {
		const r = roll('1d6r', { rng: seq([1, 1, 4]) });
		expect(r.total).toBe(1);
		expect(r.groups[0]!.dice.map((d) => d.value)).toEqual([1, 1]);
		expect(roll('1d6ri', { rng: seq([1, 1, 4]) }).total).toBe(4);
		expect(roll('1d6r<3', { rng: seq([2, 5]) }).total).toBe(5);
		expect(roll('4d6r', { rng: seq([1, 3, 4, 5, 6]) }).total).toBe(18);
	});
	it('counts successes', () => {
		const r = roll('5d10>=8', { rng: seq([8, 2, 10, 7, 9], 10) });
		expect(r.total).toBe(3);
		expect(r.groups[0]!.successes).toBe(3);
		expect(roll('3d6=6', { rng: seq([6, 6, 1]) }).total).toBe(2);
		expect(roll('3d6=!6', { rng: seq([6, 6, 1]) }).total).toBe(1);
	});
	it('rolls fudge dice', () => {
		const r = roll('4dF', { rng: seq([1, 2, 3, 3], 3) });
		expect(r.groups[0]!.dice.map((d) => d.value)).toEqual([-1, 0, 1, 1]);
		expect(r.total).toBe(1);
	});
	it('rolls d66%', () => {
		expect(roll('1d66%', { rng: seq([3, 5]) }).total).toBe(35);
	});
	it('rolls a min,max range', () => {
		const r = roll('3d[2,5]', { rng: seq([1, 4, 2], 4) });
		expect(r.groups[0]!.dice.map((d) => d.value)).toEqual([2, 5, 3]);
	});
	it('sorts and makes unique', () => {
		expect(roll('3d6s', { rng: seq([5, 1, 3]) }).groups[0]!.dice.map((d) => d.value)).toEqual([1, 3, 5]);
		expect(roll('3d6sd', { rng: seq([5, 1, 3]) }).groups[0]!.dice.map((d) => d.value)).toEqual([5, 3, 1]);
		expect(roll('3d6u', { rng: seq([2, 2, 2, 4, 6]) }).groups[0]!.dice.map((d) => d.value)).toEqual([2, 4, 6]);
	});
	it('stays within the faces over many random rolls', () => {
		for (let i = 0; i < 500; i++) {
			const r = roll('1d6');
			expect(r.total).toBeGreaterThanOrEqual(1);
			expect(r.total).toBeLessThanOrEqual(6);
		}
	});
	it('rejects nonsense', () => {
		expect(() => roll('')).toThrow(DiceError);
		expect(() => roll('1d0')).toThrow(DiceError);
		expect(() => roll('(1d6')).toThrow(DiceError);
		expect(() => roll('1d6 +')).toThrow(DiceError);
		expect(() => roll('5000d6')).toThrow(DiceError);
		expect(() => roll('1 / 0')).toThrow(DiceError);
	});
});

suite('average', () => {
	it('averages dice groups', () => {
		expect(average('3d6 + 2')).toBe(12.5);
		expect(average('2d20kh1')).toBe(10.5);
		expect(average('4dF')).toBe(0);
		expect(average('1d66%')).toBe(38.5);
	});
});
