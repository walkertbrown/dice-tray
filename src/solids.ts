// The dice as solids: their corners, faces and the turn that brings a face to the front. No DOM here, so it is easy
// to test. Screen axes: x right, y down, z toward the viewer.

export type Vec = [number, number, number];
export type Mat = [Vec, Vec, Vec]; // rows

export interface Face {
	corners: number[]; // indices into `corners`, in order around the face
	normal: Vec;
	centre: Vec;
	up: Vec; // which way the face's number stands
}

export interface Solid {
	sides: number;
	corners: Vec[];
	faces: Face[]; // face i shows the number i + 1
}

export const SOLID_SIDES = [4, 6, 8, 10, 12, 20] as const;

const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const norm = (a: Vec): Vec => scale(a, 1 / Math.hypot(...a));

export function apply(m: Mat, v: Vec): Vec {
	return [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
}

export function multiply(a: Mat, b: Mat): Mat {
	const col = (j: 0 | 1 | 2): Vec => [b[0][j], b[1][j], b[2][j]];
	return [0, 1, 2].map((i) => [dot(a[i]!, col(0)), dot(a[i]!, col(1)), dot(a[i]!, col(2))]) as Mat;
}

/** A turn of `angle` radians about `axis` (Rodrigues). */
export function turn(axis: Vec, angle: number): Mat {
	const [x, y, z] = norm(axis);
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	const t = 1 - c;
	return [
		[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
		[t * x * y + s * z, t * y * y + c, t * y * z - s * x],
		[t * x * z - s * y, t * y * z + s * x, t * z * z + c],
	];
}

// The faces of a convex solid, one per outward direction: the corners furthest along it, in order around it.
function facesFrom(corners: Vec[], normals: Vec[]): Face[] {
	return normals.map((raw) => {
		const n = norm(raw);
		const far = Math.max(...corners.map((c) => dot(c, n)));
		const on = corners.map((c, i) => ({ c, i })).filter(({ c }) => far - dot(c, n) < 1e-6);
		const centre = scale(on.reduce<Vec>((s, { c }) => [s[0] + c[0], s[1] + c[1], s[2] + c[2]], [0, 0, 0]), 1 / on.length);
		// the number stands toward +z, or +y on a face that looks straight along z
		const helper: Vec = Math.abs(n[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
		const up = norm(sub(helper, scale(n, dot(helper, n))));
		const side = cross(n, up);
		const angle = (c: Vec) => Math.atan2(dot(sub(c, centre), up), dot(sub(c, centre), side));
		on.sort((a, b) => angle(a.c) - angle(b.c));
		return { corners: on.map(({ i }) => i), normal: n, centre, up };
	});
}

const PHI = (1 + Math.sqrt(5)) / 2;
const signs = (v: Vec): Vec[] => {
	const out: Vec[] = [];
	for (const a of v[0] ? [1, -1] : [1]) for (const b of v[1] ? [1, -1] : [1]) for (const c of v[2] ? [1, -1] : [1]) out.push([v[0] * a, v[1] * b, v[2] * c]);
	return out;
};
const cyclic = (v: Vec): Vec[] => [v, [v[2], v[0], v[1]], [v[1], v[2], v[0]]];
const ICOSA: Vec[] = cyclic([0, 1, PHI]).flatMap(signs);
const DODECA: Vec[] = [...signs([1, 1, 1]), ...cyclic([0, 1 / PHI, PHI]).flatMap(signs)];
// the directions to each one's face centres: the other solid, turned the other way round
const ICOSA_FACES: Vec[] = cyclic([0, PHI, 1]).flatMap(signs);
const DODECA_FACES: Vec[] = [...signs([1, 1, 1]), ...cyclic([0, PHI, 1 / PHI]).flatMap(signs)];

function d10(): { corners: Vec[]; normals: Vec[] } {
	// a pentagonal trapezohedron: two poles and a zigzag ring; h is set so each kite is flat
	const a = 0.105;
	const c36 = Math.cos(Math.PI / 5);
	const h = (a * (1 + c36)) / (1 - c36);
	const ring: Vec[] = [];
	for (let k = 0; k < 10; k++) ring.push([Math.cos((k * Math.PI) / 5), Math.sin((k * Math.PI) / 5), k % 2 ? -a : a]);
	const u = h + a;
	const normals: Vec[] = [];
	for (let k = 0; k < 10; k++) {
		const t = (k * Math.PI) / 5;
		normals.push([u * Math.cos(t), u * Math.sin(t), k % 2 ? 1 : -1]);
	}
	return { corners: [[0, 0, h], [0, 0, -h], ...ring], normals };
}

const cache = new Map<number, Solid>();

/** The solid for a die with this many sides, or null for one that isn't a solid (d3, d100, d7). */
export function solid(sides: number): Solid | null {
	const hit = cache.get(sides);
	if (hit) return hit;
	let corners: Vec[];
	let normals: Vec[];
	switch (sides) {
		case 4:
			corners = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
			normals = corners.map((c) => scale(c, -1));
			break;
		case 6:
			corners = signs([1, 1, 1]);
			normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
			break;
		case 8:
			corners = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
			normals = signs([1, 1, 1]);
			break;
		case 10:
			({ corners, normals } = d10());
			break;
		case 12:
			corners = DODECA;
			normals = ICOSA_FACES;
			break;
		case 20:
			corners = ICOSA;
			normals = DODECA_FACES;
			break;
		default:
			return null;
	}
	// every die the same size on screen: its furthest corner at 1
	const r = Math.max(...corners.map((c) => Math.hypot(...c)));
	corners = corners.map((c) => scale(c, 1 / r));
	const s: Solid = { sides, corners, faces: facesFrom(corners, normals) };
	cache.set(sides, s);
	return s;
}

/** The turn that shows face `index` to the viewer with its number upright, then twisted `twist` radians. */
export function facing(s: Solid, index: number, twist = 0): Mat {
	const f = s.faces[index]!;
	const side = cross(f.up, f.normal);
	// the face's own frame (side, up, normal) onto the screen's (-x, -y, z): the number reads upright
	const from: Mat = [side, f.up, f.normal];
	const to: Mat = [[-1, 0, 0], [0, -1, 0], [0, 0, 1]];
	const toT: Mat = [[to[0][0], to[1][0], to[2][0]], [to[0][1], to[1][1], to[2][1]], [to[0][2], to[1][2], to[2][2]]];
	return multiply(turn([0, 0, 1], twist), multiply(toT, from));
}
