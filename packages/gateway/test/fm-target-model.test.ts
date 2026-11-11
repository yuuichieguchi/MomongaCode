import { afterEach, describe, expect, it } from 'vitest';
import { createManagedTarget, saveProbeRecord } from '@momonga/gateway';
import type { ManagedServer } from '@momonga/gateway';
import type { KnownProbeKey } from '@momonga/config';
import { startFakeChatCompletions, type FakeChatCompletionsServer, testKernelLock } from '@momonga/testkit';
import { makeDir } from './gateway-helpers.ts';
import { makeReport } from './report-fixture.ts';
import { FM_CURRENCY, fmRecordKey, fmTargetBase, IDLE_AUTO_PROBE, NO_AUTO_PROBE, primed, probingAnswer, recordKeyOptions } from './fm-record-support.ts';
import type { StartProbe } from './fm-record-support.ts';
import { MODEL_ID_CHANGED_CODE, TARGET_PROBING } from '@momonga/protocol';

const RECORD_KEY: KnownProbeKey = fmRecordKey('ab'.repeat(32), '25A100');
const LISTED = 'listed-by-fm';
const TARGET = { name: 'fm', display: 'fm', model: 'label-in-the-gateway' };

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const startListing = async (): Promise<{ fake: FakeChatCompletionsServer; fmServe: ManagedServer; starts: () => number }> => {
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', wire: 'fm', modelId: LISTED });
  servers.push(fake);
  let starts = 0;
  const fmServe: ManagedServer = {
    restarts: 0,
    start: async () => ({ kind: 'unix', path: fake.socketPath }),
    ensureRunning: async () => {
      starts += 1;
      return { kind: 'unix', path: fake.socketPath };
    },
    stop: async () => undefined,
    health: async () => ({ ok: true }),
  };
  return { fake, fmServe, starts: () => starts };
};

type TargetExtra = {
  declaredModel?: string;
  declaredOutputBoundField?: 'max_tokens' | 'max_completion_tokens';
  declaredCapabilities?: { contextWindow: number; maxOutputTokens: number };
  toolCallingSetting?: 'auto' | 'native';
  report?: ReturnType<typeof makeReport>;
  unprobed?: true;
  startProbe?: StartProbe;
  probeRecordDir?: string;
};

const targetOf = async (fmServe: ManagedServer, extra: TargetExtra = {}) => {
  const probeRecordDir = extra.probeRecordDir ?? makeDir();
  if (extra.unprobed !== true) await saveProbeRecord(probeRecordDir, RECORD_KEY, extra.report ?? makeReport(1, 1), FM_CURRENCY, testKernelLock());
  const managed = createManagedTarget({
    ...fmTargetBase(),
    server: fmServe,
    binary: '/usr/bin/fm',
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    probeRecordDir,
    ...recordKeyOptions(RECORD_KEY, extra.startProbe ?? (extra.unprobed === true ? IDLE_AUTO_PROBE : NO_AUTO_PROBE)),
    toolCallingSetting: extra.toolCallingSetting ?? 'auto',
    ...(extra.declaredModel === undefined ? {} : { declaredModel: extra.declaredModel }),
    ...(extra.declaredOutputBoundField === undefined ? {} : { declaredOutputBoundField: extra.declaredOutputBoundField }),
    ...(extra.declaredCapabilities === undefined ? {} : { declaredCapabilities: extra.declaredCapabilities }),
  });
  return extra.unprobed === true ? managed : primed(managed, TARGET.name);
};

const listings = (fake: FakeChatCompletionsServer): number => fake.requests.filter((request) => request.path === '/v1/models').length;

const recordedFor = (modelId: string): ReturnType<typeof makeReport> => ({ ...makeReport(1, 1), modelId });

const countedProbe = (): { startProbe: StartProbe; keys: () => string[] } => {
  const keys: string[] = [];
  return {
    startProbe: async (key) => {
      keys.push(key.canonical);
      return probingAnswer();
    },
    keys: () => keys,
  };
};

