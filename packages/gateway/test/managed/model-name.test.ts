import { afterEach, describe, expect, it } from 'vitest';
import type { KnownProbeKey } from '@momonga/config';
import { MODEL_NOT_LISTED_YET, createManagedTarget, managedConnectionPlace, managedModelName, saveProbeRecord } from '@momonga/gateway';
import type { ManagedServer } from '@momonga/gateway';
import { MODEL_ID_CHANGED_CODE, messageOf } from '@momonga/protocol';
import { startFakeChatCompletions, type FakeChatCompletionsServer, testKernelLock } from '@momonga/testkit';
import { makeDir } from '../gateway-helpers.ts';
import { makeReport } from '../report-fixture.ts';
import { FM_CURRENCY, NO_AUTO_PROBE, fmRecordKey, fmTargetBase, recordKeyOptions } from '../fm-record-support.ts';

const RECORD_KEY: KnownProbeKey = fmRecordKey('cd'.repeat(32), '25A100');
const ASKED = { name: 'apple/declared', display: 'declared', model: 'declared' };
const DECLARED_BOUNDS = { contextWindow: 4096, maxOutputTokens: 512 };

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const servingFake = async (modelId: string): Promise<ManagedServer> => {
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', wire: 'fm', modelId });
  servers.push(fake);
  const endpoint = { kind: 'unix' as const, path: fake.socketPath };
  return { restarts: 0, start: async () => endpoint, ensureRunning: async () => endpoint, stop: async () => undefined, health: async () => ({ ok: true }) };
};

const targetOf = async (server: ManagedServer, extra: { declaredModel?: string; recordedModel?: string; exitCode?: number }) => {
  const probeRecordDir = makeDir();
  if (extra.recordedModel !== undefined) await saveProbeRecord(probeRecordDir, RECORD_KEY, { ...makeReport(1, 1), modelId: extra.recordedModel }, FM_CURRENCY, testKernelLock());
  return createManagedTarget({
    ...fmTargetBase('apple'),
    server,
    binary: '/usr/bin/fm',
    exec: async () => ({ exitCode: extra.exitCode ?? 0, stdout: '', stderr: 'refused' }),
    probeRecordDir,
    ...recordKeyOptions(RECORD_KEY, NO_AUTO_PROBE),
    toolCallingSetting: 'native',
    declaredCapabilities: DECLARED_BOUNDS,
    ...(extra.declaredModel === undefined ? {} : { declaredModel: extra.declaredModel }),
  });
};

describe('the name of a managed model in a text is <server>/<model> (gateway-accounts DECISION-4, rule M)', () => {
  it('takes the declared model, else the id the server lists, else the words "not listed yet"', () => {
    expect(managedModelName('fm', { declared: 'system', listed: 'other' })).toBe('fm/system');
    expect(managedModelName('fm', { listed: 'listed-by-the-server' })).toBe('fm/listed-by-the-server');
    expect(managedModelName('fm', {})).toBe(`fm/${MODEL_NOT_LISTED_YET}`);
    expect(MODEL_NOT_LISTED_YET).toBe('not listed yet');
  });

  it('names a model no source lists yet "not listed yet", and by the listed id once the server listed it', async () => {
    const target = await targetOf(await servingFake('listed-by-the-server'), { exitCode: 69 });
    const count = () => target.countTokens?.(ASKED, { model: ASKED.name, input: 'count this' }, new AbortController().signal);

    await expect(count()).rejects.toThrow('the model "apple/not listed yet": the token counter failed with exit code 69: refused');
    expect(await target.upstreamModel(ASKED, new AbortController().signal)).toBe('listed-by-the-server');
    await expect(count()).rejects.toThrow('the model "apple/listed-by-the-server": the token counter failed with exit code 69: refused');
  });

  it('gives the declared capabilities of a model whose id differs from the listed one, and refuses only where the served id is checked', async () => {
    const target = await targetOf(await servingFake('recorded'), { declaredModel: 'declared', recordedModel: 'recorded' });

    expect(await target.capabilities(ASKED)).toMatchObject(DECLARED_BOUNDS);
    await expect(target.upstreamModel(ASKED, new AbortController().signal)).rejects.toMatchObject({
      status: 412,
      body: { code: MODEL_ID_CHANGED_CODE, param: 'model', message: 'The server apple of the model apple/declared lists "recorded", not "declared". Run /models add to add the model it serves now.' },
    });
  });

  it('builds the text of a changed model id from the server name and the model name', () => {
    expect(messageOf('modelIdChanged', 'gateway', { server: 'fm', model: 'fm/system', listed: 'renamed', entry: 'system' })).toBe(
      'The server fm of the model fm/system lists "renamed", not "system". Run /models add to add the model it serves now.',
    );
  });
});

describe('a refusal of a managed connection names the connection as the loader does', () => {
  it('is <settings file>: models.connections[i] of the connection that holds the server name', () => {
    const connections = [{ provider: 'openai' }, { provider: 'apple' }];
    expect(managedConnectionPlace('/home/u/.momonga/settings.json', connections, 'apple')).toBe('/home/u/.momonga/settings.json: models.connections[1]');
  });
});
