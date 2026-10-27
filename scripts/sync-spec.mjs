// Rebuilds spec/ops.json and copies it to the gateway and the plugin so both sides share one definition.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = spawnSync(process.execPath, [join(root, 'spec', 'build-spec.mjs')], { stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
mkdirSync(join(root, 'gateway', 'src', 'generated'), { recursive: true });
copyFileSync(join(root, 'spec', 'ops.json'), join(root, 'gateway', 'src', 'generated', 'ops.json'));
copyFileSync(join(root, 'spec', 'ops.json'), join(root, 'plugin', 'wp-mcp-bridge', 'ops.json'));
