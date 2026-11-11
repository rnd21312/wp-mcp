import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, sep } from 'node:path';
import type { Principal } from '../auth/auth.ts';
import type { App } from '../core/context.ts';
import type { CallResult } from '../sites/wpclient.ts';

/**
 * Files from the computer that runs the gateway ("local_path"), for the AI apps that start it themselves (stdio).
 * The bytes go from disk to the site; they never pass through the model.
 *
 * A model can be talked into things by text it reads on a site, so this is the one place where a site could try
 * to pull files off this computer. Hence: stdio connections only, a short list of folders, and no dot files,
 * keys, databases or config files, whatever the folder.
 */

/** One call carries this much; larger files travel in pieces. */
export const PIECE_BYTES = 1_400_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const BATCH_MAX_BYTES = 6 * 1024 * 1024;
const PRIVATE_NAME =
  /(^|[._-])id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p12|pfx|jks|kdbx|sqlite|sqlite-wal|sqlite-shm|db)$|^master\.key$|^wp-config|credential|secret|password|\.env/i;

export class UploadError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (file: string, dir: string): boolean => same(file.slice(0, dir.length + 1), dir + sep);

/** The real path and size of a local file the connection may send, or an error that says why not. */
export function localFile(app: App, principal: Principal, raw: unknown): { path: string; size: number } {
  if (principal.kind !== 'stdio') {
    throw new UploadError(
      'not_local',
      'local_path only works for an AI app running on the same computer as the gateway (stdio). From elsewhere, send content or data_base64, or use files.fetch with an https URL.',
    );
  }
  if (typeof raw !== 'string' || raw.trim() === '') throw new UploadError('bad_arguments', 'local_path must be a file path.');
  let path: string;
  let size: number;
  try {
    path = realpathSync(raw.trim());
    const info = statSync(path);
    if (!info.isFile()) throw new Error('not a file');
    size = info.size;
  } catch {
    throw new UploadError('not_found', `No file at ${raw}.`);
  }
  const dirs = app.config.uploadDirs.flatMap((dir) => {
    try {
      return [realpathSync(dir)];
    } catch {
      return [];
    }
  });
  if (!dirs.some((dir) => inside(path, dir))) {
    throw new UploadError(
      'outside_upload_dirs',
      `That file is outside the folders this gateway may upload from: ${dirs.join(', ') || '(none)'}. Move it there, or add its folder to WPMCP_UPLOAD_DIRS.`,
    );
  }
  if (path.split(sep).some((part) => part.startsWith('.')) || PRIVATE_NAME.test(basename(path))) {
    throw new UploadError('private_file', 'Dot files, keys, databases and config files are never uploaded.');
  }
  return { path, size };
}

const read64 = (path: string): string => readFileSync(path).toString('base64');

/**
 * Replaces local_path by the file's bytes where one call can carry them. A larger files.write keeps local_path
 * (now the checked real path) and is sent in pieces by sendInPieces.
 */
export function expandLocal(app: App, principal: Principal, opId: string, args: Record<string, unknown>): Record<string, unknown> {
  if (opId === 'files.write_many' && Array.isArray(args.files) && args.files.some((f) => f && typeof f === 'object' && 'local_path' in f)) {
    let total = 0;
    const files = (args.files as Record<string, unknown>[]).map((item) => {
      if (!item || typeof item !== 'object' || item.local_path === undefined) return item;
      const file = localFile(app, principal, item.local_path);
      total += file.size;
      if (total > BATCH_MAX_BYTES)
        throw new UploadError(
          'too_large',
          'The local files of one write_many call are limited to 6 MB together. Send big files one by one with files.write and local_path.',
        );
      const { local_path: _from, ...rest } = item;
      return { path: basename(file.path), ...rest, data_base64: read64(file.path) };
    });
    return { ...args, files };
  }
  if (args.local_path === undefined || (opId !== 'files.write' && opId !== 'media.upload')) return args;
  const file = localFile(app, principal, args.local_path);
  const { local_path: _from, ...rest } = args;
  if (opId === 'media.upload') {
    if (file.size > MEDIA_MAX_BYTES)
      throw new UploadError(
        'too_large',
        'media.upload takes up to 10 MB. For a bigger file use files.write with root "uploads" and local_path, then media.register.',
      );
    return { filename: basename(file.path), ...rest, data_base64: read64(file.path) };
  }
  if (file.size > MAX_BYTES) throw new UploadError('too_large', 'Uploads are limited to 64 MB.');
  const withPath = { path: basename(file.path), ...rest };
  return file.size <= PIECE_BYTES ? { ...withPath, data_base64: read64(file.path) } : { ...withPath, local_path: file.path };
}

/** True when this files.write is a large local file that travels in pieces. */
export const inPieces = (opId: string, args: Record<string, unknown>): boolean =>
  opId === 'files.write' && typeof args.local_path === 'string';

export function piecesPreview(args: Record<string, unknown>): Record<string, unknown> {
  const size = statSync(String(args.local_path)).size;
  return { will_upload: args.path, root: args.root, from: args.local_path, bytes: size, pieces: Math.ceil(size / PIECE_BYTES) };
}

type Send = (op: string, args: Record<string, unknown>) => Promise<CallResult>;

/** Sends a large local file piece by piece; the site puts it in place on the last one. */
export async function sendInPieces(args: Record<string, unknown>, send: Send): Promise<CallResult> {
  const path = String(args.local_path);
  const size = statSync(path).size;
  const upload = randomBytes(8).toString('hex');
  const fd = openSync(path, 'r');
  try {
    let offset = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(PIECE_BYTES, size - offset));
      readSync(fd, buffer, 0, buffer.length, offset);
      const last = offset + buffer.length >= size;
      const result = await send('files.upload_part', {
        root: args.root,
        path: args.path,
        upload,
        offset,
        last,
        data_base64: buffer.toString('base64'),
      });
      if (last) return result;
      offset += buffer.length;
    }
  } finally {
    closeSync(fd);
  }
}
