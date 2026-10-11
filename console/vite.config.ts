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
const server = process.env.CONSOLE_API ?? 'http://127.0.0.1:8799';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/app/',
  publicDir: false,
  plugins: [react()],
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
