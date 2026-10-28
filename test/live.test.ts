// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('./obsidian-shim'));

import { markdown } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { App, editorInfoField, editorLivePreviewField, installDomHelpers, TFile } from './obsidian-shim';
import DiceTrayPlugin from '../src/main';
import { rollSpans, touches } from '../src/live';

installDomHelpers();

// A real CodeMirror editor with the plugin's extension. Obsidian's own markdown tree names inline code differently
// from lezer's; live.ts reads both.
async function editor(doc: string, cursor = 0, live = true) {
	const app = new App();
	const plugin = new DiceTrayPlugin(app as never, { id: 'dice-tray' } as never);
	await plugin.onload();
	plugin.settings.animate = false;
	const parent = document.body.appendChild(document.createElement('div'));
	const view = new EditorView({
		parent,
		state: EditorState.create({
			doc,
			selection: EditorSelection.cursor(cursor),
			extensions: [
				markdown(),
				editorLivePreviewField.init(() => live),
				editorInfoField.init(() => ({ file: new TFile('Game.md') })),
				...(plugin as never as { editorExtensions: never[] }).editorExtensions,
			],
		}),
	});
	return { view, app };
}
const chips = (view: EditorView) => Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.dice-tray'));
const tick = () => new Promise((done) => setTimeout(done, 5));

describe('Live Preview', () => {
	it('finds rolls in inline code, and not other code or code blocks', () => {
		const doc = 'Hit `dice: 1d20 + 5` with `plain code`.\n\n```\n`dice: 1d6`\n```\n\nDamage ``dice: 2d6 + 3``';
		const state = EditorState.create({ doc, extensions: [markdown()] });
		const spans = rollSpans(state, [{ from: 0, to: doc.length }]);
		expect(spans.map((s) => s.src)).toEqual(['dice: 1d20 + 5', 'dice: 2d6 + 3']);
		expect(spans.map((s) => s.whole)).toEqual(['`dice: 1d20 + 5`', '``dice: 2d6 + 3``']);
		expect(doc.slice(spans[0]!.from, spans[0]!.to)).toBe('`dice: 1d20 + 5`');
	});

	it('draws a chip for each roll the cursor is not on', async () => {
		const doc = 'Hit `dice: 1d20 + 5` for `dice: 2d6 + 3`.';
		const { view } = await editor(doc, 0);
		expect(chips(view)).toHaveLength(2);
		expect(view.contentDOM.textContent).not.toContain('dice:');
		// the cursor on the second roll shows its code to edit
		view.dispatch({ selection: { anchor: doc.indexOf('2d6') } });
		expect(chips(view)).toHaveLength(1);
		expect(view.contentDOM.textContent).toContain('`dice: 2d6 + 3`');
		expect(touches(view.state.selection.ranges, 0, 3)).toBe(false);
		expect(touches(view.state.selection.ranges, doc.indexOf('`dice: 2d6'), doc.length - 1)).toBe(true);
	});

	it('leaves source mode alone', async () => {
		const { view } = await editor('Hit `dice: 1d20 + 5`.', 0, false);
		expect(chips(view)).toHaveLength(0);
	});

	it('keeps a rolled chip while typing elsewhere, and a click rolls it again', async () => {
		const { view, app } = await editor('Hit `dice: 1d20 + 5`.\n', 0);
		const first = chips(view)[0]!;
		const total = first.querySelector('.dice-tray-total')!.textContent;
		view.dispatch({ changes: { from: view.state.doc.length, insert: 'more words' }, selection: { anchor: view.state.doc.length + 10 } });
		expect(chips(view)[0]).toBe(first);
		expect(first.querySelector('.dice-tray-total')!.textContent).toBe(total);
		first.click();
		await tick();
		expect(app.events.map((e) => e.name)).toContain('dice-tray:roll');
		expect((app.events.at(-1)!.data as { sourcePath: string }).sourcePath).toBe('Game.md');
	});

	it('writes a dice+ result into the note, and leaves it there', async () => {
		const { view } = await editor('Stats: `dice+: 4d6dl1`\n', 0);
		await tick();
		const text = view.state.doc.toString();
		expect(text).toMatch(/^Stats: `dice\+: 4d6dl1 -> \[\d, \d, \d\] -> \d+`\n$/);
		await tick();
		expect(view.state.doc.toString()).toBe(text);
		expect(chips(view)[0]!.classList.contains('dice-tray-saved')).toBe(true);
	});

	it('replaces dice-mod with its result', async () => {
		const { view } = await editor('Gold: `dice-mod: 2d6`\n', 0);
		await tick();
		expect(view.state.doc.toString()).toMatch(/^Gold: 2d6 -> \[\d, \d\] -> \d+\n$/);
	});
});
