import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `obsidian` ships types only; tests run main.ts against the shim in test/.
export default defineConfig({
	resolve: { alias: { obsidian: fileURLToPath(new URL('./test/obsidian-shim.ts', import.meta.url)) } },
	test: { environment: 'node' },
});
