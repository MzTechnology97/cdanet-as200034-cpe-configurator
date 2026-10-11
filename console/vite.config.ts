import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The console is built into web/app (served by the server under /app/, files with a content hash
 * in their name: cached for a year). The pages not converted yet are the modules of web/js, bundled
 * as they are; vendor files, images, maps and the wiki stay in web/ and are served as before.
 * `npm run dev`: this console on :5173 against the demo server on :8799.
 */
const web = fileURLToPath(new URL('../web/', import.meta.url));
// forward slashes: the same module id as the console's own imports of it (one module, one list of pages)
const legacyReact = fileURLToPath(new URL('src/lib/react-legacy.ts', import.meta.url)).split('\\').join('/');

/**
 * The pages of web/js that import their React helper (web/js/react.js) get the console's instead:
 * one React for the whole console, and the frame can unmount them (src/lib/react-legacy.ts).
 */
const oneReact = {
  name: 'cdanet-one-react',
  enforce: 'pre' as const,
  async resolveId(this: { resolve: (s: string, i?: string, o?: { skipSelf: boolean }) => Promise<{ id: string } | null> }, source: string, importer?: string) {
    if (!importer || !/react\.js$/.test(source)) return null;
    const r = await this.resolve(source, importer, { skipSelf: true });
    return r && r.id.split('\\').join('/').endsWith('/web/js/react.js') ? legacyReact : null;
  },
};
const server = process.env.CONSOLE_API ?? 'http://127.0.0.1:8799';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/app/',
  publicDir: false,
  plugins: [oneReact, react()],
  build: {
    outDir: `${web}app`,
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        embed: fileURLToPath(new URL('map-embed.html', import.meta.url)),
      },
    },
  },
  server: {
    fs: { allow: ['..'] },
    proxy: Object.fromEntries(['/api', '/vendor', '/assets', '/map', '/wiki'].map((p) => [p, { target: server, changeOrigin: true }])),
  },
});
