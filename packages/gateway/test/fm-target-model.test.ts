import { afterEach, describe, expect, it } from 'vitest';
import { createManagedFmTarget, saveProbeRecord } from '@momonga/gateway';
import type { FmServe, ProbeRecordKey } from '@momonga/gateway';
import { startFakeChatCompletions, type FakeChatCompletionsServer } from '@momonga/testkit';
import { makeDir } from './gateway-helpers.ts';
import { makeReport } from './report-fixture.ts';

const RECORD_KEY: ProbeRecordKey = { target: 'fm', binarySha256: 'ab'.repeat(32), osBuild: '25A100' };
const LISTED = 'listed-by-fm';
const TARGET = { name: 'fm', model: 'label-in-the-gateway' };

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const startListing = async (): Promise<{ fake: FakeChatCompletionsServer; fmServe: FmServe; starts: () => number }> => {
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', wire: 'fm', modelId: LISTED });
  servers.push(fake);
  let starts = 0;
  const fmServe: FmServe = {
    restarts: 0,
    start: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    ensureRunning: async () => {
      starts += 1;
      return { kind: 'unix', socketPath: fake.socketPath };
    },
    stop: async () => undefined,
    health: async () => ({ ok: true }),
  };
  return { fake, fmServe, starts: () => starts };
};

const targetOf = async (fmServe: FmServe, extra: { declaredModel?: string; declaredOutputBoundField?: 'max_tokens' | 'max_completion_tokens'; report?: ReturnType<typeof makeReport> } = {}) => {
  const probeRecordDir = makeDir();
  if (extra.report !== undefined) await saveProbeRecord(probeRecordDir, RECORD_KEY, extra.report);
  return createManagedFmTarget({
    fmServe,
    binary: '/usr/bin/fm',
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    probeRecordDir,
    recordKey: RECORD_KEY,
    toolCallingSetting: 'auto',
    ...(extra.declaredModel === undefined ? {} : { declaredModel: extra.declaredModel }),
    ...(extra.declaredOutputBoundField === undefined ? {} : { declaredOutputBoundField: extra.declaredOutputBoundField }),
  });
};

const listings = (fake: FakeChatCompletionsServer): number => fake.requests.filter((request) => request.path === '/v1/models').length;

describe('the model id the managed fm target sends to fm serve', () => {
  it('is the declared model, without asking fm serve', async () => {
    const { fake, fmServe, starts } = await startListing();
    const target = await targetOf(fmServe, { declaredModel: 'declared' });

    expect(await target.upstreamModel(TARGET, new AbortController().signal)).toBe('declared');
    expect(starts()).toBe(0);
    expect(listings(fake)).toBe(0);
  });

  it('is the model id the fm probe recorded, when none is declared', async () => {
    const { fake, fmServe } = await startListing();
    const target = await targetOf(fmServe, { report: { ...makeReport(1, 1), modelId: 'recorded' } });

    expect(await target.upstreamModel(TARGET, new AbortController().signal)).toBe('recorded');
    expect(listings(fake)).toBe(0);
  });

  it('is the declared model over the recorded one', async () => {
    const { fmServe } = await startListing();
    const target = await targetOf(fmServe, { declaredModel: 'declared', report: { ...makeReport(1, 1), modelId: 'recorded' } });

    expect(await target.upstreamModel(TARGET, new AbortController().signal)).toBe('declared');
  });

  it('is the id fm serve lists, read once, for an unprobed target without a declared model', async () => {
    const { fake, fmServe, starts } = await startListing();
    const target = await targetOf(fmServe);

    const first = await target.upstreamModel(TARGET, new AbortController().signal);
    const second = await target.upstreamModel(TARGET, new AbortController().signal);

    expect([first, second]).toEqual([LISTED, LISTED]);
    expect(listings(fake)).toBe(1);
    expect(starts()).toBe(2);
  });

  it('fails, and reads the listing again next time, when fm serve answers the listing with an error', async () => {
    const fake = await startFakeChatCompletions({ scenario: 'tools-ok', wire: 'fm', modelsReply: { kind: 'error', status: 500, body: { error: 'down' } } });
    servers.push(fake);
    const fmServe: FmServe = {
      restarts: 0,
      start: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
      ensureRunning: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
      stop: async () => undefined,
      health: async () => ({ ok: true }),
    };
    const target = await targetOf(fmServe);

    await expect(target.upstreamModel(TARGET, new AbortController().signal)).rejects.toThrow('HTTP 500');
    await expect(target.upstreamModel(TARGET, new AbortController().signal)).rejects.toThrow('HTTP 500');
    expect(listings(fake)).toBe(2);
  });
});

describe('the output bound field of the managed fm target', () => {
  it('is the declared field for an unprobed target and over the recorded one', async () => {
    const { fmServe } = await startListing();
    const unprobed = await targetOf(fmServe, { declaredOutputBoundField: 'max_tokens' });
    const probed = await targetOf(fmServe, { declaredOutputBoundField: 'max_tokens', report: { ...makeReport(1, 1), outputBoundField: 'max_completion_tokens' } });

    expect((await unprobed.capabilities(TARGET)).outputBoundField).toBe('max_tokens');
    expect((await probed.capabilities(TARGET)).outputBoundField).toBe('max_tokens');
  });

  it('is the recorded field when none is declared', async () => {
    const { fmServe } = await startListing();
    const target = await targetOf(fmServe, { report: { ...makeReport(1, 1), outputBoundField: 'max_tokens' } });

    expect((await target.capabilities(TARGET)).outputBoundField).toBe('max_tokens');
  });
});
