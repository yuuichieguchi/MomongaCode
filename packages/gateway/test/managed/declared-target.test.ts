import { PERSON_TRAFFIC } from '../../src/probe/request-gate.ts';
import { NO_PROGRESS_LISTENER } from '../../src/probe/auto-probe.ts';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBinaryHashCache, managedInstancePaths, momongaPaths } from '@momonga/foundation';
import { probeKeyOf } from '@momonga/config';
import type { KnownProbeKey } from '@momonga/config';
import { createManagedTarget, decideToolCalling, loadProbeRecord, managedCurrencyOf, managedKeyReader, measureManagedServer, saveProbeRecord } from '@momonga/gateway';
import type { ManagedServer } from '@momonga/gateway';
import { FM_SERVER, TARGET_PROBING } from '@momonga/protocol';
import type { ManagedServerDescription, ProbeReport } from '@momonga/protocol';
import { FAKE_OS_BUILD, FAKE_SERVER_MODEL, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeManagedServer, fakeExec, killGroupsForCleanup, testKernelLock, testProcessInspector } from '@momonga/testkit';
import { makeDir, registerCleanup } from '../gateway-helpers.ts';
import { makeHome } from '../gateway-process-helpers.ts';
import { makeReport } from '../report-fixture.ts';
import { declaredForm, loadedDeclaration, writeExecutable } from './declared-support.ts';
import { systemTiming } from '@momonga/foundation';
import { hostTimers } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const COMMAND = '/opt/mine/bin/mine-server';
const DECLARATION = { command: COMMAND, args: ['run', '--socket', '{socket}'], readyPath: '/ready' };

const knownKey = (binarySha256: string): KnownProbeKey => {
  const key = probeKeyOf({ subject: 'mine', identity: ['binarySha256', 'hostOsBuild'], readings: { binarySha256: { kind: 'read', value: binarySha256 }, hostOsBuild: { kind: 'read', value: FAKE_OS_BUILD } }, model: 'fake-1' });
  if (key.kind !== 'known') throw new Error('a key built from read components is known');
  return key;
};

const KEY_A = knownKey('aa'.repeat(32));
const KEY_B = knownKey('bb'.repeat(32));

const dumpedPids = (file: string): number[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => (JSON.parse(line) as { pid: number }).pid)
    : [];

const sha256OfFile = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const idleServer: ManagedServer = {
  restarts: 0,
  start: async () => ({ kind: 'unix', path: '/unused.sock' }),
  ensureRunning: async () => ({ kind: 'unix', path: '/unused.sock' }),
  stop: async () => undefined,
  health: async () => ({ ok: true }),
};

