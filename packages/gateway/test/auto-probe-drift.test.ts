import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemTiming } from '@momonga/foundation';
import { TARGET_PROBE_FAILED, TARGET_PROBING } from '@momonga/protocol';
import { ProbeKeyChangedError, createAutoProbe, probeLockPath } from '@momonga/gateway';
import { GatewayError } from '../src/core/errors.ts';
import { realTimers } from '../src/process-ports.ts';
import { createFakeKernelLock } from '@momonga/testkit';
import { recordProbe, targetProbingError } from '../src/probe/auto-probe.ts';
import type { ProbeLockKey, ProbeSubject } from '../src/probe/auto-probe.ts';
import { makeDir } from './gateway-helpers.ts';

const specDir = path.resolve(import.meta.dirname, '..', '..', '..', 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'AutoProbe.tla'), 'utf8');
const config = fs.readFileSync(path.join(specDir, 'AutoProbe.cfg'), 'utf8');
const invariantTests = ['auto-probe.test.ts', 'auto-probe-endpoints.test.ts'].map((file) => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8')).join('\n');
const cliProbe = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'cli', 'src', 'commands', 'gateway.ts'), 'utf8');

const definitionOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined in AutoProbe.tla`);
  const end = spec.indexOf('\n\n', start);
  return spec.slice(start, end === -1 ? undefined : end);
};

const constantOf = (name: string): string => {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm').exec(config);
  if (match === null) throw new Error(`AutoProbe.cfg sets no ${name}`);
  return (match[1] as string).trim();
};

const invariantsOf = (): string[] => {
  const block = /INVARIANTS\n([\s\S]*?)\n\n/.exec(config);
  if (block === null) throw new Error('AutoProbe.cfg lists no invariants');
  return (block[1] as string).split('\n').map((line) => line.trim()).filter((line) => line !== '' && line !== 'TypeOK');
};

const PROPERTY_OF_INVARIANT: Record<string, string> = {
  SingleProbePerKey: 'P1',
  NoGuessedAnswer: 'P2',
  NoRecordGets503: 'P3',
  RetryAfterIsHonest: 'P3',
  RecordSeenAtOnce: 'P4',
  FailedWritesNothing: 'P5',
  RecordMatchesKey: 'P6',
  RecordIsClean: 'P7',
  RefusalGetsRemedy: 'P8',
  NoProbeInBackoff: 'P9',
  RecordUnderLock: 'P10',
  NoRecordUnderUnknown: 'P11',
  MemoryIsThisInstance: 'P12',
};

describe('the code conforms to specs/tla/AutoProbe.tla', () => {
  it('checks the design the code builds: a single flight per key in the gateway, the save under the key lock, the key per request, a fresh record, no guess, no 412, no record from a failure, the taint check, and the CLI writer as an actor', () => {
    expect({
      SingleFlight: constantOf('SingleFlight'),
      KeyView: constantOf('KeyView'),
      ReadRecord: constantOf('ReadRecord'),
      Guess: constantOf('Guess'),
      Reject412: constantOf('Reject412'),
      FailWrites: constantOf('FailWrites'),
      TaintCheck: constantOf('TaintCheck'),
      Manual: constantOf('Manual'),
      HostKeyed: constantOf('HostKeyed'),
      SaveLock: constantOf('SaveLock'),
      PreconditionCheck: constantOf('PreconditionCheck'),
      RejectStale: constantOf('RejectStale'),
      Backoff: constantOf('Backoff'),
      Unreadable: constantOf('Unreadable'),
      UnknownWrites: constantOf('UnknownWrites'),
    }).toEqual({
      SingleFlight: '"gateway"',
      KeyView: '"perRequest"',
      ReadRecord: '"fresh"',
      Guess: 'FALSE',
      Reject412: 'FALSE',
      FailWrites: 'FALSE',
      TaintCheck: 'TRUE',
      Manual: 'TRUE',
      HostKeyed: 'TRUE',
      SaveLock: 'TRUE',
      PreconditionCheck: 'TRUE',
      RejectStale: 'FALSE',
      Backoff: 'TRUE',
      Unreadable: 'TRUE',
      UnknownWrites: 'FALSE',
    });
  });

  it('defines every invariant the check configuration lists, and each has a test named after it', () => {
    const invariants = invariantsOf();

    expect(invariants.sort()).toEqual(Object.keys(PROPERTY_OF_INVARIANT).sort());
    for (const name of invariants) {
      expect(spec).toMatch(new RegExp(`^${name} ==`, 'm'));
      expect(invariantTests).toContain(name);
      expect(invariantTests).toContain(`${PROPERTY_OF_INVARIANT[name]} `);
    }
  });

  it('keeps the shared guard in the file system beside the records, one lock per record key', () => {
    const dir = '/probe-records';
    const first = probeLockPath(dir, { target: 'fm', binarySha256: 'a'.repeat(64), osBuild: '25A1' });
    const otherBuild = probeLockPath(dir, { target: 'fm', binarySha256: 'a'.repeat(64), osBuild: '25A2' });
    const otherBinary = probeLockPath(dir, { target: 'fm', binarySha256: 'b'.repeat(64), osBuild: '25A1' });

    expect(path.dirname(first)).toBe(dir);
    expect(new Set([first, otherBuild, otherBinary]).size).toBe(3);
    expect(probeLockPath(dir, { target: 'fm', binarySha256: 'a'.repeat(64), osBuild: '25A1' })).toBe(first);
  });

  it('has the CLI writer, the actor Manual, go through the same guarded probe and restart no daemon to refresh a cached record', () => {
    const probeFm = /const probeManaged = [\s\S]*?\n};\n/.exec(cliProbe)?.[0];

    expect(probeFm).toBeDefined();
    expect(probeFm).toContain('probeManagedFm');
    expect(probeFm).not.toContain('restartDaemon');
  });

  it('names the code sources of the built design in the model header, not the cached record, the key at start or a lockless CLI', () => {
    const header = spec.slice(0, spec.indexOf('EXTENDS'));

    expect(header).toContain('gateway/src/probe/auto-probe.ts');
    expect(header).not.toMatch(/a cache that only|computed once at gateway start|It takes no lock/);
  });

  it('checks the endpoint adapter under the same properties, and names its key source and the backoff in the model', () => {
    const endpoint = fs.readFileSync(path.join(specDir, 'AutoProbe.endpoint.cfg'), 'utf8');

    expect(endpoint).toMatch(/HostKeyed = FALSE/);
    expect(endpoint).toMatch(/SaveLock = TRUE/);
    expect(spec).toContain('file identity');
    expect(spec).toContain('gateway/src/probe/auto-probe.ts (createAutoProbe');
    expect(spec).toContain('packages/gateway/src/probe/probe-endpoint.ts');
  });

  it('decides a record of another key by one comparison for every adapter, and keeps the evidence that a 412 for the mismatch breaks P6', () => {
    const rejectStale = fs.readFileSync(path.join(specDir, 'AutoProbe.rejectStale.cfg'), 'utf8');
    const sourceOf = (file: string): string => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

    expect(rejectStale).toMatch(/RejectStale = TRUE/);
    expect(rejectStale).toMatch(/RecordMatchesKey/);
    expect(spec).toContain('record.ts recordForIdentity');
    for (const file of ['probe/record.ts', 'probe/endpoint-target.ts', 'probe/ollama-target.ts']) {
      expect(sourceOf(file)).toContain('recordForIdentity(');
    }
    for (const file of ['probe/endpoint-target.ts', 'probe/ollama-target.ts']) {
      expect(sourceOf(file)).not.toContain('is stale');
    }
  });
});

type Key = ProbeLockKey & { target: string; build: string };

type World = { lock: ReturnType<typeof createFakeKernelLock>; dir: string; saves: { key: Key; heldAtSave: boolean }[]; heldDuringMeasure: boolean[] };

const worldOf = (): World => ({ lock: createFakeKernelLock({ inheritable: false }), dir: makeDir(), saves: [], heldDuringMeasure: [] });

const subjectOf = (world: World, keys: readonly Key[], outcome: 'ok' | 'fail'): ProbeSubject<Key, string> => {
  let reads = 0;
  return {
    target: 'm',
    unknown: { fields: ['toolCalling'], declaration: 'declare toolCalling for the model "m" in its settings' },
    readKey: async () => keys[Math.min(reads++, keys.length - 1)] as Key,
    precondition: { boundMs: 1000, check: async () => ({ kind: 'met' }) },
    measure: async ({ key }) => {
      world.heldDuringMeasure.push(world.lock.isHeldBy(probeLockPath(world.dir, key)) !== undefined);
      if (outcome === 'fail') throw new Error('the fake measurement failed');
      return 'report';
    },
    save: async (key) => {
      world.saves.push({ key, heldAtSave: world.lock.isHeldBy(probeLockPath(world.dir, key)) !== undefined });
    },
  };
};

const codeOf = async (attempt: Promise<unknown>): Promise<string | null | undefined> => {
  try {
    await attempt;
    return undefined;
  } catch (error: unknown) {
    if (!(error instanceof GatewayError)) throw error;
    return error.body.code;
  }
};

describe('the probe runner does what AutoProbe.tla states, on the cases of the model', () => {
  const one: Key = { target: 'm', build: '1' };
  const two: Key = { target: 'm', build: '2' };

  it('measures without the key lock and saves under it (SaveLock, RecordUnderLock)', async () => {
    expect(spec).toMatch(/^Locks == SaveLock$/m);
    const world = worldOf();
    await recordProbe(subjectOf(world, [one], 'ok'), world.dir, world.lock, systemTiming, new AbortController().signal, 1000);
    expect(world.heldDuringMeasure).toEqual([false]);
    expect(world.saves).toEqual([{ key: one, heldAtSave: true }]);
  });

  it('refuses the save of a measurement whose key changed meanwhile, under the lock (TaintCheck, RecordIsClean)', async () => {
    const world = worldOf();
    await expect(recordProbe(subjectOf(world, [one, two], 'ok'), world.dir, world.lock, systemTiming, new AbortController().signal, 1000)).rejects.toBeInstanceOf(ProbeKeyChangedError);
    expect(world.saves).toEqual([]);
  });

  it('answers target_probing with no record and target_probe_failed inside the back-off of a failed probe (Request, Waits)', async () => {
    expect(definitionOf('Request')).toContain('IF Waits THEN "target_probe_failed" ELSE "target_probing"');
    const world = worldOf();
    const probe = createAutoProbe({ redactor: { text: (text) => text }, dir: world.dir, lock: world.lock, clock: { now: () => 0, monotonicMs: () => 0 }, timers: realTimers, retryAfterMs: 60_000, onEvent: () => undefined });
    const subject = subjectOf(world, [one], 'fail');
    const first = await probe.ensure(subject, one);
    expect(first.state).toBe('probing');
    expect(targetProbingError(first).body.code).toBe(TARGET_PROBING);
    await probe.close();
    const again = createAutoProbe({ redactor: { text: (text) => text }, dir: world.dir, lock: world.lock, clock: { now: () => 0, monotonicMs: () => 0 }, timers: realTimers, retryAfterMs: 60_000, onEvent: () => undefined });
    await again.ensure(subject, one);
    for (let tries = 0; again.openFlights() > 0 && tries < 100; tries += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(await codeOf(again.ensure(subject, one))).toBe(TARGET_PROBE_FAILED);
    await again.close();
  });

  it('starts one gateway flight per key while one runs (SingleProbePerKey)', async () => {
    const world = worldOf();
    const probe = createAutoProbe({ redactor: { text: (text) => text }, dir: world.dir, lock: world.lock, clock: { now: () => 0, monotonicMs: () => 0 }, timers: realTimers, retryAfterMs: 60_000, onEvent: () => undefined });
    const subject = subjectOf(world, [one], 'ok');
    await Promise.all([probe.ensure(subject, one), probe.ensure(subject, one)]);
    expect(probe.openFlights()).toBeLessThanOrEqual(1);
    await probe.close();
    expect(world.heldDuringMeasure.length).toBe(1);
  });
});

