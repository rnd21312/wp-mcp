import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The folder that holds index.js (or index.ts): `src` in development, `dist` when built.
 * Build output such as dist/panel, dist/agent and dist/plugin sits directly inside it.
 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
