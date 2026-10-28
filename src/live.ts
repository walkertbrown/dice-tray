// Rolls in Live Preview: the same chips as reading view, drawn over `dice:` inline code while the cursor is elsewhere.
// Put the cursor on one and the code comes back to edit.
import { syntaxTree } from '@codemirror/language';
import { EditorState, Range, SelectionRange } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';

/** A roll in the note: where its inline code sits, backticks and all, and the text inside them. */
export interface Span { from: number; to: number; whole: string; src: string }

/** Draws the chip for `src`. `whole` is the code as written, backticks included, for writing a result back. */
export type Draw = (src: string, whole: string, view: EditorView) => HTMLElement;

const ROLL = /^dice(\+|-mod|-)?:\s*\S/i;

/** An inline code node as a Span, or null if it isn't a roll. Obsidian's tree marks only the text inside the
 *  backticks (`inline-code`), lezer's markdown the whole thing (`InlineCode`); either way the backticks are walked over. */
export function codeSpan(state: EditorState, from: number, to: number): Span | null {
	const doc = state.doc;
	while (from > 0 && doc.sliceString(from - 1, from) === '`') from--;
	while (to < doc.length && doc.sliceString(to, to + 1) === '`') to++;
	const whole = doc.sliceString(from, to);
	const m = /^(`+)([^\n]*?)\1$/.exec(whole);
	if (!m) return null;
	const src = m[2]!.trim();
	return ROLL.test(src) ? { from, to, whole, src } : null;
}

/** Every roll in the given parts of the note (the visible ones). */
export function rollSpans(state: EditorState, ranges: readonly { from: number; to: number }[]): Span[] {
	const out: Span[] = [];
	const seen = new Set<number>();
	for (const { from, to } of ranges) {
		syntaxTree(state).iterate({
			from,
			to,
			enter: (n) => {
				const name = n.type.name;
				if (name !== 'InlineCode' && (!name.includes('inline-code') || name.includes('formatting'))) return;
				const s = codeSpan(state, n.from, n.to);
				if (s && !seen.has(s.from)) {
					seen.add(s.from);
					out.push(s);
				}
				return false;
			},
		});
	}
	return out;
}

/** True when a cursor or selection touches the span, which then shows as code to edit. */
export function touches(ranges: readonly SelectionRange[], from: number, to: number): boolean {
	return ranges.some((r) => r.from <= to && r.to >= from);
}

class RollWidget extends WidgetType {
	constructor(readonly span: Span, readonly draw: Draw) {
		super();
	}
	// the same roll in the same place keeps its chip, so typing elsewhere doesn't roll it again
	eq(other: RollWidget) {
		return other.span.whole === this.span.whole;
	}
	toDOM(view: EditorView) {
		return this.draw(this.span.src, this.span.whole, view);
	}
	// a click is the chip's (roll again), not the editor's (move the cursor into the code)
	ignoreEvent() {
		return true;
	}
}

function build(view: EditorView, draw: Draw, live: (s: EditorState) => boolean): DecorationSet {
	if (!live(view.state)) return Decoration.none;
	const sel = view.state.selection.ranges;
	const marks: Range<Decoration>[] = [];
	for (const s of rollSpans(view.state, view.visibleRanges)) {
		if (touches(sel, s.from, s.to)) continue;
		marks.push(Decoration.replace({ widget: new RollWidget(s, draw) }).range(s.from, s.to));
	}
	return Decoration.set(marks, true);
}

/** The editor extension. `live` says whether the editor is in Live Preview (source mode shows the code as it is). */
export function liveRolls(draw: Draw, live: (s: EditorState) => boolean) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = build(view, draw, live);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged || u.selectionSet || live(u.startState) !== live(u.state)) {
					this.decorations = build(u.view, draw, live);
				}
			}
		},
		{ decorations: (v) => v.decorations },
	);
}

/** Writes a roll's result over its code (`dice+:` and `dice-mod:`). The chip's place is read from the editor, so text
 *  typed above it since doesn't matter; false if the code there has changed. Waits a turn, as the chip is drawn while
 *  the editor is mid-update. */
export async function writeOver(view: EditorView, chipOf: () => HTMLElement | null, whole: string, to: string): Promise<boolean> {
	await new Promise((done) => window.setTimeout(done, 0));
	const chip = chipOf();
	if (!chip?.isConnected) return false;
	const at = view.posAtDOM(chip);
	if (view.state.doc.sliceString(at, at + whole.length) !== whole) return false;
	view.dispatch({ changes: { from: at, to: at + whole.length, insert: to } });
	return true;
}
