// The dice panel's pool: dice tapped in, a modifier, advantage or disadvantage, written out as a formula the roller
// reads. No Obsidian here, so it is easy to test.

export type Face = 4 | 6 | 8 | 10 | 12 | 20 | 100 | 'F';
export const FACES: Face[] = [4, 6, 8, 10, 12, 20, 100, 'F'];
export type Edge = 'none' | 'advantage' | 'disadvantage';

export interface Pool {
	dice: Partial<Record<Face, number>>;
	mod: number;
	edge: Edge;
}

export const emptyPool = (): Pool => ({ dice: {}, mod: 0, edge: 'none' });

export function addDie(p: Pool, f: Face, by = 1): Pool {
	const n = Math.max(0, Math.min(99, (p.dice[f] ?? 0) + by));
	const dice = { ...p.dice };
	if (n) dice[f] = n;
	else delete dice[f];
	return { ...p, dice };
}

/** "2d6 + 1d20 + 3". Advantage rolls a second d20 and keeps the higher (2d20kh1), so it works on a pool with one d20
 *  or none; with more than one d20 it is left out, since 5E has no rule for that. */
export function poolFormula(p: Pool): string {
	const parts: string[] = [];
	const d20 = p.dice[20] ?? 0;
	for (const f of FACES) {
		const n = p.dice[f] ?? 0;
		if (f === 20 && p.edge !== 'none' && d20 <= 1) parts.push(p.edge === 'advantage' ? '2d20kh1' : '2d20kl1');
		else if (n) parts.push(`${n}d${f}`);
	}
	let s = parts.join(' + ');
	if (p.mod) s = s ? `${s} ${p.mod < 0 ? '-' : '+'} ${Math.abs(p.mod)}` : String(p.mod);
	return s;
}
