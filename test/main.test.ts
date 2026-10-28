// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('./obsidian-shim'));

import { App, ctx, installDomHelpers } from './obsidian-shim';
import DiceTrayPlugin from '../src/main';

installDomHelpers();

const NOTE = `---
tags: [tables]
---
# Encounters

## Forest

- Wolves
- A lost merchant
- Bandits

## Weather

| d6 | Sky |
| --- | --- |
| 1-2 | Rain |
| 3-5 | Clear |
| 6 | Storm |
^weather

| Item | Value |
| --- | --- |
| Gem | 50 |
| Ring | 20 |
^loot

Some rumour about the old mill.
`;

async function load() {
	const app = new App();
	app.notes.set('Encounters', { path: 'Encounters.md', content: NOTE });
	const plugin = new DiceTrayPlugin(app as never, { id: 'dice-tray' } as never);
	plugin.settings.animate = false;
	await plugin.onload();
	plugin.settings.animate = false;
	return { app, plugin };
}

function render(plugin: DiceTrayPlugin, html: string): HTMLElement {
	const el = document.createElement('div');
	el.innerHTML = html;
	for (const pp of (plugin as never as { postProcessors: ((e: HTMLElement, c: unknown) => void)[] }).postProcessors) pp(el, ctx());
	return el;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Dice Tray in a (fake) note', () => {
	let plugin: DiceTrayPlugin;
	beforeAll(async () => {
		({ plugin } = await load());
	});

	it('registers a command and a settings tab', () => {
		const p = plugin as never as { commands: { id: string }[]; settingTab: unknown };
		expect(p.commands.map((c) => c.id)).toEqual(['roll']);
		expect(p.settingTab).toBeTruthy();
	});

	it('turns `dice: 3d6 + 2` into a chip with a number and a hover card', () => {
		const el = render(plugin, '<p>Attack: <code>dice: 3d6 + 2</code> damage</p>');
		const chip = el.querySelector('.dice-tray')!;
		expect(chip).toBeTruthy();
		expect(el.querySelector('code')).toBeNull();
		const total = Number(chip.querySelector('.dice-tray-total')!.textContent);
		expect(total).toBeGreaterThanOrEqual(5);
		expect(total).toBeLessThanOrEqual(20);
		expect(chip.querySelectorAll('.dice-tray-die')).toHaveLength(3);
		expect(chip.getAttribute('title')).toMatch(/^3d6 \[\d, \d, \d\] = \d+$/);
	});

	it('rerolls on click and respects flags', () => {
		const el = render(plugin, '<p><code>dice: 1d1000|form</code> <code>dice: 2d6|avg</code> <code>dice: 1d6|text(Roll me)</code></p>');
		const [chip, avg, labelled] = Array.from(el.querySelectorAll('.dice-tray'));
		expect(chip!.querySelector('.dice-tray-formula')!.textContent).toBe('1d1000');
		const before = chip!.querySelector('.dice-tray-total')!.textContent;
		let changed = false;
		for (let i = 0; i < 20 && !changed; i++) {
			(chip as HTMLElement).click();
			changed = chip!.querySelector('.dice-tray-total')!.textContent !== before;
		}
		expect(changed).toBe(true);
		expect(avg!.textContent).toBe('7');
		expect(labelled!.querySelector('.dice-tray-total')!.textContent).toBe('Roll me');
	});

	it('leaves code that is not a roll alone and shows errors inline', () => {
		const el = render(plugin, '<p><code>npm test</code> <code>dice: 1d0</code></p>');
		expect(el.querySelectorAll('code')).toHaveLength(1);
		const err = el.querySelector('.dice-tray-error')!;
		expect(err.textContent).toMatch(/one face/);
	});

	it('renders a dice code block, one roll per line', () => {
		const el = document.createElement('div');
		(plugin as never as { codeBlocks: Record<string, (s: string, e: HTMLElement, c: unknown) => void> }).codeBlocks['dice']!(
			'1d20\n\n2d6+3\n',
			el,
			ctx(),
		);
		expect(el.querySelectorAll('.dice-tray')).toHaveLength(2);
	});

	it('rolls a random list item from a heading, and a table row by block', async () => {
		const el = render(plugin, '<p><code>dice: [[Encounters#Forest]]</code> <code>dice: [[Encounters^loot]]|Item</code> <code>dice: [[Encounters^weather]]</code></p>');
		await tick();
		await tick();
		const [forest, loot, weather] = Array.from(el.querySelectorAll('.dice-tray-note'));
		expect(['Wolves', 'A lost merchant', 'Bandits']).toContain(forest!.querySelector('.dice-tray-note-out')!.textContent);
		expect(['Gem', 'Ring']).toContain(loot!.querySelector('.dice-tray-note-out')!.textContent);
		expect(weather!.querySelector('.dice-tray-note-out')!.textContent).toMatch(/^\*\*[1-6]\*\* (Rain|Clear|Storm)$/);
	});

	it('rolls whole sections of a note, several at once without repeats', async () => {
		const el = render(plugin, '<p><code>dice: 3d[[Encounters]]</code></p>');
		await tick();
		await tick();
		const items = Array.from(el.querySelectorAll('.dice-tray-note-item')).map((i) => i.textContent);
		expect(items).toHaveLength(3);
		expect(new Set(items).size).toBe(3);
		for (const t of items) expect(t).not.toMatch(/^#|^tags:/);
	});

	it('fills in fields from the note the roll is in', async () => {
		(plugin.app as unknown as App).notes.set('Game.md', { path: 'Game.md', content: '---\ndex: 3\n---\nstr:: 2\n' });
		const el = render(plugin, '<p><code>dice: 1d1 + dex + str</code> <code>dice: 1d20 + wis</code></p>');
		await tick();
		expect(el.querySelector('.dice-tray-total')!.textContent).toBe('6');
		expect(el.querySelector('.dice-tray-error')!.textContent).toBe('No field "wis" in this note');
	});

	it('rolls narrative pools and stunt dice', () => {
		const el = render(plugin, '<p><code>dice: 2g1p</code> <code>dice: 1dS</code></p>');
		const [pool, stunt] = Array.from(el.querySelectorAll('.dice-tray-total')).map((t) => t.textContent!);
		expect(pool).toMatch(/success|failure/);
		expect(el.querySelector('.dice-tray-narrative')!.getAttribute('title')).toMatch(/^2g1p: ability: /);
		expect(stunt).toMatch(/^\d+( \(\d SP\))?$/);
		expect(el.querySelectorAll('.dice-tray-die-stunt').length).toBe(1);
	});

	it('announces a roll someone clicked, not the one the note makes as it opens', async () => {
		const app = plugin.app as unknown as App;
		app.events.length = 0;
		const el = render(plugin, '<p><code>dice: 2d1 + 3</code> <code>dice: [[Encounters#Forest]]</code></p>');
		await tick();
		expect(app.events).toEqual([]);
		(el.querySelector('.dice-tray') as HTMLElement).click();
		(el.querySelector('.dice-tray-note') as HTMLElement).click();
		await tick();
		expect(app.events[0]).toEqual({ name: 'dice-tray:roll', data: { sourcePath: 'Game.md', expression: '2d1 + 3', text: '2d1 + 3 -> [1, 1] + 3 -> 5' } });
		expect((app.events[1]!.data as { text: string }).text).toMatch(/^\[\[Encounters#Forest\]\]: (Wolves|A lost merchant|Bandits)$/);
	});

	it('reports a missing note', async () => {
		const el = render(plugin, '<p><code>dice: [[Nowhere]]</code></p>');
		await tick();
		expect(el.querySelector('.dice-tray-error')!.textContent).toBe('No note "Nowhere"');
	});

	it('exposes searchable settings and persists a change', async () => {
		const tab = (plugin as never as { settingTab: { getSettingDefinitions(): { name: string }[]; setControlValue(k: string, v: unknown): Promise<void>; getControlValue(k: string): unknown } }).settingTab;
		expect(tab.getSettingDefinitions().map((d) => d.name)).toEqual(['Default die', 'Show the formula', 'Animate rolls', 'Round results']);
		await tab.setControlValue('defaultFaces', 8);
		expect(tab.getControlValue('defaultFaces')).toBe(8);
		expect(plugin.doRoll('1d').groups[0]!.faces).toBe('8');
	});
});
