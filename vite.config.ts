import { defineConfig } from 'vite';

const BRIDGE = `http://localhost:${process.env.BRIDGE_PORT ?? 8787}`;

export default defineConfig({
  server: {
    port: 5173,
    // The browser talks to the bridge through Vite, so the page works from a
    // single origin (handy when recording or tunnelling the demo).
    proxy: {
      '/api': { target: BRIDGE, changeOrigin: true },
      '/sim-client': { target: BRIDGE.replace('http', 'ws'), ws: true },
    },
  },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // MIT and BSD require keeping the notices of bundled libraries (three.js); Vite writes them here.
    license: { fileName: 'third-party-licenses.md' },
    rollupOptions: { input: { main: 'index.html', race: 'race.html', selftest: 'selftest.html', workbench: 'workbench.html' } },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
} as never);
