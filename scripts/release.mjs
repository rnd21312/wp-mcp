// Builds the release files in dist/ and signs the agent:
//   dist/wpm-agent.zip + dist/wpm-agent.zip.sig   (the exact bytes the Studio sends for self-updates)
//   dist/wp-mcp-bridge.zip
//   dist/SHA256SUMS
// Usage: WPM_RELEASE_KEY=<path to wpm-release-private.pem> npm run release
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const run = (script) => {
  const r = spawnSync(process.execPath, [join(root, 'scripts', script)], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('sync-spec.mjs');
run('package-plugin.mjs');
run('package-agent.mjs');

const keyPath = process.env.WPM_RELEASE_KEY;
const version = /const VERSION = '([^']+)'/.exec(readFileSync(join(root, 'agent', 'wpm-agent', 'src', 'Agent.php'), 'utf8'))[1];
writeFileSync(join(dist, 'wpm-agent.version'), `${version}
`);
const agentZip = readFileSync(join(dist, 'wpm-agent.zip'));
const sums = [];
const add = (file) => sums.push(`${createHash('sha256').update(readFileSync(join(dist, file))).digest('hex')}  ${file}`);
add('wpm-agent.zip');
add('wp-mcp-bridge.zip');

if (keyPath && existsSync(keyPath)) {
  const key = createPrivateKey(readFileSync(keyPath));
  // Same message the agent verifies: "wpm-agent-update\n" + sha256 hex of the zip.
  const message = Buffer.from(`wpm-agent-update\n${createHash('sha256').update(agentZip).digest('hex')}`);
  writeFileSync(join(dist, 'wpm-agent.zip.sig'), sign(null, message, key).toString('base64'));
  add('wpm-agent.zip.sig');
  console.log('Agent signed.');
} else {
  console.warn('WPM_RELEASE_KEY not set: the agent zip is NOT signed, so agents cannot self-update to this build.');
}
writeFileSync(join(dist, 'SHA256SUMS'), sums.join('\n') + '\n');

// The Studio ships the signed zip next to itself and sends exactly these bytes when asked to update an agent.
const release = join(root, 'gateway', 'dist', 'agent-release');
mkdirSync(release, { recursive: true });
cpSync(join(dist, 'wpm-agent.zip'), join(release, 'wpm-agent.zip'));
if (existsSync(join(dist, 'wpm-agent.zip.sig'))) cpSync(join(dist, 'wpm-agent.zip.sig'), join(release, 'wpm-agent.zip.sig'));
cpSync(join(dist, 'wpm-agent.version'), join(release, 'wpm-agent.version'));
console.log(`Release files in ${dist}\n${sums.join('\n')}`);
