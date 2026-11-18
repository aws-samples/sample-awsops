import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
const path = (name: string) => fileURLToPath(new URL(name, import.meta.url));
export default defineConfig({
  publicDir: false,
  resolve: { alias: { '@': path('./') } },
  build: {
    ssr: path('./lib/service-topology/cli.ts'),
    outDir: '.service-topology',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'publisher.mjs', format: 'es' } },
  },
});
