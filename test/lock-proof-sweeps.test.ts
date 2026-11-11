import { spawn } from '@momonga/testkit/child-process';
import type { ChildProcess } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJsonLogger, ensureMomongaDirs, momongaLayout, reapDeadGenerations, reapMarkerDirectory, sleep, systemTiming } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { withTempDir, sleepDrivenTiming, testProcessInspector, testKernelLock } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { reapOrphans } from '@momonga/supervisor';
import { createMarkerOwners } from '@momonga/tools';
import { reapToolMarkers } from '../packages/runtime/src/process/tool-markers.ts';

const O_EXLOCK = 0x20;
const CREATE_LOCKED = fs.constants.O_RDONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_EXLOCK | fs.constants.O_NONBLOCK;

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

const layout = async (context: CleanupContext): Promise<MomongaPaths & { lockProof?: string }> => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaLayout(home, process.platform, {}) as MomongaPaths & { lockProof?: string };
  await ensureMomongaDirs(paths);
  return paths;
};

const proofDirOf = (paths: MomongaPaths & { lockProof?: string }): string => {
  expect(paths.lockProof).toBe(path.join(paths.run, 'lock-proof'));
  return paths.lockProof as string;
};

const PROVER = `
const fs = require('node:fs');
fs.openSync(process.argv[1], ${CREATE_LOCKED}, 0o600);
process.stdout.write('proving\\n');
setInterval(() => undefined, 1000);
`;

const startProver = async (proof: string): Promise<ChildProcess> => {
  const child = spawn(process.execPath, ['-e', PROVER, proof], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.once('data', () => resolve());
  });
  return child;
};

const recordingKill = () => {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  return {
    sent,
    kill: (target: number, signal: NodeJS.Signals | 0): void => {
      if (signal !== 0) sent.push([target, signal]);
      process.kill(target, 0);
    },
  };
};

const sweepEverything = async (paths: MomongaPaths, kill: (target: number, signal: NodeJS.Signals | 0) => void): Promise<string[]> => {
  const warnings: string[] = [];
  const onWarning = (message: string): void => void warnings.push(message);
  await reapToolMarkers({ inspector: testProcessInspector(), event: 'startup', owners: createMarkerOwners(), dir: paths.markers.tools, store: { idempotency: { get: () => undefined }, getRun: () => undefined } as never, killGraceMs: 100, onWarning });
  await reapToolMarkers({ inspector: testProcessInspector(), event: 'sweep', owners: createMarkerOwners(), dir: paths.markers.tools, store: { idempotency: { get: () => undefined }, getRun: () => undefined } as never, killGraceMs: 100, onWarning });
  for (const dir of [paths.markers.mcp, paths.markers.targets, paths.markers.daemons]) {
    await reapMarkerDirectory({ inspector: testProcessInspector(), dir, signal: new AbortController().signal, killGraceMs: 100, label: 'sweep', onWarning, kill: kill as never });
  }
  const timers = { setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };
  await reapOrphans({
    inspector: testProcessInspector(),
    markersDir: paths.markers.daemons,
    orphanGraceMs: 100,
    orphanReapGraceMs: 100,
    orphanPollMs: 25,
    timers: timers as never,
    signal: new AbortController().signal,
    logger: createJsonLogger({ service: 'supervisor', clock: { now: () => Date.now() }, stream: { write: () => true } as never } as never),
    reapTiming: sleepDrivenTiming({
      now: () => Date.now(),
      sleep: async (ms) => {
        await sleep(systemTiming, ms);
      },
    }),
  });
  await reapDeadGenerations({ paths, lock: testKernelLock(), signal: new AbortController().signal, warn: onWarning, reapMarkers: async () => undefined });
  return warnings;
};

describe('T3 (d) the lock proof lives where no sweep reads', () => {
  it('the proof directory is <run>/lock-proof, is created with the others, and lies outside every marker directory', async (context) => {
    const paths = await layout(context);
    const proofDir = proofDirOf(paths);
    expect(fs.statSync(proofDir).isDirectory()).toBe(true);
    for (const markers of Object.values(paths.markers)) {
      expect(path.relative(markers, proofDir).startsWith('..')).toBe(true);
    }
  });

  it('every sweep leaves a proof held in this process alone: the file stays and this process is never signalled', async (context) => {
    const paths = await layout(context);
    const proof = path.join(proofDirOf(paths), 'proof-in-this-process');
    const descriptor = fs.openSync(proof, CREATE_LOCKED, 0o600);
    const { kill, sent } = recordingKill();
    try {
      const warnings = await sweepEverything(paths, kill);
      expect(fs.existsSync(proof)).toBe(true);
      expect(sent).toEqual([]);
      expect(warnings.filter((warning) => warning.includes('lock-proof'))).toEqual([]);
    } finally {
      fs.closeSync(descriptor);
    }
  });

  it('every sweep leaves a proof held by a second process alone: the file stays and the prover lives', async (context) => {
    const paths = await layout(context);
    const proof = path.join(proofDirOf(paths), 'proof-in-another-process');
    const prover = await startProver(proof);
    const { kill, sent } = recordingKill();
    const warnings = await sweepEverything(paths, kill);
    expect(fs.existsSync(proof)).toBe(true);
    expect(prover.exitCode).toBeNull();
    expect(prover.signalCode).toBeNull();
    expect(sent.filter(([target]) => Math.abs(target) === prover.pid)).toEqual([]);
    expect(warnings.filter((warning) => warning.includes('lock-proof'))).toEqual([]);
  });
});
