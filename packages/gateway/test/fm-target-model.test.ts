import { afterEach, describe, expect, it } from 'vitest';
import { createManagedTarget, saveProbeRecord } from '@momonga/gateway';
import type { ManagedServer } from '@momonga/gateway';
import type { KnownProbeKey } from '@momonga/config';
import { startFakeChatCompletions, type FakeChatCompletionsServer } from '@momonga/testkit';
import { makeDir } from './gateway-helpers.ts';
import { makeReport } from './report-fixture.ts';
import { FM_CURRENCY, fmRecordKey, fmTargetBase, IDLE_AUTO_PROBE, NO_AUTO_PROBE, primed, recordKeyOptions } from './fm-record-support.ts';
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

const targetOf = async (fmServe: ManagedServer, extra: { declaredModel?: string; declaredOutputBoundField?: 'max_tokens' | 'max_completion_tokens'; report?: ReturnType<typeof makeReport>; unprobed?: true } = {}) => {
  const probeRecordDir = makeDir();
  if (extra.unprobed !== true) await saveProbeRecord(probeRecordDir, RECORD_KEY, extra.report ?? makeReport(1, 1), FM_CURRENCY);
  const managed = createManagedTarget({
    ...fmTargetBase(),
    server: fmServe,
    binary: '/usr/bin/fm',
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    probeRecordDir,
    ...recordKeyOptions(RECORD_KEY, extra.unprobed === true ? IDLE_AUTO_PROBE : NO_AUTO_PROBE),
    toolCallingSetting: 'auto',
    ...(extra.declaredModel === undefined ? {} : { declaredModel: extra.declaredModel }),
    ...(extra.declaredOutputBoundField === undefined ? {} : { declaredOutputBoundField: extra.declaredOutputBoundField }),
  });
  return extra.unprobed === true ? managed : primed(managed, TARGET.name);
};

const listings = (fake: FakeChatCompletionsServer): number => fake.requests.filter((request) => request.path === '/v1/models').length;

describe('the model id the managed fm target sends to fm serve', () => {
  it('is the entry id when the probe recorded that id, without asking fm serve', async () => {
    const { fake, fmServe, starts } = await startListing();
    const target = await targetOf(fmServe, { declaredModel: 'recorded', report: { ...makeReport(1, 1), modelId: 'recorded' } });

    expect(await target.upstreamModel(TARGET, new AbortController().signal)).toBe('recorded');
    expect(starts()).toBe(0);
    expect(listings(fake)).toBe(0);
  });

  it('is the model id the fm probe recorded, when none is declared', async () => {
    const { fake, fmServe } = await startListing();
    const target = await targetOf(fmServe, { report: { ...makeReport(1, 1), modelId: 'recorded' } });

    expect(await target.upstreamModel(TARGET, new AbortController().signal)).toBe('recorded');
    expect(listings(fake)).toBe(0);
  });

  it('is never another model: an entry id that differs from the recorded one is refused with 412 model_id_changed (rule M)', async () => {
    const { fmServe } = await startListing();
    const refused = targetOf(fmServe, { declaredModel: 'declared', report: { ...makeReport(1, 1), modelId: 'recorded' } });

    await expect(refused).rejects.toMatchObject({
      status: 412,
      body: { type: 'invalid_request', code: MODEL_ID_CHANGED_CODE, param: 'model', message: 'The server of fm lists "recorded", not "declared". Run /models add to add the model it serves now.' },
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
