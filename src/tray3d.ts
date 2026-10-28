// Dice that tumble across the window and land on what was rolled, drawn on a canvas in code. A sheet over the
// window that clicks pass through; it goes once the dice have lain still a moment.
import { apply, facing, multiply, norm, solid, turn, type Mat, type Solid, type Vec } from './solids';
import type { RollResult } from './dice';

export interface Thrown {
	sides: number; // the solid: 4, 6, 8, 10, 12 or 20
	face: number; // which face lands up, from 0
	label?: string[]; // what each face says, when not 1 to sides
	kept: boolean;
}

const MAX_THROWN = 20;
const FLIGHT = 900;
const STILL = 1400;
const FADE = 300;
const FATE = ['−', '+', ' ', ' ', '−', '+']; // as a d6: − opposite +, blank opposite blank

/** The dice of a roll that can be thrown: the solids, d100 as two d10s, Fate dice as d6s. Rerolled dice stay home. */
export function thrownFor(r: RollResult): Thrown[] {
	const out: Thrown[] = [];
	for (const g of r.groups) {
		for (const d of g.dice) {
			if (d.rerolled) continue;
			const n = Number(g.faces);
			if (solid(n) && Number.isInteger(d.value) && d.value >= 1 && d.value <= n) {
				out.push({ sides: n, face: d.value - 1, kept: d.kept });
			} else if ((n === 100 || g.faces === '%') && d.value >= 1 && d.value <= 100) {
				const tens = Math.floor((d.value % 100) / 10);
				const ones = d.value % 10;
				const tensLabel = Array.from({ length: 10 }, (_, i) => `${(i + 1) % 10}0`);
				const onesLabel = Array.from({ length: 10 }, (_, i) => String((i + 1) % 10));
				out.push({ sides: 10, face: (tens + 9) % 10, label: tensLabel, kept: d.kept });
				out.push({ sides: 10, face: (ones + 9) % 10, label: onesLabel, kept: d.kept });
			} else if (g.faces === 'F' && d.value >= -1 && d.value <= 1) {
				out.push({ sides: 6, face: d.value === -1 ? 0 : d.value === 0 ? 2 : 1, label: FATE, kept: d.kept });
			}
		}
	}
	return out.length > MAX_THROWN ? [] : out;
}

interface Flying {
	t: Thrown;
	s: Solid;
	end: Mat;
	axis: Vec;
	spin: number;
	from: [number, number];
	to: [number, number];
	delay: number;
}

// less on the many-sided dice, whose faces sit closer together
const TIP: Record<number, number> = { 4: 0.35, 6: 0.5, 8: 0.35, 10: 0.25, 12: 0.25, 20: 0.2 };
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/** Throws the dice toward `near` (a rect on screen, or the middle of the window) and resolves when they have landed.
 *  Resolves at once when there is nothing to draw on. */
