import { execFileSync } from '@momonga/testkit/child-process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, REAL_PROCESS_TEST_TIMEOUT_MS, testKernelLock } from '@momonga/testkit';
import { probeKeyOf } from '@momonga/config';
import { FM_SERVER } from '@momonga/protocol';
import { nodeClock, nodeFiles, nodeProcess } from '../src/node-ports.ts';
import { ContextHostError, OWNER_FILE, ROOT_PREFIX, caseEnvironment, readCredentials } from '../src/eval/context-host.ts';
import { endpointRecordFileName } from '@momonga/gateway';
import { copyEndpointProbeRecord, copyProbeRecord, listEvalRoots, nodeContextEffects, readEvalOwner } from '../src/eval/context-effects.ts';
import type { CliPorts } from '../src/ports.ts';
import { KEYCHAIN_UNANSWERED_ADVICE, keychainFixture, outcomeOf, useLimitTimers, stillPendingAfter, settledAfter } from './keychain-fixture.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const directories: string[] = [];

const locked: string[] = [];

const temporary = (): string => {
  const directory = createTempDir();
  directories.push(directory);
  return directory;
};

afterEach(() => {
  vi.useRealTimers();
  for (const directory of locked.splice(0)) fs.chmodSync(directory, 0o700);
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('the homes a sweep may consider', () => {
  const ownerUid = process.getuid?.() ?? 0;

  it('lists only real directories that this user owns and that carry the product prefix', async () => {
    const base = temporary();
    const own = path.join(base, `${ROOT_PREFIX}own`);
    fs.mkdirSync(own);
    fs.mkdirSync(path.join(base, 'mc-legacy'));
    fs.mkdirSync(path.join(base, 'unrelated'));
    fs.writeFileSync(path.join(base, `${ROOT_PREFIX}file`), '');
    fs.symlinkSync(own, path.join(base, `${ROOT_PREFIX}link`));
    expect(await listEvalRoots(nodeFiles, base, ownerUid)).toEqual([own]);
  });

  it('skips a directory that another user owns', async () => {
    const base = temporary();
    fs.mkdirSync(path.join(base, `${ROOT_PREFIX}theirs`));
    expect(await listEvalRoots(nodeFiles, base, ownerUid + 1)).toEqual([]);
  });

  it('reads the owner marker of a home, and says nothing when there is none', async () => {
    const root = temporary();
    expect(await readEvalOwner(nodeFiles, root)).toBeUndefined();
    fs.writeFileSync(path.join(root, OWNER_FILE), JSON.stringify({ pid: 4242, home: '/home/person' }));
    expect(await readEvalOwner(nodeFiles, root)).toEqual({ pid: 4242, home: '/home/person' });
  });

  it('names an old plain-pid marker as legacy', async () => {
    const root = temporary();
    fs.writeFileSync(path.join(root, OWNER_FILE), '4242');
    expect(await readEvalOwner(nodeFiles, root)).toBe('legacy');
    fs.writeFileSync(path.join(root, OWNER_FILE), '4242\n');
    expect(await readEvalOwner(nodeFiles, root)).toBe('legacy');
  });

  it('names no owner for a marker that does not record a home', async () => {
    const root = temporary();
    fs.writeFileSync(path.join(root, OWNER_FILE), JSON.stringify({ pid: 4242 }));
    expect(await readEvalOwner(nodeFiles, root)).toBeUndefined();
  });

  it('reports a directory it cannot read as unreadable instead of throwing', async () => {
    const root = temporary();
    fs.chmodSync(root, 0o000);
    locked.push(root);
    expect(await readEvalOwner(nodeFiles, root)).toBe('unreadable');
  });

  it('reports a plain file that has the prefix as unreadable instead of throwing', async () => {
    const base = temporary();
    const file = path.join(base, `${ROOT_PREFIX}file`);
    fs.writeFileSync(file, '');
    expect(await readEvalOwner(nodeFiles, file)).toBe('unreadable');
  });
});

describe('the timer of a case', () => {
  const effects = (): ReturnType<typeof nodeContextEffects> => nodeContextEffects({ platform: 'linux', env: {}, home: '/home/person', files: nodeFiles, clock: nodeClock, process: nodeProcess } as unknown as CliPorts, testKernelLock());

  it('resolves when the time has passed', async () => {
    await expect(effects().after(1, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('rejects with the reason of the signal when it is aborted while waiting', async () => {
    const controller = new AbortController();
    const reason = new Error('case closed');
    const waiting = effects().after(60_000, controller.signal);
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  });

  it('rejects with the reason of a signal that was already aborted, without starting a timer', async () => {
    const controller = new AbortController();
    const reason = new Error('already closed');
    controller.abort(reason);
    await expect(effects().after(60_000, controller.signal)).rejects.toBe(reason);
  });
});

describe('the environment of a session inside a case', () => {
  const portsWith = (home: string, env: Record<string, string>): CliPorts => ({ platform: 'linux', env, home, files: nodeFiles, process: nodeProcess, interrupt: new AbortController().signal }) as unknown as CliPorts;

  const personEnv = {
    PATH: process.env['PATH'] ?? '/usr/bin',
    HOME: '/home/person',
    XDG_CACHE_HOME: '/home/person/.cache',
    XDG_DATA_HOME: '/home/person/.local/share',
    XDG_CONFIG_HOME: '/home/person/.config',
    XDG_STATE_HOME: '/home/person/.local/state',
    APPDATA: '/home/person/AppData/Roaming',
    LOCALAPPDATA: '/home/person/AppData/Local',
    UPSTREAM_VARIABLE: 'declared-value',
    UPSTREAM_KEY: 'key-value',
  };

  const personHome = (): string => {
    const home = temporary();
    const settingsFile = path.join(home, '.momonga', 'settings.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        models: {
          connections: [{ adapter: 'chat-completions', provider: 'p', baseUrl: 'https://upstream.invalid/v1', apiKeyEnv: 'UPSTREAM_VARIABLE', models: [{ id: 'm', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } }] }],
        },
      }),
    );
    return home;
  };

  it('is built by the function that builds the environment of the case daemon, with the case home, no relocated cache and no credential', async () => {
    const root = temporary();
    const ports = portsWith(personHome(), personEnv);
    const env = await nodeContextEffects(ports, testKernelLock()).sessionEnv(root);
    expect(env['HOME']).toBe(root);
    for (const name of ['XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'APPDATA', 'LOCALAPPDATA', 'UPSTREAM_KEY', 'UPSTREAM_VARIABLE']) {
      expect(env).not.toHaveProperty(name);
    }
    const daemon = caseEnvironment(personEnv, root, 'linux');
    expect({ ...env, ...Object.fromEntries(['UPSTREAM_KEY', 'UPSTREAM_VARIABLE'].map((name) => [name, daemon[name]])) }).toEqual(daemon);
  });

  it('is what a shell command in the case sees: the home of the case, never the home of the person', async () => {
    const root = fs.realpathSync(temporary());
    const env = await nodeContextEffects(portsWith(personHome(), personEnv), testKernelLock()).sessionEnv(root);
    const seen = execFileSync('/bin/bash', ['-c', 'printf %s "$HOME"'], { env }).toString();
    expect(seen).toBe(root);
  });
});

describe('copyEndpointProbeRecord', () => {
  const key = { endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen' };
  const record = JSON.stringify({ ...key, identity: 'x', report: { anything: true } });
  const fileOf = (dir: string): string => path.join(dir, endpointRecordFileName(key));

  it('copies the record of an endpoint and model byte for byte under the same file name', async () => {
    const from = temporary();
    const to = path.join(temporary(), 'state', 'probe');
    fs.writeFileSync(fileOf(from), record);
    expect(await copyEndpointProbeRecord(nodeFiles, from, to, key)).toBe(true);
    expect(fs.readFileSync(fileOf(to), 'utf8')).toBe(record);
    expect(fs.statSync(fileOf(to)).mode & 0o777).toBe(0o600);
  });

  it('copies nothing when the endpoint was never probed', async () => {
    const to = path.join(temporary(), 'probe');
    expect(await copyEndpointProbeRecord(nodeFiles, temporary(), to, key)).toBe(false);
    expect(fs.existsSync(to)).toBe(false);
  });
});

describe('copyProbeRecord', () => {
  const binaryIn = (dir: string): string => {
    const binary = path.join(dir, 'fm');
    fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 });
    return binary;
  };

  const recordNameFor = (binary: string, model: string): string => {
    const binarySha256 = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    const osBuild = execFileSync('sw_vers', ['-buildVersion'], { encoding: 'utf8' }).trim();
    const key = probeKeyOf({ subject: FM_SERVER.id, identity: FM_SERVER.identity, readings: { binarySha256: { kind: 'read', value: binarySha256 }, hostOsBuild: { kind: 'read', value: osBuild } }, model });
    if (key.kind !== 'known') throw new Error('the key is built from read components');
    return `${key.digest}.json`;
  };

  it.skipIf(process.platform !== 'darwin')('copies the record of the probe key of a managed server byte for byte, under the same key file name', async () => {
    const from = temporary();
    const to = path.join(temporary(), 'state', 'probe');
    const binary = binaryIn(temporary());
    const name = recordNameFor(binary, 'system');
    const record = JSON.stringify({ key: 'k', descriptionDigest: 'd', report: { anything: true } });
    fs.writeFileSync(path.join(from, name), record);
    expect(await copyProbeRecord(nodeFiles, from, to, { model: 'apple/system', server: 'fm', binary, upstream: 'system' }, { [FM_SERVER.id]: FM_SERVER }, process.platform, new AbortController().signal)).toBe(true);
    expect(fs.readFileSync(path.join(to, name), 'utf8')).toBe(record);
    expect(fs.statSync(path.join(to, name)).mode & 0o777).toBe(0o600);
  });

  it('copies nothing when the person never probed the model, so the case sees the same answer', async () => {
    const from = temporary();
    const to = path.join(temporary(), 'probe');
    expect(await copyProbeRecord(nodeFiles, from, to, { model: 'apple/system', server: 'fm', binary: binaryIn(temporary()), upstream: 'system' }, { [FM_SERVER.id]: FM_SERVER }, process.platform, new AbortController().signal)).toBe(false);
    expect(fs.existsSync(to)).toBe(false);
  });
});

describe('the credentials a live run reads with the store of the person', () => {
  const COMMAND_LIMIT_MS = 300_000;
  const FIRST_ANSWERS_AFTER_MS = 200_000;
  const credentials = [
    { envName: 'MOMONGA_EVAL_KEY_0', secretName: 'a' },
    { envName: 'MOMONGA_EVAL_KEY_1', secretName: 'b' },
  ];

  const effectsOver = (store: CliPorts['secretStore']): ReturnType<typeof nodeContextEffects> =>
    nodeContextEffects({ platform: 'linux', env: {}, home: '/home/person', files: nodeFiles, process: nodeProcess, secretStore: store } as unknown as CliPorts, testKernelLock());

  it('readCredentials ends at the command limit for all secrets together', async () => {
    useLimitTimers();
    const firstAnswer = Promise.withResolvers<void>();
    const keychain = keychainFixture({
      items: { a: 'key-a', b: 'key-b' },
      beforeAnswer: async (command, account) => {
        if (command !== 'find-generic-password') return;
        if (account === 'a') await firstAnswer.promise;
        if (account === 'b') keychain.control.calls = 'hang';
      },
    });
    const interrupt = new AbortController();

    const attempt = outcomeOf(readCredentials(effectsOver(() => keychain.store), credentials, interrupt.signal));
    try {
      await keychain.arrived('find-generic-password', 1);
      await vi.advanceTimersByTimeAsync(FIRST_ANSWERS_AFTER_MS);
      firstAnswer.resolve();
      await keychain.arrived('find-generic-password', 2);
      await stillPendingAfter(attempt, COMMAND_LIMIT_MS - FIRST_ANSWERS_AFTER_MS - 1);
      await vi.advanceTimersByTimeAsync(1);
      await settledAfter(attempt);

      expect(attempt.state()).toBe('rejected');
      expect(attempt.error()).toBeInstanceOf(ContextHostError);
      expect((attempt.error() as Error).message).toBe(
        `the key of a model server is the secret b in the platform secret store, and it could not be read: the read of the secret "b" did not finish within the command limit of 300000 ms; ${KEYCHAIN_UNANSWERED_ADVICE}; run the command again`,
      );
    } finally {
      interrupt.abort(new Error('the test ended'));
    }
  });

  it('a missing secret keeps the store-it-with tail', async () => {
    const keychain = keychainFixture({ items: { a: 'key-a' } });

    const attempt = readCredentials(effectsOver(() => keychain.store), credentials, new AbortController().signal);

    await expect(attempt).rejects.toBeInstanceOf(ContextHostError);
    await expect(attempt).rejects.toThrow(
      'the key of a model server is the secret b in the platform secret store, and it could not be read: the secret "b" could not be read from the Keychain (exit 44: the fake keychain has no such item); store it with: security add-generic-password -s momonga -a b -w; the gateway reads a missing secret again on the next request. The benchmark reads it with the same store the gateway uses; store it with momonga secret set b',
    );
  });
});
