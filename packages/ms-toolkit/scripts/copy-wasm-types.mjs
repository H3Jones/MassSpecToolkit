import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const generatedTypes = new URL('../src/generated/wasm/ms_wasm.d.ts', import.meta.url);
const publishedTypes = new URL('../dist/generated/wasm/ms_wasm.d.ts', import.meta.url);

mkdirSync(fileURLToPath(new URL('.', publishedTypes)), { recursive: true });
copyFileSync(fileURLToPath(generatedTypes), fileURLToPath(publishedTypes));