export function throwDice(doc: Document, dice: Thrown[], near?: DOMRect, rng: () => number = Math.random): Promise<void> {
	const win = doc.defaultView;
	if (!dice.length || !win) return Promise.resolve();
	const canvas = doc.body.createEl('canvas', { cls: 'dice-tray-throw', attr: { 'aria-hidden': 'true' } });
	const g = canvas.getContext('2d');
	if (!g) {
		canvas.remove();
		return Promise.resolve();
	}
	const W = win.innerWidth;
	const H = win.innerHeight;
	const ratio = win.devicePixelRatio || 1;
	canvas.width = W * ratio;
	canvas.height = H * ratio;
	const size = Math.max(22, Math.min(40, W / 16));
	const style = win.getComputedStyle(doc.body);
	const body = style.getPropertyValue('--interactive-accent').trim() || '#7c5cff';
	const ink = style.getPropertyValue('--text-on-accent').trim() || '#fff';

	// they land in rows over (or under) the roll, kept on screen
	const perRow = Math.max(1, Math.min(dice.length, Math.floor((W - 40) / (size * 2.5))));
	const rows = Math.ceil(dice.length / perRow);
	const cx = near ? near.left + near.width / 2 : W / 2;
	const above = near ? near.top - size * 2.5 * rows - 10 > 0 : false;
	const top = near ? (above ? near.top - size * 2.5 * rows : near.bottom + size * 1.3) : H / 2 - (size * 2.5 * rows) / 2;
	const flying: Flying[] = dice.map((t, i) => {
		const row = Math.floor(i / perRow);
		const inRow = Math.min(perRow, dice.length - row * perRow);
		const col = i % perRow;
		let x = cx + (col - (inRow - 1) / 2) * size * 2.5;
		x = Math.max(size * 1.3, Math.min(W - size * 1.3, x));
		const y = Math.max(size * 1.3, Math.min(H - size * 1.3, top + size * 1.25 + row * size * 2.5));
		const s = solid(t.sides)!;
		return {
			t,
			s,
			// tipped back a little so it reads as a solid, the rolled face still the one most toward you
			end: multiply(turn([1, -0.5, 0], TIP[t.sides] ?? 0.2), facing(s, t.face, (rng() - 0.5) * 0.6)),
			axis: norm([rng() - 0.5, rng() - 0.5, rng() * 0.3]),
			spin: Math.PI * (3 + rng() * 2),
			from: [W + size * 2 + rng() * size * 3, y + (rng() - 0.5) * H * 0.4],
			to: [x, y],
			delay: i * 40,
		};
	});

	return new Promise((resolve) => {
		const start = win.performance.now();
		let landed = false;
		const frame = (now: number) => {
			const ms = now - start;
			g.setTransform(ratio, 0, 0, ratio, 0, 0);
			g.clearRect(0, 0, W, H);
			const fade = Math.max(0, Math.min(1, (ms - FLIGHT - STILL) / FADE));
			for (const f of flying) {
				const t = Math.max(0, Math.min(1, (ms - f.delay) / FLIGHT));
				const e = ease(t);
				const x = f.from[0] + (f.to[0] - f.from[0]) * e;
				const y = f.from[1] + (f.to[1] - f.from[1]) * e;
				// bounces toward the viewer, smaller each time
				const lift = Math.abs(Math.sin(t * Math.PI * 3)) * (1 - t) * 0.35;
				const m = multiply(turn(f.axis, f.spin * (1 - e)), f.end);
				g.globalAlpha = (1 - fade) * (t >= 1 && !f.t.kept ? 0.45 : 1);
				draw(g, f, m, x, y, size * (1 + lift), lift, body, ink);
			}
			g.globalAlpha = 1;
			if (!landed && ms >= FLIGHT + (flying.length - 1) * 40) {
				landed = true;
				resolve();
			}
			if (fade < 1) win.requestAnimationFrame(frame);
			else canvas.remove();
		};
		win.requestAnimationFrame(frame);
	});
}

const LIGHT = norm([-0.4, -0.7, 0.8]);

function draw(g: CanvasRenderingContext2D, f: Flying, m: Mat, x: number, y: number, r: number, lift: number, body: string, ink: string) {
	// the shadow, further off while the die is in the air
	g.fillStyle = 'rgba(0,0,0,0.18)';
	g.beginPath();
	g.ellipse(x + r * (0.15 + lift), y + r * (0.85 + lift), r * 0.8, r * 0.28, 0, 0, Math.PI * 2);
	g.fill();
	const pts = f.s.corners.map((c) => apply(m, c));
	f.s.faces.forEach((face, i) => {
		const n = apply(m, face.normal);
		if (n[2] <= 0.001) return; // it faces away; a convex die needs no other sorting
		const light = 0.5 + 0.5 * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
		g.beginPath();
		face.corners.forEach((k, j) => {
			const p = pts[k]!;
			if (j) g.lineTo(x + p[0] * r, y + p[1] * r);
			else g.moveTo(x + p[0] * r, y + p[1] * r);
		});
		g.closePath();
		g.fillStyle = body;
		g.fill();
		g.fillStyle = `rgba(${light > 0.75 ? '255,255,255' : '0,0,0'},${Math.abs(light - 0.75) * 1.2})`;
		g.fill();
		g.strokeStyle = 'rgba(0,0,0,0.35)';
		g.lineWidth = 1;
		g.stroke();
		if (n[2] < 0.25) return; // too edge-on to read
		// the number lies in the face: its across and up are the face's own, seen from here
		const c = apply(m, face.centre);
		const across = apply(m, [
			face.normal[1] * face.up[2] - face.normal[2] * face.up[1],
			face.normal[2] * face.up[0] - face.normal[0] * face.up[2],
			face.normal[0] * face.up[1] - face.normal[1] * face.up[0],
		]);
		const down = apply(m, [-face.up[0], -face.up[1], -face.up[2]]);
		const text = f.t.label?.[i] ?? String(i + 1);
		const k = r * (f.s.sides >= 12 ? 0.3 : f.s.sides === 10 ? 0.32 : 0.42) * (text.length > 1 ? 0.8 : 1);
		g.save();
		g.setTransform(g.getTransform().multiply(new DOMMatrix([across[0] * k, across[1] * k, down[0] * k, down[1] * k, x + c[0] * r, y + c[1] * r])));
		g.fillStyle = ink;
		g.font = 'bold 1px sans-serif';
		g.textAlign = 'center';
		g.textBaseline = 'middle';
		g.fillText(text, 0, 0.05);
		// 6 and 9 are told apart by a line under them
		if ((text === '6' || text === '9') && f.s.sides > 6) g.fillRect(-0.28, 0.42, 0.56, 0.07);
		g.restore();
	});
}
