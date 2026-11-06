import { describe, expect, it } from 'vitest';
import { momongaPaths } from '@momonga/foundation';
import { PROBE_METHOD_VERSION, endpointIdentityOf, endpointKeyOf, loadEndpointRecord, probeEndpointTarget, saveEndpointRecord } from '@momonga/gateway';
import { tokensForText } from '@momonga/protocol';
import type { FakeChatCompletionsOptions } from '@momonga/testkit';
import { getJson, postJson, readJson, userInput } from './gateway-helpers.ts';
import { readFileTool, startFake } from './cc-support.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, clientFor, launchGateway, makeHome, until, writeSettings } from './gateway-process-helpers.ts';
import { makeReport } from './report-fixture.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';
import { TARGET_PROBING } from '@momonga/protocol';

const request = { model: 'fast', input: userInput('call read_file for a.txt'), tools: [readFileTool] };

const completions = (fake: Awaited<ReturnType<typeof startFake>>) => fake.requests.filter((entry) => entry.path === '/v1/chat/completions');

const IDENTITY_FIELDS = ['created', 'id', 'object', 'owned_by'];

const DEFAULT_LISTING = { data: [{ id: 'system', object: 'model', created: 0, owned_by: 'system' }] };

const autoSetup = async (extra: Partial<FakeChatCompletionsOptions> = {}) => {
  const fake = await startFake({ scenario: 'json-schema-only', ...extra });
  const home = makeHome();
  writeSettings(home, { models: { aliases: { fast: ['local'] }, targets: { local: ccTarget(fake.socketPath, { toolCalling: 'auto' }) } } });
  const probeDir = momongaPaths(home, process.platform, {}).probe;
  const endpoint = `unix:${fake.socketPath}`;
  return { fake, home, probeDir, endpoint, identityFields: IDENTITY_FIELDS, identity: endpointIdentityOf(DEFAULT_LISTING, 'system', IDENTITY_FIELDS) };
};

const probedSetup = async (models: () => Array<Record<string, unknown>>) => {
  const fake = await startFake({ scenario: 'tools-ok', modelId: 'qwen-fake', models });
  const home = makeHome();
  writeSettings(home, {
    models: { aliases: { fast: ['local'] }, targets: { local: ccTarget(fake.socketPath, { toolCalling: 'auto', model: 'qwen-fake' }) } },
  });
  await probeEndpointTarget({
    probeRecordDir: momongaPaths(home, process.platform, {}).probe,
    upstream: { kind: 'unix', socketPath: fake.socketPath }, key: { endpoint: endpointKeyOf({ kind: 'unix', socketPath: fake.socketPath }), model: 'qwen-fake' }, model: 'qwen-fake',
    apiKey: undefined,
    samples: 2,
  });
  fake.requests.length = 0;
  return { fake, home };
};

