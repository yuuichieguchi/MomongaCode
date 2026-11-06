import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLockCapability } from '../../src/platform/lock-capability.ts';
import { createMarker } from '../../src/platform/marker-file.ts';
import { RETRY_KINDS, claimRetry, markIgnored, parseAttemptRecord } from '../../src/platform/marker-record.ts';
import type { RecordFiles } from '../../src/platform/marker-record.ts';
import { fixedCapability } from '../support/probe-fakes.ts';
import { makeTemporaryDirectory } from '../support/temporary-directory.ts';

const live = () => ({ signal: new AbortController().signal });

const NONE_SPENT = { spent: { guard: false, sweep: false, startup: false, shutdown: false }, ignored: false };
const ALL_SPENT = { spent: { guard: true, sweep: true, startup: true, shutdown: true }, ignored: false };

const markerIn = async (content?: string): Promise<string> => {
  const marker = path.join(makeTemporaryDirectory(), 'marker');
  if (content === undefined) (await createMarker(marker, { capability: fixedCapability('unenforced') })).close();
  else fs.writeFileSync(marker, content);
  return marker;
};

const children: Array<ReturnType<typeof spawn>> = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

describe('T17 the attempt record in the marker file (decision 12)', () => {
  it('the four kinds of retry are the events of the model, in the record order', () => {
    expect(RETRY_KINDS).toEqual(['guard', 'sweep', 'startup', 'shutdown']);
  });

  it('createMarker writes r00000 and a newline in the open that creates the file', async () => {
    expect(fs.readFileSync(await markerIn(), 'utf8')).toBe('r00000\n');
  });

  it('(e) the seven-byte form is read byte by byte; empty content is r00000; anything else is all four spent and not ignored', () => {
    expect(parseAttemptRecord('r00000\n')).toEqual(NONE_SPENT);
    expect(parseAttemptRecord('r10101\n')).toEqual({ spent: { guard: true, sweep: false, startup: true, shutdown: false }, ignored: true });
    expect(parseAttemptRecord('')).toEqual(NONE_SPENT);
    for (const corrupt of ['r0000\n', 'r000000\n', 'r00000', 'x00000\n', 'r00200\n', 'r00000\nr', '42\n']) expect(parseAttemptRecord(corrupt)).toEqual(ALL_SPENT);
  });

  it('(a) each kind is claimed once in the life of the file; the fifth claim of any kind is spent', async () => {
    const marker = await markerIn();
    for (const kind of RETRY_KINDS) expect(await claimRetry(marker, kind, live())).toBe('claimed');
    for (const kind of RETRY_KINDS) expect(await claimRetry(marker, kind, live())).toBe('spent');
    expect(fs.readFileSync(marker, 'utf8')).toBe('r11110\n');
  });

  it('(b) two claims of the same kind at once: exactly one is claimed', async () => {
    const marker = await markerIn();
    const outcomes = await Promise.all([claimRetry(marker, 'guard', live()), claimRetry(marker, 'guard', live())]);
    expect(outcomes.sort()).toEqual(['claimed', 'spent']);
  });

  it('(c) a write that fails claims nothing and leaves the record unchanged', async () => {
    const marker = await markerIn();
    const failing: RecordFiles = {
      read: (file: string) => fs.promises.readFile(file, 'utf8'),
      writeByte: async () => {
        throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
      },
    };
    expect(await claimRetry(marker, 'sweep', { ...live(), files: failing })).toBe('failed');
    expect(fs.readFileSync(marker, 'utf8')).toBe('r00000\n');
  });

  it('(c) the byte is written in place: the inode is unchanged', async () => {
    const marker = await markerIn();
    const before = fs.statSync(marker).ino;
    await claimRetry(marker, 'startup', live());
    expect(fs.statSync(marker).ino).toBe(before);
    expect(fs.readFileSync(marker, 'utf8')).toBe('r00100\n');
  });

  it('(d) markIgnored sets the fifth byte and nothing else', async () => {
    const marker = await markerIn('r10000\n');
    await markIgnored(marker, live());
    expect(fs.readFileSync(marker, 'utf8')).toBe('r10001\n');
  });

  it.runIf(process.platform === 'darwin')('(h) a one-byte in-place write succeeds on a marker locked by another process', async () => {
    const root = makeTemporaryDirectory();
    const proofDir = path.join(root, 'lock-proof');
    fs.mkdirSync(proofDir);
    const capability = createLockCapability({ proofDir });
    const marker = path.join(root, 'held');
    const handle = await createMarker(marker, { capability });
    expect(handle.mode).toBe('locked');
    const child = spawn('/bin/sleep', ['30'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
    children.push(child);
    await new Promise((resolve) => child.once('spawn', resolve));
    handle.close();
    expect(await claimRetry(marker, 'guard', live())).toBe('claimed');
    expect(fs.readFileSync(marker, 'utf8')).toBe('r10000\n');
  });
});
