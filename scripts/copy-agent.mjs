// Copies the Host Agent sources next to the built gateway so the Studio can hand out wpm-agent.zip.
import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const to = join(root, 'gateway', 'dist', 'agent');
rmSync(to, { recursive: true, force: true });
cpSync(join(root, 'agent', 'wpm-agent'), to, { recursive: true, filter: (p) => !/[\\/](data|data-location\.php|wpm-setup\.php)$/.test(p) });
console.log(`agent -> ${to}`);
const plugin = join(root, 'gateway', 'dist', 'plugin');
rmSync(plugin, { recursive: true, force: true });
cpSync(join(root, 'plugin', 'wp-mcp-bridge'), plugin, { recursive: true });
console.log(`bridge -> ${plugin}`);
