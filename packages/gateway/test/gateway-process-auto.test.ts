import { describe, expect, it } from 'vitest';
import { momongaPaths } from '@momonga/foundation';
import { endpointIdentityOf, saveEndpointRecord } from '@momonga/gateway';
import { createUdsClient } from '@momonga/foundation';
import { getJson, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { readFileTool, startFake } from './cc-support.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, clientFor, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';
import { makeReport } from './report-fixture.ts';

const request = { model: 'fast', input: userInput('call read_file for a.txt'), tools: [readFileTool] };

const completions = (fake: Awaited<ReturnType<typeof startFake>>) => fake.requests.filter((entry) => entry.path === '/v1/chat/completions');

const autoSetup = async () => {
  const fake = await startFake({ scenario: 'json-schema-only' });
  const home = makeHome();
  writeSettings(home, { models: { aliases: { fast: ['local'] }, targets: { local: ccTarget(fake.socketPath, { toolCalling: 'auto' }) } } });
  const probeDir = momongaPaths(home, process.platform, {}).probe;
  const endpoint = `unix:${fake.socketPath}`;
  const listing = createUdsClient(fake.socketPath);
  registerCleanup(() => listing.close());
  const models = await (await listing.request({ method: 'GET', path: '/v1/models' })).json();
  fake.requests.length = 0;
  return { fake, home, probeDir, endpoint, identity: endpointIdentityOf(models, 'system') };
};

describe('chat-completions target with toolCalling auto', { timeout: 30_000 }, () => {
  it('fails a call with a message that names the target and the probe command when no record exists', async () => {
    const { home, fake } = await autoSetup();
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', request));

    expect(response.status).toBe(412);
    expect(response.body.error.code).toBe('precondition_failed');
    expect(response.body.error.message).toContain('local');
    expect(response.body.error.message).toContain('momonga gateway probe local');
    expect(completions(fake)).toEqual([]);
  });

  it('uses the mode the record decided, here constrained output, and the capabilities it measured', async () => {
    const { home, fake, probeDir, endpoint, identity } = await autoSetup();
    const report = { ...makeReport(0.2, 1), parallelToolCalls: { accepted: true, multiCallRate: 1 }, reasoning: { control: 'none' as const, headroomTokens: 300 } };
    await saveEndpointRecord(probeDir, { endpoint, model: 'system' }, identity, report);
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
    const { home, fake, probeDir, endpoint, identity } = await autoSetup();
    const report = { ...makeReport(1, 1), reasoning: { control: 'none' as const, headroomTokens: 300 } };
    await saveEndpointRecord(probeDir, { endpoint, model: 'system' }, identity, report);
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
    expect((completions(fake)[0]?.body as { max_tokens?: number }).max_tokens).toBe(400);
  });

  it('refuses a record whose identity differs from what the server shows now, and says the record is stale', async () => {
    const { home, fake, probeDir, endpoint } = await autoSetup();
    await saveEndpointRecord(probeDir, { endpoint, model: 'system' }, 'identity-of-an-older-pull', makeReport(1, 1));
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });

    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', request));

    expect(response.status).toBe(412);
    expect(response.body.error.message).toContain('stale');
    expect(response.body.error.message).toContain('momonga gateway probe local');
    expect(completions(fake)).toEqual([]);
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