describe('chat-completions target with toolCalling auto', () => {
  it('answers a call 503 target_probing and starts the probe when no record exists', async () => {
    const { home, fake } = await autoSetup();
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION, measureEndpoint: () => new Promise(() => undefined), measureOllama: () => new Promise(() => undefined) });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', request));

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe(TARGET_PROBING);
    expect(completions(fake)).toEqual([]);
  });

  it('uses the mode the record decided, here constrained output, and the capabilities it measured', async () => {
    const { home, fake, probeDir, endpoint, identity, identityFields } = await autoSetup();
    const report = { ...makeReport(0.2, 1), parallelToolCalls: { accepted: true, multiCallRate: 1 }, reasoning: { control: 'none' as const, headroomTokens: 300 } };
    await saveEndpointRecord(probeDir, { endpoint, model: 'system' }, identity, identityFields, report, CURRENT_DIALECTS);
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });
    const client = clientFor(handle.socketPath);

    const response = await readJson(await postJson(client, '/v1/responses', request));

    expect(response.status).toBe(200);
    const sent = completions(fake)[0]?.body as { response_format?: { type?: string }; tools?: unknown };
    expect(sent.response_format?.type).toBe('json_schema');
    expect(sent.tools).toBeUndefined();
    const models = await getJson(client, '/v1/momonga/models');
    expect(models.body.data[0].capabilities).toMatchObject({ toolCalling: 'constrained', source: 'probed', parallelToolCalls: true, contextWindow: 4096 });
  });

  it('applies the reasoning the record measured to a request for a bounded artefact', async () => {
    const { home, fake, probeDir, endpoint, identity, identityFields } = await autoSetup();
    const report = { ...makeReport(1, 1), reasoning: { control: 'none' as const, headroomTokens: 300 } };
    await saveEndpointRecord(probeDir, { endpoint, model: 'system' }, identity, identityFields, report, CURRENT_DIALECTS);
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });

    const response = await readJson(
      await postJson(clientFor(handle.socketPath), '/v1/responses', {
        model: 'fast',
        input: userInput('summarise'),
        max_output_tokens: 100,
        reasoning: { effort: 'none' },
      }),
    );

    expect(response.status).toBe(200);
    expect((completions(fake)[0]?.body as { max_completion_tokens?: number }).max_completion_tokens).toBe(400);
  });

  it('refuses a record whose identity differs from what the server shows now, and says the record is stale', async () => {
    const { home, fake, probeDir, endpoint, identityFields } = await autoSetup();
    await saveEndpointRecord(probeDir, { endpoint, model: 'system' }, 'identity-of-an-older-pull', identityFields, makeReport(1, 1), CURRENT_DIALECTS);
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', request));

    expect(response.status).toBe(412);
    expect(response.body.error.message).toContain('stale');
    expect(response.body.error.message).toContain('momonga gateway probe local');
    expect(completions(fake)).toEqual([]);
  });

  it('treats a record saved by an older probe method as no record: 503 target_probing and a new probe', async () => {
    const { home, fake, probeDir, endpoint, identity, identityFields } = await autoSetup();
    await saveEndpointRecord(probeDir, { endpoint, model: 'system' }, identity, identityFields, makeReport(1, 1), { ...CURRENT_DIALECTS, probeMethod: PROBE_METHOD_VERSION - 1 });
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION, measureEndpoint: () => new Promise(() => undefined), measureOllama: () => new Promise(() => undefined) });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', request));

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe(TARGET_PROBING);
    expect(completions(fake)).toEqual([]);
  });

  it('keeps working after the server stamps a fresh creation time on every listing, because the probe dropped that field', async () => {
    let stamp = 1_700_000_000;
    const { home, fake } = await probedSetup(() => [{ id: 'qwen-fake', object: 'model', created: (stamp += 7), owned_by: 'vllm' }]);
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', request));

    expect(response.status).toBe(200);
    expect(fake.requests.filter((entry) => entry.path === '/v1/models')).toHaveLength(1);
  });

  it('still detects a re-pull when the server keeps the creation time of a model stable', async () => {
    let created = 1_700_000_000;
    const { home, fake } = await probedSetup(() => [{ id: 'qwen-fake', object: 'model', created, owned_by: 'library' }]);
    created = 1_800_000_000;
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', request));

    expect(response.status).toBe(412);
    expect(response.body.error.message).toContain('stale');
    expect(completions(fake)).toEqual([]);
  });

  it('keeps the upstream body out of the message when the identity read is refused', async () => {
    const { home, fake, probeDir, endpoint, identity, identityFields } = await autoSetup(
      { modelsReply: { kind: 'error', status: 403, body: { error: 'secret-token-sk-12345 is not allowed' } } },
    );
    await saveEndpointRecord(probeDir, { endpoint, model: 'system' }, identity, identityFields, makeReport(1, 1), CURRENT_DIALECTS);
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', request));

    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain('secret-token');
    expect(JSON.stringify(response.body)).toContain('403');
    expect(completions(fake)).toEqual([]);
  });

  it('stops the identity read as soon as the caller goes away', async () => {
    const { home, fake, probeDir, endpoint, identity, identityFields } = await autoSetup({ modelsReply: { kind: 'hang' } });
    await saveEndpointRecord(probeDir, { endpoint, model: 'system' }, identity, identityFields, makeReport(1, 1), CURRENT_DIALECTS);
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });
    const leaving = new AbortController();
    const pending = clientFor(handle.socketPath)
      .request({ method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: leaving.signal })
      .catch(() => undefined);
    await until(() => fake.requests.some((entry) => entry.path === '/v1/models'), 'the identity read to reach the server', 5_000);

    leaving.abort();

    await until(() => fake.disconnects() === 1, 'the identity read to be dropped', 5_000);
    await pending;
  });

  it('raises the recorded headroom when a real summary reports more hidden reasoning, and never lowers it', async () => {
    const summary = 'GOAL: fix the bug';
    const reply = (completionTokens: number) => ({
      kind: 'stream' as const,
      chunks: [{ delta: { role: 'assistant', content: summary } }, { delta: {}, finishReason: 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: completionTokens, total_tokens: 40 + completionTokens },
    });
    const { home, fake, probeDir, endpoint, identity, identityFields } = await autoSetup({ script: [reply(300), reply(60)] });
    const report = { ...makeReport(1, 1), reasoning: { control: 'none' as const, headroomTokens: 10 } };
    await saveEndpointRecord(probeDir, { endpoint, model: 'system' }, identity, identityFields, report, CURRENT_DIALECTS);
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });
    const client = clientFor(handle.socketPath);
    const compact = { model: 'fast', input: userInput('a long conversation') };
    const hidden = 300 - tokensForText(summary);

    expect((await readJson(await postJson(client, '/v1/responses/compact', compact))).status).toBe(200);
    expect((await loadEndpointRecord(probeDir, { endpoint, model: 'system' }, CURRENT_DIALECTS))?.report.reasoning).toEqual({ control: 'none', headroomTokens: hidden });

    expect((await readJson(await postJson(client, '/v1/responses/compact', compact))).status).toBe(200);
    expect((await loadEndpointRecord(probeDir, { endpoint, model: 'system' }, CURRENT_DIALECTS))?.report.reasoning).toEqual({ control: 'none', headroomTokens: hidden });
    expect(completions(fake)).toHaveLength(2);
  });

  it('leaves a target that sets toolCalling native untouched by any record', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const home = makeHome();
    writeSettings(home, { models: { aliases: { fast: ['local'] }, targets: { local: ccTarget(fake.socketPath, { toolCalling: 'native' }) } } });
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', request));

    expect(response.status).toBe(200);
    expect(fake.requests.filter((entry) => entry.path === '/v1/models')).toEqual([]);
  });
});
