import fs from 'node:fs';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeChatCompletions, type FakeChatCompletionsServer } from '@momonga/testkit';

type Measurement = { name: string; leg: 'format' | 'tools'; status: number; error: string | null; schema: unknown };

const measured = JSON.parse(fs.readFileSync(new URL('./fixtures/fm-schema-measurements.json', import.meta.url), 'utf8')) as {
  fmSha256: string;
  osBuild: string;
  results: Measurement[];
};

type DictionaryReplay = { schema: unknown; out: { prompt: string; status: number; content: string }[] };

const dictionary = JSON.parse(fs.readFileSync(new URL('./fixtures/evidence-fm-dictionary.json', import.meta.url), 'utf8')) as DictionaryReplay;

const post = (socketPath: string, body: unknown): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });

const messages = [{ role: 'user', content: 'Say hello in one short sentence.' }];

const requestOf = (measurement: Measurement): Record<string, unknown> =>
  measurement.leg === 'tools'
    ? { model: 'system', stream: false, messages, tools: [{ type: 'function', function: { name: 'probe_tool', description: 'x', parameters: measurement.schema } }] }
    : { model: 'system', stream: false, messages, response_format: { type: 'json_schema', json_schema: { name: 'probe', strict: true, schema: measurement.schema } } };

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('the fake fm answers the schemas measured on the real fm serve on 2026-11-05', () => {
  it('replays the measurement of the binary the fixtures were recorded on', () => {
    expect(measured.fmSha256).toBe('f429257df40311ba075484be92c273ab4e882e5694f970c621a4d606b3a956d0');
    expect(measured.osBuild).toBe('26A428');
    expect(measured.results).toHaveLength(36);
  });

  it.each(measured.results.map((measurement) => [`${measurement.leg}: ${measurement.name}`, measurement] as const))('%s', async (_name, measurement) => {
    const fake = await startFakeChatCompletions({ scenario: 'tools-ok', wire: 'fm' });
    servers.push(fake);

    const result = await post(fake.socketPath, requestOf(measurement));

    expect(result.status).toBe(measurement.status);
    if (measurement.status === 400) {
      expect(JSON.parse(result.text)).toEqual({ error: { code: '400', message: measurement.error, type: 'invalid_request_error' } });
    }
    if (measurement.status === 500) expect(result.text).toContain(measurement.error);
  });
});

describe('the fake fm answers the free-form object as the real fm serve did on 2026-11-05', () => {
  it('replays the six samples recorded for properties {} with additionalProperties true', () => {
    expect(dictionary.out).toHaveLength(6);
  });

  it.each(dictionary.out.map((sample, index) => [`sample ${index + 1}: ${sample.prompt}`, sample] as const))('%s', async (_name, sample) => {
    const fake = await startFakeChatCompletions({ scenario: 'tools-ok', wire: 'fm' });
    servers.push(fake);

    const result = await post(fake.socketPath, {
      model: 'system',
      stream: false,
      messages: [{ role: 'user', content: sample.prompt }],
      response_format: { type: 'json_schema', json_schema: { name: 'probe', strict: true, schema: dictionary.schema } },
    });

    expect(result.status).toBe(sample.status);
    const reply = JSON.parse(result.text) as { choices: { message: { content: string } }[] };
    expect(JSON.parse(reply.choices[0]?.message.content ?? '')).toEqual(JSON.parse(sample.content));
  });
});
