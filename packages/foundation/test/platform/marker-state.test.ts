import { spawn } from '@momonga/testkit/child-process';
import type { ChildProcess } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLockCapability } from '../../src/platform/lock-capability.ts';
import type { LockCapabilityProbe } from '../../src/platform/lock-capability.ts';
import { createMarker } from '../../src/platform/marker-file.ts';
import { hostProcessInspector, hostInspectorPorts } from '../../src/platform/process-inspector.ts';
import { makeTemporaryDirectory } from '../support/temporary-directory.ts';
import { exclusiveProbeIsRefused, fixedCapability, sharedProbeIsRefused, throwingRunner } from '../support/probe-fakes.ts';
import { testLocks } from '@momonga/testkit';

const live = () => ({ signal: new AbortController().signal });

const markerDirectory = () => {
  const root = makeTemporaryDirectory();
  const proofDir = path.join(root, 'run', 'lock-proof');
  const markerDir = path.join(root, 'run', 'markers', 'tools');
  fs.mkdirSync(proofDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(markerDir, { recursive: true });
  return { proofDir, markerDir };
};

const lockedInspector = (capability: LockCapabilityProbe) => hostProcessInspector({ ...hostInspectorPorts(testLocks().capability), run: throwingRunner(), capability });

const PROBER = `
const fs = require('node:fs');
const [file, mode] = process.argv.slice(1);
const flags = fs.constants.O_RDONLY | 0x10 | fs.constants.O_NONBLOCK;
if (mode === 'hold') {
  fs.openSync(file, flags);
  process.stdout.write('holding\\n');
  setInterval(() => undefined, 1000);
} else {
  const names = JSON.parse(file);
  process.stdout.write('probing\\n');
  for (;;) for (const name of names) { try { fs.closeSync(fs.openSync(name, flags)); } catch {} }
}
`;

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
});

const startProber = async (argument: string, mode: 'loop' | 'hold'): Promise<ChildProcess> => {
  const child = spawn(process.execPath, ['-e', PROBER, argument, mode], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.once('data', () => resolve());
  });
  return child;
};

describe.runIf(process.platform === 'darwin')('T7 concurrent probes and marker creation on a proved directory', () => {
  it('(a) two probes started at once agree: free on a free marker and held on a held one, 200 times', async () => {
    const { proofDir, markerDir } = markerDirectory();
    const capability = createLockCapability({ proofDir });
    expect(await capability.of(markerDir)).toBe('proved');
    const inspector = lockedInspector(capability);
    const held = await createMarker(path.join(markerDir, 'held'), { capability });
    const released = await createMarker(path.join(markerDir, 'free'), { capability });
    released.close();
    try {
      for (let round = 0; round < 200; round += 1) {
        expect(await Promise.all([inspector.markerState(path.join(markerDir, 'free'), live()), inspector.markerState(path.join(markerDir, 'free'), live())])).toEqual(['free', 'free']);
        expect(await Promise.all([inspector.markerState(path.join(markerDir, 'held'), live()), inspector.markerState(path.join(markerDir, 'held'), live())])).toEqual(['held', 'held']);
      }
    } finally {
      held.close();
    }
  });

  it('(b) creation never waits for a probe: fresh names are created at once while another process probes them, and a probe before spawn reads held', async () => {
    const { proofDir, markerDir } = markerDirectory();
    const capability = createLockCapability({ proofDir });
    const inspector = lockedInspector(capability);
    const names = Array.from({ length: 40 }, (_unused, index) => path.join(markerDir, `call-${index}`));
    await startProber(JSON.stringify(names), 'loop');
    for (const name of names) {
      const handle = await createMarker(name, { capability });
      try {
        expect(handle.mode).toBe('locked');
        expect(sharedProbeIsRefused(name)).toBe(true);
        expect(await inspector.markerState(name, live())).toBe('held');
      } finally {
        handle.close();
      }
    }
  });

  it('(b) a prober stalled with SIGSTOP while it holds a shared lock on an older marker does not delay creating other markers', async () => {
    const { proofDir, markerDir } = markerDirectory();
    const capability = createLockCapability({ proofDir });
    const older = path.join(markerDir, 'older');
    (await createMarker(older, { capability })).close();
    const prober = await startProber(older, 'hold');
    prober.kill('SIGSTOP');
    try {
      expect(exclusiveProbeIsRefused(older)).toBe(true);
      for (let index = 0; index < 10; index += 1) {
        const handle = await createMarker(path.join(markerDir, `fresh-${index}`), { capability });
        expect(handle.mode).toBe('locked');
        handle.close();
      }
      expect(prober.exitCode).toBeNull();
    } finally {
      prober.kill('SIGCONT');
    }
  });

  it('(c) a prober killed with SIGKILL while holding its shared lock leaves no lock behind', async () => {
    const { proofDir, markerDir } = markerDirectory();
    const capability = createLockCapability({ proofDir });
    const inspector = lockedInspector(capability);
    const older = path.join(markerDir, 'older');
    (await createMarker(older, { capability })).close();
    const prober = await startProber(older, 'hold');
    const exited = new Promise<void>((resolve) => prober.once('exit', () => resolve()));
    prober.kill('SIGKILL');
    await exited;
    expect(await inspector.markerState(older, live())).toBe('free');
    const later = await createMarker(path.join(markerDir, 'later'), { capability });
    expect(later.mode).toBe('locked');
    later.close();
  });
});

describe('T7 (d) a directory that is not proved gets a plain marker without a lock', () => {
  it.for(['unenforced', 'unmeasured'] as const)('on a %s directory createMarker makes a plain exclusive file whose descriptor holds no lock', async (answer) => {
    const { markerDir } = markerDirectory();
    const name = path.join(markerDir, 'plain');
    const handle = await createMarker(name, { capability: fixedCapability(answer) });
    try {
      expect(handle.mode).toBe('listed');
      expect(fs.existsSync(name)).toBe(true);
      expect(sharedProbeIsRefused(name)).toBe(false);
      expect(exclusiveProbeIsRefused(name)).toBe(false);
    } finally {
      handle.close();
    }
    await expect(createMarker(name, { capability: fixedCapability(answer) })).rejects.toMatchObject({ code: 'EEXIST' });
  });
});

describe('T13 the marker handle owns the descriptor', () => {
  it('close is idempotent and releases the descriptor', async () => {
    const { markerDir } = markerDirectory();
    const handle = await createMarker(path.join(markerDir, 'owned'), { capability: fixedCapability('unenforced') });
    const { fd } = handle;
    expect(fs.fstatSync(fd).isFile()).toBe(true);
    handle.close();
    handle.close();
    expect(() => fs.fstatSync(fd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });
});
