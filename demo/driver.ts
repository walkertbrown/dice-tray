// Browser demo: runs the real plugin against the test shim, over a sample note.
import { App, MarkdownRenderer, WorkspaceLeaf, ctx, installDomHelpers } from '../test/obsidian-shim';
import DiceTrayPlugin, { DicePanel } from '../src/main';

installDomHelpers();

// the shim's renderer prints raw markdown; the demo wants bold, lists and tables to look real
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
const inline = (s: string) =>
	esc(s)
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<a class="internal-link">$2</a>')
		.replace(/\[\[([^\]]+)\]\]/g, '<a class="internal-link">$1</a>')
		.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
		.replace(/\*(.+?)\*/g, '<em>$1</em>')
		.replace(/`([^`]+)`/g, '<code>$1</code>');
function mini(md: string): string {
	const out: string[] = [];
	const lines = md.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (/^\s*\|/.test(line)) {
			const rows: string[] = [];
			while (i < lines.length && /^\s*\|/.test(lines[i] ?? '')) rows.push(lines[i] ?? ''), i++;
			i--;
			const cells = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
			const [head, , ...body] = rows;
			out.push('<table><thead><tr>' + cells(head ?? '').map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
				+ body.map((r) => '<tr>' + cells(r).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
		} else if (/^\s*[-*+]\s/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*[-*+]\s/.test(lines[i] ?? '')) items.push((lines[i] ?? '').replace(/^\s*[-*+]\s/, '')), i++;
			i--;
			out.push('<ul>' + items.map((t) => `<li>${inline(t)}</li>`).join('') + '</ul>');
		} else if (/^#+\s/.test(line)) {
			out.push(`<strong>${inline(line.replace(/^#+\s/, ''))}</strong>`);
		} else if (line.trim()) {
			out.push(`<p>${inline(line)}</p>`);
		}
	}
	return out.join('');
}
MarkdownRenderer.render = async (_app, md, el) => {
	el.innerHTML = mini(md);
};

const NOTE = `# Encounters

## Forest

- Wolves circling a dead horse
- A lost merchant with one shoe
- Bandits pretending to be pilgrims
- An owlbear, asleep

## Weather

| d6 | Sky |
| --- | --- |
| 1-2 | Rain all day |
| 3-5 | Clear and cold |
| 6 | Storm rolling in |
^weather

| Item | Value |
| --- | --- |
| Rough garnet | 50 gp |
| Silver ring | 20 gp |
| Cracked pearl | 80 gp |
^loot

The miller's son has not been seen since the fair.
`;

async function main() {
	const app = new App();
	app.notes.set('Encounters', { path: 'Encounters.md', content: NOTE });
	app.notes.set('Game.md', { path: 'Game.md', content: '# Session 12 prep\n\nstr:: 4\nwis:: 1\n' });
	// what Session Log would write for each clicked roll
	const log = document.querySelector<HTMLElement>('#log');
	app.workspace.trigger = (name: string, data: unknown) => {
		if (name !== 'dice-tray:roll' || !log) return;
		const d = new Date();
		const li = document.createElement('li');
		li.textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')} Rolled ${(data as { text: string }).text}`;
		log.appendChild(li);
	};
	const plugin = new DiceTrayPlugin(app as never, { id: 'dice-tray' } as never);
	await plugin.onload();
	const pps = (plugin as never as { postProcessors: ((e: HTMLElement, c: unknown) => void)[] }).postProcessors;
	for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-note]'))) {
		for (const pp of pps) pp(el, ctx());
	}
	const toggle = document.querySelector<HTMLInputElement>('#animate');
	toggle?.addEventListener('change', () => {
		plugin.settings.animate = toggle.checked;
	});
	const form = document.querySelector<HTMLInputElement>('#formula');
	form?.addEventListener('change', () => {
		plugin.settings.showFormula = form.checked;
		for (const el of Array.from(document.querySelectorAll<HTMLElement>('.dice-tray-formula'))) {
			el.style.display = form.checked ? '' : 'none';
		}
	});
	// the "type your own" box
	const input = document.querySelector<HTMLInputElement>('#own');
	const out = document.querySelector<HTMLElement>('#own-out');
	const roll = () => {
		if (!input || !out) return;
		out.innerHTML = '';
		const p = document.createElement('p');
		const code = document.createElement('code');
		code.textContent = `dice: ${input.value}`;
		p.appendChild(code);
		out.appendChild(p);
		for (const pp of pps) pp(out, ctx());
	};
	input?.addEventListener('keydown', (ev) => {
		if (ev.key === 'Enter') roll();
	});
	document.querySelector('#own-go')?.addEventListener('click', roll);
	// the side panel, as it opens in Obsidian's sidebar
	const side = document.querySelector<HTMLElement>('#panel');
	if (side) {
		plugin.settings.saved = ['1d20 + 5', '2d6 + 3'];
		const panel = new DicePanel(new WorkspaceLeaf(app) as never, plugin);
		side.appendChild(panel.contentEl);
		await panel.onOpen();
	}
}

void main();
