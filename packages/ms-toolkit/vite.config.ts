import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  server: {
    fs: {
      allow: [fileURLToPath(new URL('../..', import.meta.url))],
    },
  },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    lib: {
      formats: ['es'],
      entry: {
        index: src('index.ts'),
        core: src('core/index.ts'),
        'ion-calculator': src('elements/ion-calculator.ts'),
        'mass-split': src('elements/mass-split.ts'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
  lint: {
    ignorePatterns: ['dist/**'],
  },
});
