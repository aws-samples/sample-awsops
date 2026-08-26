import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts', 'app/**/*.test.tsx', 'components/**/*.test.tsx'],
  },
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: { '@': new URL('.', import.meta.url).pathname.replace(/\/$/, '') },
  },
});