describe('the model id the managed fm target sends to fm serve', () => {
  it('is the id the server lists, asked once at each start of the server and not from the record (config-C13)', async () => {
    const { fake, fmServe } = await startListing();
    const target = await targetOf(fmServe, { report: recordedFor(LISTED) });

    expect(await target.upstreamModel(TARGET, new AbortController().signal)).toBe(LISTED);
    expect(await target.upstreamModel(TARGET, new AbortController().signal)).toBe(LISTED);
    expect(listings(fake)).toBe(1);

    target.childExited();
    expect(await target.upstreamModel(TARGET, new AbortController().signal)).toBe(LISTED);
    expect(listings(fake)).toBe(2);
  });

  it('is the entry id when the server lists that id', async () => {
    const { fake, fmServe } = await startListing();
    const target = await targetOf(fmServe, { declaredModel: LISTED, report: recordedFor(LISTED) });

    expect(await target.upstreamModel(TARGET, new AbortController().signal)).toBe(LISTED);
    expect(listings(fake)).toBe(1);
  });

  it('measures again when the server lists another model than the record was measured with, and serves nothing from that record (config-C13)', async () => {
    const { fmServe } = await startListing();
    const probe = countedProbe();
    const target = await targetOf(fmServe, { report: recordedFor('recorded'), startProbe: probe.startProbe });

    await expect(target.upstreamModel(TARGET, new AbortController().signal)).rejects.toMatchObject({ status: 503, body: { code: TARGET_PROBING } });
    expect(probe.keys()).toEqual([RECORD_KEY.canonical]);
    await expect(target.capabilities(TARGET)).rejects.toMatchObject({ status: 503, body: { code: TARGET_PROBING } });
  });

  it('serves a model whose capabilities are all declared from the declaration when the record is of another model, with no measurement', async () => {
    const { fmServe } = await startListing();
    const target = await targetOf(fmServe, { report: recordedFor('recorded'), declaredCapabilities: { contextWindow: 4096, maxOutputTokens: 512 }, toolCallingSetting: 'native' });

    expect(await target.upstreamModel(TARGET, new AbortController().signal)).toBe(LISTED);
    expect(await target.capabilities(TARGET)).toMatchObject({ source: 'declared', contextWindow: 4096, maxOutputTokens: 512 });
  });

  it('uses the record again once it is measured with the model the server lists', async () => {
    const { fmServe } = await startListing();
    const probeRecordDir = makeDir();
    const target = await targetOf(fmServe, {
      probeRecordDir,
      report: recordedFor('recorded'),
      startProbe: async (key) => {
        await saveProbeRecord(probeRecordDir, key, recordedFor(LISTED), FM_CURRENCY, testKernelLock());
        return probingAnswer();
      },
    });

    await expect(target.upstreamModel(TARGET, new AbortController().signal)).rejects.toMatchObject({ body: { code: TARGET_PROBING } });
    expect(await target.upstreamModel(TARGET, new AbortController().signal)).toBe(LISTED);
    expect((await target.capabilities(TARGET)).source).toBe('probed');
  });

  it('is never another model: an entry id that differs from the one the server lists is refused with 412 model_id_changed (rule M)', async () => {
    const { fmServe } = await startListing();
    const target = await targetOf(fmServe, { declaredModel: 'declared', report: recordedFor('declared') });

    await expect(target.upstreamModel(TARGET, new AbortController().signal)).rejects.toMatchObject({
      status: 412,
      body: { type: 'invalid_request', code: MODEL_ID_CHANGED_CODE, param: 'model', message: `The server fm of the model fm/declared lists "${LISTED}", not "declared". Run /models add to add the model it serves now.` },
    });
  });

  it('asks fm serve for no model listing: a target with no record answers target_probing before any model id is needed', async () => {
    const { fake, fmServe, starts } = await startListing();
    const target = await targetOf(fmServe, { unprobed: true });

    await expect(target.capabilities(TARGET)).rejects.toMatchObject({ status: 503, body: { code: TARGET_PROBING } });
    expect(listings(fake)).toBe(0);
    expect(starts()).toBe(0);
  });
});

describe('the output bound field of the managed fm target', () => {
  it('is the declared field over the recorded one', async () => {
    const { fmServe } = await startListing();
    const probed = await targetOf(fmServe, { declaredOutputBoundField: 'max_tokens', report: { ...makeReport(1, 1), outputBoundField: 'max_completion_tokens' } });

    expect((await probed.capabilities(TARGET)).outputBoundField).toBe('max_tokens');
  });

  it('is the recorded field when none is declared', async () => {
    const { fmServe } = await startListing();
    const target = await targetOf(fmServe, { report: { ...makeReport(1, 1), outputBoundField: 'max_tokens' } });

    expect((await target.capabilities(TARGET)).outputBoundField).toBe('max_tokens');
  });
});
