import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { immediateTx, modeIsPrivate, sha256Hex, syncDirectorySync, uuidv7 } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { readerFor } from './rows.ts';
import type { BlobByteRange, BlobByteSlice, BlobLineRange, BlobRef, BlobScope, BlobSlice, BlobStore } from './types.ts';

const BLOB_DIRECTORY_MODE = 0o700;
const BLOB_FILE_MODE = 0o600;
const HANDLE_PATTERN = /^[0-9a-f]{64}$/;
const NEWLINE = 0x0a;

export const prepareBlobDirectory = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true, mode: BLOB_DIRECTORY_MODE });
  const stat = fs.statSync(dir);
  if (!modeIsPrivate(stat, 'directory')) {
    throw new Error(`blob directory ${dir} has mode ${(stat.mode & 0o777).toString(8).padStart(4, '0')} but must be 0700; run: chmod 700 ${dir}`);
  }
};

const handleOfBytes = (bytes: Uint8Array): string => sha256Hex(bytes);

const countLines = (bytes: Uint8Array): number => {
  if (bytes.length === 0) return 0;
  let newlines = 0;
  for (const byte of bytes) if (byte === NEWLINE) newlines += 1;
  return bytes[bytes.length - 1] === NEWLINE ? newlines : newlines + 1;
};

const assertUtf8 = (bytes: Uint8Array): void => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TypeError('blobs hold text only: content is not valid UTF-8', { cause: error });
  }
};

