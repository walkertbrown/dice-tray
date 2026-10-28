import { describe, expect, it } from 'vitest';
import { apply, facing, multiply, solid, SOLID_SIDES, type Mat, type Vec } from '../src/solids';
import { thrownFor } from '../src/tray3d';
import { roll } from '../src/dice';

const close = (a: Vec, b: Vec) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 6));
const T = (m: Mat): Mat => [0, 1, 2].map((i) => [m[0][i], m[1][i], m[2][i]]) as Mat;

describe('the solids', () => {
	const corners: Record<number, number> = { 4: 3, 6: 4, 8: 3, 10: 4, 12: 5, 20: 3 };
	it.each([...SOLID_SIDES])('a d%i has its faces, each flat and turned outward', (n) => {
		const s = solid(n)!;
		expect(s.faces).toHaveLength(n);
		for (const f of s.faces) {
			expect(f.corners).toHaveLength(corners[n]!);
			const d = (v: Vec) => v[0] * f.normal[0] + v[1] * f.normal[1] + v[2] * f.normal[2];
			for (const k of f.corners) expect(d(s.corners[k]!)).toBeCloseTo(d(f.centre), 6);
			expect(d(f.centre)).toBeGreaterThan(0);
		}
		expect(Math.max(...s.corners.map((c) => Math.hypot(...c)))).toBeCloseTo(1, 9);
	});

	it('has no solid for a d3 or a d7', () => {
		expect(solid(3)).toBeNull();
		expect(solid(7)).toBeNull();
	});

	it.each([...SOLID_SIDES])('turns each face of a d%i to the front, number upright', (n) => {
		const s = solid(n)!;
		s.faces.forEach((f, i) => {
			const m = facing(s, i);
			close(apply(m, f.normal), [0, 0, 1]);
			close(apply(m, f.up), [0, -1, 0]);
			const id = multiply(m, T(m));
			close(id[0], [1, 0, 0]);
			close(id[1], [0, 1, 0]);
			close(id[2], [0, 0, 1]);
		});
	});

	it('keeps the face in front when twisted', () => {
		const s = solid(20)!;
		close(apply(facing(s, 13, 0.3), s.faces[13]!.normal), [0, 0, 1]);
	});
});

describe('the dice thrown for a roll', () => {
	const fixed = (values: number[]) => {
		let i = 0;
		return () => (values[i++ % values.length]! - 0.5) / 100;
	};

	it('throws a die per die, landing on what was rolled', () => {
		const r = roll('2d20kh1+1d6');
		const t = thrownFor(r);
		expect(t.map((x) => x.sides)).toEqual([20, 20, 6]);
		expect(t.map((x) => x.face + 1)).toEqual(r.groups.flatMap((g) => g.dice.map((d) => d.value)));
		expect(t.filter((x) => !x.kept)).toHaveLength(1);
	});

	it('throws d100 as two d10s, tens and ones', () => {
		const r = roll('1d100', { rng: fixed([73]) });
		const v = r.groups[0]!.dice[0]!.value;
		const [tens, ones] = thrownFor(r);
		expect(tens!.label![tens!.face]).toBe(`${Math.floor((v % 100) / 10)}0`);
		expect(ones!.label![ones!.face]).toBe(String(v % 10));
	});

	it('throws Fate dice as d6s marked − and +', () => {
		const t = thrownFor(roll('4dF'));
		expect(t).toHaveLength(4);
		const r = roll('4dF');
		const t2 = thrownFor(r);
		t2.forEach((x, i) => {
			expect(x.sides).toBe(6);
			expect(x.label![x.face]).toBe(['−', ' ', '+'][r.groups[0]!.dice[i]!.value + 1]);
		});
	});

	it('throws nothing for dice without a solid, or for a fistful', () => {
		expect(thrownFor(roll('2d3'))).toEqual([]);
		expect(thrownFor(roll('30d6'))).toEqual([]);
	});
});
