// Browser bundle of the plugin plus the test shim, for the demo page on the site.
import esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const out = new URL('../../public/press/dice-tray/', import.meta.url);
mkdirSync(out, { recursive: true });
await esbuild.build({
	entryPoints: ['demo/driver.ts'],
	bundle: true,
	format: 'iife',
	target: 'es2021',
	minify: true,
	alias: { obsidian: './test/obsidian-shim.ts' },
	outfile: new URL('demo.js', out).pathname,
	logLevel: 'info',
});
copyFileSync('styles.css', new URL('styles.css', out));