const writeAtomically = (dir: string, target: string, bytes: Uint8Array, clock: Clock): void => {
  const temp = path.join(dir, `.tmp-${uuidv7(clock)}`);
  try {
    const fd = fs.openSync(temp, 'wx', BLOB_FILE_MODE);
    try {
      fs.fchmodSync(fd, BLOB_FILE_MODE);
      let written = 0;
      while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  syncDirectorySync(dir);
};

const holdsContent = (target: string, sha256: string, byteLength: number): boolean => {
  if (!fs.existsSync(target)) return false;
  if (fs.statSync(target).size !== byteLength) return false;
  return sha256Hex(fs.readFileSync(target)) === sha256;
};

const readLines = async (file: string, lineStart: number, lineEnd: number): Promise<string> => {
  const stream = fs.createReadStream(file);
  const kept: Buffer[] = [];
  let line = 1;
  try {
    for await (const chunk of stream) {
      const buffer: Buffer = chunk;
      let position = 0;
      while (position < buffer.length) {
        const newline = buffer.indexOf(NEWLINE, position);
        const end = newline === -1 ? buffer.length : newline + 1;
        if (line >= lineStart) kept.push(buffer.subarray(position, end));
        position = end;
        if (newline !== -1) {
          if (line === lineEnd) return Buffer.concat(kept).toString('utf8');
          line += 1;
        }
      }
    }
    return Buffer.concat(kept).toString('utf8');
  } finally {
    stream.destroy();
  }
};

const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

const sequenceLength = (lead: number): number => {
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc0) return 2;
  return 1;
};

const alignedStart = (buffer: Buffer): number => {
  let start = 0;
  while (start < buffer.length && isContinuation(buffer.readUInt8(start))) start += 1;
  return start;
};

const characterSpan = (buffer: Buffer, windowLength: number): { start: number; end: number } => {
  const start = alignedStart(buffer);
  if (start >= buffer.length) return { start: buffer.length, end: buffer.length };
  let end = start + sequenceLength(buffer.readUInt8(start));
  const limit = Math.min(windowLength, buffer.length);
  while (end < limit) end += sequenceLength(buffer.readUInt8(end));
  if (end > buffer.length) throw new Error('blob ends inside a multi-byte character');
  return { start, end };
};

const MAX_CHARACTER_OVERRUN = 7;

const readBytes = (file: string, handle: string, offset: number, length: number, totalBytes: number): Buffer => {
  const wanted = Math.max(0, Math.min(length + MAX_CHARACTER_OVERRUN, totalBytes - offset));
  const buffer = Buffer.alloc(wanted);
  const fd = fs.openSync(file, 'r');
  try {
    let filled = 0;
    while (filled < wanted) {
      const read = fs.readSync(fd, buffer, filled, wanted - filled, offset + filled);
      if (read === 0) throw new Error(`blob ${handle} is shorter than its recorded length ${totalBytes}`);
      filled += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return buffer;
};

const assertNonNegativeInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`blob range ${name} must be a non-negative integer, got ${value}`);
};

export const blobDirectoryOf = (databasePath: string): string => path.join(path.dirname(databasePath), 'blobs');

export const createBlobStore = (db: DatabaseSync, clock: Clock, dir: string): BlobStore => {
  const insert = db.prepare(
    `INSERT INTO blobs (sha256, byte_length, line_count, media_type, created_at)
     VALUES (:sha256, :byteLength, :lineCount, :mediaType, :createdAt)
     ON CONFLICT (sha256) DO NOTHING`,
  );
  const select = db.prepare('SELECT * FROM blobs WHERE sha256 = :sha256');
  const own = db.prepare('INSERT OR IGNORE INTO blob_owners (sha256, run_id) VALUES (:sha256, :runId)');
  const readableBy = db.prepare(
    `SELECT 1 AS readable FROM blob_owners o
     JOIN runs owner ON owner.id = o.run_id
     JOIN runs reader ON reader.id = :runId
     WHERE o.sha256 = :sha256 AND owner.session_id = reader.session_id LIMIT 1`,
  );

  const locate = (handle: string, scope: BlobScope | undefined): { file: string; totalBytes: number; totalLines: number } => {
    if (!HANDLE_PATTERN.test(handle)) throw new Error(`invalid blob handle "${handle}": expected a 64-character lowercase hex sha256`);
    const row = select.get({ sha256: handle });
    if (row === undefined || (scope !== undefined && readableBy.get({ sha256: handle, runId: scope.runId }) === undefined)) {
      throw Object.assign(new Error(`unknown blob ${handle}`), { code: 'BLOB_NOT_FOUND' });
    }
    const reader = readerFor('blobs', handle, row);
    return { file: path.join(dir, handle), totalBytes: reader.number('byte_length'), totalLines: reader.number('line_count') };
  };

  async function read(handle: string, range: BlobLineRange, scope?: BlobScope): Promise<BlobSlice>;
  async function read(handle: string, range: BlobByteRange, scope?: BlobScope): Promise<BlobByteSlice>;
  async function read(handle: string, range: BlobLineRange | BlobByteRange, scope?: BlobScope): Promise<BlobSlice | BlobByteSlice> {
    const { file, totalBytes, totalLines } = locate(handle, scope);
    if ('lineStart' in range) {
      if (!Number.isInteger(range.lineStart) || range.lineStart < 1 || !Number.isInteger(range.lineEnd) || range.lineEnd < range.lineStart) {
        throw new RangeError(`blob line range must satisfy 1 <= lineStart <= lineEnd, got ${range.lineStart}..${range.lineEnd}`);
      }
      return { text: await readLines(file, range.lineStart, range.lineEnd), totalLines, totalBytes };
    }
    assertNonNegativeInteger('offset', range.offset);
    assertNonNegativeInteger('length', range.length);
    if (range.length === 0) return { text: '', totalLines, totalBytes, offset: range.offset, length: 0 };
    const raw = readBytes(file, handle, range.offset, range.length, totalBytes);
    const { start, end } = characterSpan(raw, range.length);
    return {
      text: raw.subarray(start, end).toString('utf8'),
      totalLines,
      totalBytes,
      offset: range.offset + start,
      length: end - start,
    };
  }

  return {
    handleFor: (content) => handleOfBytes(Buffer.from(content, 'utf8')),
    put: (data, options) => {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      assertUtf8(bytes);
      const sha256 = handleOfBytes(bytes);
      const target = path.join(dir, sha256);
      if (!holdsContent(target, sha256, bytes.length)) writeAtomically(dir, target, bytes, clock);
      const lineCount = countLines(bytes);
      immediateTx(db, () => {
        insert.run({ sha256, byteLength: bytes.length, lineCount, mediaType: options.mediaType, createdAt: clock.now() });
        if (options.runId !== undefined) own.run({ sha256, runId: options.runId });
      });
      return { handle: sha256, sha256, byteLength: bytes.length, lineCount } satisfies BlobRef;
    },
    read,
  };
};
