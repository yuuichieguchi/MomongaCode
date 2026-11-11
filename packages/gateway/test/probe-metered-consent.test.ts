import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { endpointKeyOf, probeEndpointTarget } from '@momonga/gateway';
import { startFakeChatCompletions, testKernelLock } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { MeasurementConsentRequiredError, loadMeasurementConsent, measurementConsentPath, saveMeasurementConsent } from '../src/probe/consent.ts';
import { measurementBoundOf } from '../src/probe/run-probe.ts';
import { makeDir } from './gateway-helpers.ts';
import { hostProbePorts } from './probe-ports-support.ts';

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const DECLARED_WINDOW = 8192;
const DISPLAY = 'paid/qwen-fake';
const SEARCH_PROMPT_WORDS = 5000;

const metered = async (samples = 1) => {
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', modelId: 'qwen-fake', models: [{ id: 'qwen-fake', object: 'model' }], contextSizeExposure: 'none', contextWindow: DECLARED_WINDOW, maxConcurrency: 8 });
  servers.push(fake);
  const upstream = { kind: 'unix', socketPath: fake.socketPath } as const;
  const dir = makeDir();
  const key = { endpoint: endpointKeyOf(upstream), model: 'qwen-fake' };
  const probe = () =>
    probeEndpointTarget({
      ports: hostProbePorts,
      lock: testKernelLock(),
      probeRecordDir: dir,
      upstream,
      key,
      model: 'qwen-fake',
      apiKey: 'fake-paid-key',
      samples,
      metered: { display: DISPLAY, declaredContextWindow: DECLARED_WINDOW },
    });
  const chatRequests = () => fake.requests.filter((request) => request.path === '/v1/chat/completions');
  return { fake, dir, key, probe, chatRequests };
};

const wordsOf = (body: unknown): number => JSON.stringify(body).split(/\s+/).length;

describe('a metered model is measured only with the consent of the person', () => {
  it('refuses without a consent, naming the command that gives it and the bound, and sends no chat request', async () => {
    const { probe, chatRequests } = await metered();

    const refusal = await probe().catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(MeasurementConsentRequiredError);
    const bound = measurementBoundOf(DECLARED_WINDOW, 1);
    expect(String(refusal)).toContain(`momonga gateway probe ${DISPLAY} --yes`);
    expect(String(refusal)).toContain(String(bound.inputTokens));
    expect(String(refusal)).toContain(String(bound.outputTokens));
    expect(chatRequests()).toEqual([]);
  });

  it('records the bound in the one consent file beside the probe records', async () => {
    const { dir, key } = await metered();
    const bound = measurementBoundOf(DECLARED_WINDOW, 1);

    await saveMeasurementConsent(dir, key, bound, testKernelLock());

    expect(JSON.parse(fs.readFileSync(measurementConsentPath(dir, key), 'utf8'))).toMatchObject({ endpoint: key.endpoint, model: key.model, ...bound });
    expect(await loadMeasurementConsent(dir, key)).toEqual(bound);
  });

  it('with the consent takes the declared window, runs no window search, and stays inside the consented bound', async () => {
    const { dir, key, probe, chatRequests } = await metered();
    const bound = measurementBoundOf(DECLARED_WINDOW, 1);
    await saveMeasurementConsent(dir, key, bound, testKernelLock());

    const { report } = await probe();

    expect(report.contextWindow).toEqual({ value: DECLARED_WINDOW, method: 'declared' });
    expect(chatRequests().filter((request) => wordsOf(request.body) > SEARCH_PROMPT_WORDS)).toEqual([]);
    expect(chatRequests().length).toBeLessThanOrEqual(bound.requests);
  });

  it.each([1, 10])('sends no more requests than the bound says at %i samples per rate', async (samples) => {
    const { dir, key, probe, chatRequests } = await metered(samples);
    const bound = measurementBoundOf(DECLARED_WINDOW, samples);
    await saveMeasurementConsent(dir, key, bound, testKernelLock());

    await probe();

    expect(chatRequests().length).toBeLessThanOrEqual(bound.requests);
  });

  it('refuses a consent that covers a smaller bound than the measurement can send', async () => {
    const { dir, key, probe, chatRequests } = await metered();
    const bound = measurementBoundOf(DECLARED_WINDOW, 1);
    await saveMeasurementConsent(dir, key, { ...bound, inputTokens: bound.inputTokens - 1 }, testKernelLock());

    await expect(probe()).rejects.toBeInstanceOf(MeasurementConsentRequiredError);
    expect(chatRequests()).toEqual([]);
  });
});
