// Creates the Ed25519 key pair that signs agent updates.
//   npm run release:keygen -- <folder outside this repository>
// The PRIVATE key is written to that folder (keep it offline and backed up; whoever has it can push updates to every agent).
// The PUBLIC key is written into agent/wpm-agent/src/UpdateKey.php; commit it and ship that build.
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const target = process.argv[2];
if (!target) {
  console.error('Usage: npm run release:keygen -- <folder outside the repository for the private key>');
  process.exit(1);
}
const folder = resolve(target);
const rel = relative(root, folder);
if (!rel.startsWith('..') && !rel.startsWith('/') && !/^[a-zA-Z]:/.test(rel)) {
  console.error('Refusing: the private key must not live inside the repository.');
  process.exit(1);
}
const keyFile = join(folder, 'wpm-release-private.pem');
if (existsSync(keyFile)) {
  console.error(`Refusing to overwrite ${keyFile}. Move it away first if you really want a new key.`);
  process.exit(1);
}
mkdirSync(folder, { recursive: true });
const { privateKey } = generateKeyPairSync('ed25519');
writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
try {
  chmodSync(keyFile, 0o600);
} catch {
  /* not supported on this file system */
}
const spki = createPublicKey(createPrivateKey(readFileSync(keyFile))).export({ type: 'spki', format: 'der' });
const raw = spki.subarray(spki.length - 32).toString('base64');
const phpFile = join(root, 'agent', 'wpm-agent', 'src', 'UpdateKey.php');
writeFileSync(phpFile, `<?php\ndeclare(strict_types=1);\n\ndefined('WPM_AGENT') || exit;\n\n// Public key (base64, 32 bytes, Ed25519) that agent updates must be signed with.\n// Empty = signed self-update is disabled. Create the pair with: npm run release:keygen -- <path outside this repository>\nreturn '${raw}';\n`);
console.log(`Private key: ${keyFile}  (back it up; never commit it)\nPublic key written to ${phpFile}\n${raw}`);