const probingAnswer = { state: 'probing', message: 'probing', retryAfterSeconds: 120, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare toolCalling for the model in its settings' } } as const;

describe('a declared server record is current only for the description it was measured with (design-managed-servers 19.4; R-S19-12)', () => {
  const recordUnder = async (measured: typeof DECLARATION, current: typeof DECLARATION): Promise<ProbeReport | null> => {
    const dir = path.join(makeDir(), 'probe');
    await saveProbeRecord(dir, KEY_A, makeReport(1, 1), managedCurrencyOf(await loadedDeclaration('mine', measured), { userDialects: {} }), testKernelLock());
    return loadProbeRecord(dir, KEY_A, managedCurrencyOf(await loadedDeclaration('mine', current), { userDialects: {} }), 'workbench');
  };

  it.each([
    ['command', { ...DECLARATION, command: '/opt/mine/bin/other-server' }],
    ['args', { ...DECLARATION, args: ['run', '--threads', '2', '--socket', '{socket}'] }],
    ['readyPath', { ...DECLARATION, readyPath: '/healthz' }],
  ])('makes the record not current when %s changes', async (_field, changed) => {
    expect(await recordUnder(DECLARATION, changed)).toBeNull();
  });

  it('keeps the record current for the same declaration loaded again', async () => {
    expect((await recordUnder(DECLARATION, DECLARATION))?.modelId).toBe('system');
  });
});

describe('a changed declared model gives a new probe key (19.4, T2; R-S19-13)', () => {
  it('reads two different known keys for models a and b of one declared server and binary', async () => {
    const binary = writeExecutable(makeDir(), 'mine-server', '#!/bin/sh\nexit 0\n');
    const description = await loadedDeclaration('mine', { ...DECLARATION, command: binary });
    const keyFor = (model: string) => managedKeyReader({ description, binary, model, exec: fakeExec, platform: 'darwin', hashes: createBinaryHashCache() })(AbortSignal.timeout(REAL_PROCESS_TEST_TIMEOUT_MS));
    const [a, b] = [await keyFor('a'), await keyFor('b')];
    expect(a.kind).toBe('known');
    expect(b.kind).toBe('known');
    expect((a as KnownProbeKey).digest).not.toBe((b as KnownProbeKey).digest);
    expect(JSON.parse((a as KnownProbeKey).canonical)).toEqual({ subject: 'mine', model: 'a', binarySha256: sha256OfFile(binary), hostOsBuild: FAKE_OS_BUILD });
  });
});

describe('a declared command that is a symlink is keyed by the file it resolves to (19.4; R-S19-16)', () => {
  it('puts the SHA-256 of the resolved file into the key, not of the link', async () => {
    const dir = makeDir();
    const real = writeExecutable(dir, 'mine-server-real', '#!/bin/sh\necho real\n');
    const link = path.join(dir, 'mine-server');
    fs.symlinkSync(real, link);
    const description = await loadedDeclaration('mine', { ...DECLARATION, command: link });
    expect(description.binary.defaultPath).toBe(link);
    const key = await managedKeyReader({ description, binary: link, model: 'fake-1', exec: fakeExec, platform: 'darwin', hashes: createBinaryHashCache() })(AbortSignal.timeout(REAL_PROCESS_TEST_TIMEOUT_MS));
    expect(key.kind).toBe('known');
    expect(JSON.parse((key as KnownProbeKey).canonical)['binarySha256']).toBe(sha256OfFile(real));
  });
});

describe('a running instance keeps the key it started with (19.11-a, 19.14 item 16b; R-S19-21)', () => {
  const targetWith = async (readKey: () => KnownProbeKey) => {
    const description = declaredForm('mine', DECLARATION);
    const currency = managedCurrencyOf(description, { userDialects: {} });
    const dir = path.join(makeDir(), 'probe');
    await saveProbeRecord(dir, KEY_A, makeReport(1, 1), currency, testKernelLock());
    const started: KnownProbeKey[] = [];
    const managed = await createManagedTarget({
      description,
      server: idleServer,
      binary: COMMAND,
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      probeRecordDir: dir,
      serverName: 'workbench',
      requestLimitMs: 300_000,
      timeoutSignal: hostTimers.timeoutSignal,
      isUsableBinary: async () => true,
      readKey: async () => readKey(),
      onInstanceEnd: () => undefined,
      startProbe: async (key) => {
        started.push(key);
        return probingAnswer;
      },
      instanceProbe: () => {
        throw new Error('every key component is read in this test');
      },
      currency,
      toolCallingSetting: 'auto',
    });
    return { managed, started };
  };
  const target = { name: 'workbench', display: 'workbench', model: 'fake-1' };
  const signal = (): AbortSignal => AbortSignal.timeout(REAL_PROCESS_TEST_TIMEOUT_MS);

  it('answers from the start key record after the binary is replaced, and measures the new key only after the instance next starts', async () => {
    let current: KnownProbeKey = KEY_A;
    const { managed, started } = await targetWith(() => current);

    await managed.childStarting(signal());
    expect((await managed.capabilities(target)).toolCalling).toBe('native');
    current = KEY_B;
    expect((await managed.capabilities(target)).toolCalling).toBe('native');
    expect(started).toEqual([]);

    managed.childExited();
    await managed.childStarting(signal());
    await expect(managed.capabilities(target)).rejects.toMatchObject({ status: 503, body: { code: TARGET_PROBING } });
    expect(started).toEqual([KEY_B]);
  });

  it('runs the first child under the key read when that child starts, not the key the binary had when the gateway started', async () => {
    let current: KnownProbeKey = KEY_A;
    const { managed, started } = await targetWith(() => current);

    current = KEY_B;
    await managed.childStarting(signal());
    await expect(managed.capabilities(target)).rejects.toMatchObject({ status: 503, body: { code: TARGET_PROBING } });
    expect(started).toEqual([KEY_B]);
  });
});

describe('a declared server follows the one generic declared-only rule (19.11-b, 19.14 item 8; R-S19-22)', () => {
  const targetOf = async (description: ManagedServerDescription, toolCallingSetting: 'auto' | 'constrained', declaredCapabilities?: { contextWindow: number; maxOutputTokens: number }) => {
    const started: KnownProbeKey[] = [];
    const managed = await createManagedTarget({
      description,
      server: idleServer,
      binary: description.binary.defaultPath,
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      probeRecordDir: path.join(makeDir(), 'probe'),
      serverName: 'workbench',
      requestLimitMs: 300_000,
      timeoutSignal: hostTimers.timeoutSignal,
      isUsableBinary: async () => true,
      readKey: async () => KEY_A,
      onInstanceEnd: () => undefined,
      startProbe: async (key) => {
        started.push(key);
        return probingAnswer;
      },
      instanceProbe: () => {
        throw new Error('every key component is read in this test');
      },
      currency: managedCurrencyOf(description, { userDialects: {} }),
      ...(declaredCapabilities === undefined ? {} : { declaredCapabilities }),
      toolCallingSetting,
    });
    return { managed, started };
  };

  it('answers 503 target_probing with toolCalling auto, no record and nothing declared, and starts the probe of its key', async () => {
    const { managed, started } = await targetOf(await loadedDeclaration('mine', DECLARATION), 'auto');
    await expect(managed.capabilities({ name: 'workbench', display: 'workbench', model: 'fake-1' })).rejects.toMatchObject({ status: 503, body: { code: TARGET_PROBING } });
    expect(started).toEqual([KEY_A]);
  });

  it('serves the declared bounds and the explicit mode exactly as fm does under the same declaration', async () => {
    const bounds = { contextWindow: 4096, maxOutputTokens: 512 };
    const answerOf = async (description: ManagedServerDescription) => {
      const { managed, started } = await targetOf(description, 'constrained', bounds);
      const target = { name: 'workbench', display: 'workbench', model: 'fake-1' };
      const capabilities = await managed.capabilities(target);
      return { capabilities: { ...capabilities, allowedTools: undefined }, envelope: managed.envelopeShape(target), dialect: managed.schemaDialect(target), started };
    };
    const declared = await answerOf(await loadedDeclaration('mine', DECLARATION));
    const fm = await answerOf(FM_SERVER);
    expect(declared.capabilities).toMatchObject({ contextWindow: 4096, maxOutputTokens: 512, toolCalling: 'constrained', source: 'declared' });
    expect(declared).toEqual(fm);
    expect(declared.started).toEqual([]);
  });

  const measuredMode = async (scenario: 'tools-ok' | 'tools-400') => {
    const dir = makeDir();
    const fake = await createFakeManagedServer({ dir });
    const dumpFile = path.join(dir, 'argv.jsonl');
    fake.configure({ scenario, envDumpFile: dumpFile });
    registerCleanup(() => killGroupsForCleanup(dumpedPids(dumpFile)));
    const home = makeHome();
    const description = await loadedDeclaration('anvil', { command: fake.binaryPath, args: ['run', '--socket', '{socket}'], readyPath: '/ready' }, home);
    const instance = managedInstancePaths(momongaPaths(home, process.platform, {}), { owner: 'cli', purpose: 'probe', provider: 'workbench' });
    fs.mkdirSync(instance.markerDirectory, { recursive: true, mode: 0o700 });
    const report = await measureManagedServer({
      timers: systemTiming,
      gate: PERSON_TRAFFIC,
      inspector: testProcessInspector(),
      lock: testKernelLock(),
      description,
      target: 'workbench',
      binary: fake.binaryPath,
      instance,
      readyTimeoutMs: description.ready.limitMs,
      env: {},
      exec: fakeExec,
      execWithStdin: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      model: FAKE_SERVER_MODEL,
      samples: 2,
      readStopGraceMs: () => 1_000,
      onWarning: () => undefined,
    })({ key: {} as never, signal: AbortSignal.timeout(REAL_PROCESS_TEST_TIMEOUT_MS), progress: NO_PROGRESS_LISTENER });
    return { mode: decideToolCalling(report).mode, report };
  };

  it('measures a server that refuses native tool calls as constrained, with its envelope shape measured', async () => {
    const { mode, report } = await measuredMode('tools-400');
    expect(mode).toBe('constrained');
    expect(report.nativeTools.accepted).toBe(false);
    expect(report.schemaDialect.tried.length).toBeGreaterThan(0);
  });

  it('measures a server that accepts native tool calls as native', async () => {
    const { mode } = await measuredMode('tools-ok');
    expect(mode).toBe('native');
  });
});
