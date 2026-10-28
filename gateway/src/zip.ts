import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Builds a zip in memory (deflate). Names use forward slashes; no external tools needed. */
export function createZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const packed = deflateRawSync(entry.data);
    const crc = crc32(entry.data) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    parts.push(header, name, packed);
    const row = Buffer.alloc(46);
    row.writeUInt32LE(0x02014b50, 0);
    row.writeUInt16LE(20, 4);
    row.writeUInt16LE(20, 6);
    row.writeUInt16LE(0x0800, 8);
    row.writeUInt16LE(8, 10);
    row.writeUInt32LE(crc, 16);
    row.writeUInt32LE(packed.length, 20);
    row.writeUInt32LE(entry.data.length, 24);
    row.writeUInt16LE(name.length, 28);
    row.writeUInt32LE(offset, 42);
    central.push(row, name);
    offset += header.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, dir, end]);
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.idea', '.vscode', '.next', '.nuxt', '.cache', '.turbo']);
const SKIP_FILES = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\.env(\..*)?|\.wpm-project\.json)$/i;

export interface DirZip {
  buffer: Buffer;
  files: number;
  bytes: number;
}

/** Zips a folder's contents (not the folder itself). Links, junk and secrets are left out. */
export function zipDirectory(dir: string, limits = { files: 20000, bytes: 400 * 1024 * 1024 }): DirZip {
  const entries: ZipEntry[] = [];
  let bytes = 0;
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
        continue;
      }
      if (!info.isFile() || SKIP_FILES.test(name)) continue;
      bytes += info.size;
      if (entries.length >= limits.files || bytes > limits.bytes) throw new Error('The project is too large to deploy (over 20,000 files or 400 MB). Remove build leftovers or large media.');
      entries.push({ name: relative(dir, full).split(sep).join('/'), data: readFileSync(full) });
    }
  };
  walk(dir);

  return { buffer: createZip(entries), files: entries.length, bytes };
}
