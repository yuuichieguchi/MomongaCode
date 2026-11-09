import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UNMEASURED_CAPABILITY, createLockCapability, createMarker } from '@momonga/foundation';
import type { LockCapabilityProbe, MarkerHandle } from '@momonga/foundation';

const created: string[] = [];
const handles: MarkerHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-marker-ro-')));
  created.push(dir);
  return dir;
};

const writeCode = (fd: number): string => {
  try {
    fs.writeSync(fd, 'g0000000001\n');
    return 'written';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'unknown';
  }
};

const capabilities: Array<[string, (proofDir: string) => LockCapabilityProbe]> = [
  ['listed', () => UNMEASURED_CAPABILITY],
  ['locked', (proofDir) => createLockCapability({ proofDir })],
];

describe.each(capabilities)('the descriptor createMarker hands to a spawn (%s marker)', (_mode, capabilityFor) => {
  it('is read-only: a write through it fails with EBADF and the marker keeps its empty attempt record', async () => {
    const dir = tempDir();
    const proofDir = path.join(dir, 'proof');
    fs.mkdirSync(proofDir, { mode: 0o700 });
    const marker = path.join(dir, 'call-1');
    const handle = await createMarker(marker, { capability: capabilityFor(proofDir) });
    handles.push(handle);
    expect(writeCode(handle.fd)).toBe('EBADF');
    expect(fs.readFileSync(marker, 'utf8')).toBe('r00000\n');
  });
});
