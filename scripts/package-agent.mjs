// Builds dist/wpm-agent.zip: the Host Agent, ready to upload to any PHP 8.1+ hosting.
// The setup code is generated on the host at first run (the Studio builds its own zip with the code baked in).
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'agent', 'wpm-agent');
const SKIP = new Set(['data', 'data-location.php', 'wpm-setup.php', '.DS_Store']);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    statSync(full).isDirectory() ? walk(full) : files.push(full);
  }
};
walk(src);

const parts = [];
const central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from('wpm-agent/' + relative(src, file).split(sep).join('/'));
  const data = readFileSync(file);
  const packed = deflateRawSync(data);
  const crc = crc32(data) >>> 0;
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(packed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  parts.push(header, name, packed);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(packed.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);
  offset += header.length + name.length + packed.length;
}
const dir = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(dir.length, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', 'wpm-agent.zip');
writeFileSync(out, Buffer.concat([...parts, dir, end]));
console.log(`${out}: ${files.length} files`);
