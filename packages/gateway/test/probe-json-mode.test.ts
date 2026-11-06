import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesFromProbe, decideToolCalling, runProbe } from '@momonga/gateway';
import type { ProbeReport } from '@momonga/protocol';
import { startFakeChatCompletions } from '@momonga/testkit';
import { mergeCapabilities } from '../src/probe/decide.ts';
import { isProbeReport } from '../src/probe/report-schema.ts';
import { makeDir } from './gateway-helpers.ts';
import { CC_CAPABILITIES } from './cc-support.ts';

type JsonModeBehaviour = 'accepts' | 'rejects' | 'fails' | 'ignores';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const NOW = () => new Date('2026-11-07T12:00:00.000Z');

const completionOf = (content: string): string =>
  JSON.stringify({
    id: 'chatcmpl-json-mode',
    object: 'chat.completion',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

const sseOf = (content: string): string =>
  [
    `data: ${JSON.stringify({ id: 'chatcmpl-json-mode', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: 'chatcmpl-json-mode', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');

const answer = (response: http.ServerResponse, streamed: boolean, content: string): void => {
  const out = streamed ? sseOf(content) : completionOf(content);
  response.writeHead(200, { 'content-type': streamed ? 'text/event-stream' : 'application/json', 'content-length': Buffer.byteLength(out) });
  response.end(out);
};

const startJsonModeTarget = async (behaviour: JsonModeBehaviour): Promise<{ socketPath: string; jsonObjectRequests: () => number }> => {
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', streamUsage: true });
  closers.push(() => fake.close());
  const socketPath = path.join(makeDir(), 'json-mode.sock');
  let jsonObjectRequests = 0;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        const body = JSON.parse(raw);
        if (body?.response_format?.type === 'json_object') {
          jsonObjectRequests += 1;
          if (behaviour === 'accepts') return answer(response, body.stream === true, '{"ok":true}');
          if (behaviour === 'ignores') return answer(response, body.stream === true, 'Sure, here is the answer.');
          if (behaviour === 'fails') {
            const out = JSON.stringify({ error: { message: 'internal error', type: 'server_error', code: null } });
            response.writeHead(500, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
            return response.end(out);
          }
        }
      }
      const forwarded = http.request(
        { socketPath: fake.socketPath, method: request.method, path: request.url, headers: { ...request.headers, 'content-length': Buffer.byteLength(raw) } },
        (upstream) => {
          response.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(response);
        },
      );
      forwarded.end(raw);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { socketPath, jsonObjectRequests: () => jsonObjectRequests };
};

const probeAgainst = async (behaviour: JsonModeBehaviour): Promise<{ report: ProbeReport; jsonObjectRequests: number }> => {
  const target = await startJsonModeTarget(behaviour);
  const report = await runProbe({ socketPath: target.socketPath, samples: 2, now: NOW });
  return { report, jsonObjectRequests: target.jsonObjectRequests() };
};

const jsonModeOf = (value: unknown): unknown => (value as { jsonMode?: unknown }).jsonMode;

describe('the probe measures the JSON-only mode as its own item', () => {
  it('sends a json_object request and records accepted when the target answers it with JSON', async () => {
    const { report, jsonObjectRequests } = await probeAgainst('accepts');
    expect(jsonObjectRequests).toBeGreaterThan(0);
    expect(jsonModeOf(report)).toBe('accepted');
    expect(isProbeReport(report)).toBe(true);
  });

  it('records refused when the target rejects the json_object format as unsupported', async () => {
    const { report, jsonObjectRequests } = await probeAgainst('rejects');
    expect(jsonObjectRequests).toBeGreaterThan(0);
    expect(jsonModeOf(report)).toBe('refused');
    expect(isProbeReport(report)).toBe(true);
  });

  it('records unmeasured, and finishes the probe, when the json_object step fails for another reason', async () => {
    const { report, jsonObjectRequests } = await probeAgainst('fails');
    expect(jsonObjectRequests).toBeGreaterThan(0);
    expect(jsonModeOf(report)).toBe('unmeasured');
    expect(isProbeReport(report)).toBe(true);
  });

  it('never records accepted when the target takes the format but answers with text that is not JSON', async () => {
    const { report, jsonObjectRequests } = await probeAgainst('ignores');
    expect(jsonObjectRequests).toBeGreaterThan(0);
    expect(['refused', 'unmeasured']).toContain(jsonModeOf(report));
  });

  it('measures the mode apart from json_schema: a target that rejects json_object keeps its constrained result', async () => {
    const { report } = await probeAgainst('rejects');
    const accepted = await probeAgainst('accepts');
    expect(report.constrained).toEqual(accepted.report.constrained);
    expect(jsonModeOf(report)).not.toBe(jsonModeOf(accepted.report));
  });
});

describe('the probe record schema for the JSON-only mode', () => {
  it('accepts the three measured states and refuses anything else', async () => {
    const { report } = await probeAgainst('accepts');
    for (const state of ['accepted', 'refused', 'unmeasured']) expect(isProbeReport({ ...report, jsonMode: state })).toBe(true);
    for (const wrong of ['supported', 'json_object', true, null]) expect(isProbeReport({ ...report, jsonMode: wrong })).toBe(false);
  });
});

describe('the measured JSON-only mode becomes the capability', () => {
  const reportWith = async (state: unknown): Promise<ProbeReport> => {
    const { report } = await probeAgainst('accepts');
    const { jsonMode: _drop, ...rest } = report as ProbeReport & { jsonMode?: unknown };
    return (state === undefined ? rest : { ...rest, jsonMode: state }) as ProbeReport;
  };

  it('maps accepted to json_object, and claims the mode from nothing else', async () => {
    const accepted = await reportWith('accepted');
    expect(jsonModeOf(capabilitiesFromProbe(accepted, decideToolCalling(accepted)))).toBe('json_object');
    for (const state of ['unmeasured', undefined]) {
      const report = await reportWith(state);
      expect(isProbeReport(report)).toBe(true);
      expect(capabilitiesFromProbe(report, decideToolCalling(report))).not.toHaveProperty('jsonMode');
    }
  });

  it('maps refused to none', async () => {
    const report = await reportWith('refused');
    expect(jsonModeOf(capabilitiesFromProbe(report, decideToolCalling(report)))).toBe('none');
  });

  it('does not take the mode from constrained: a report that accepted json_schema and refused json_object gives none', async () => {
    const report = await reportWith('refused');
    expect(report.constrained.accepted).toBe(true);
    const capabilities = capabilitiesFromProbe(report, decideToolCalling(report));
    expect(capabilities.structuredOutput).toBe('json_schema');
    expect(jsonModeOf(capabilities)).toBe('none');
  });
});

describe('a declared JSON-only mode wins over the probe', () => {
  const { toolCalling: _t, ...defaults } = CC_CAPABILITIES;
  const merge = (declared: 'json_object' | 'none', probed: 'json_object' | 'none') =>
    mergeCapabilities({ defaults: { ...defaults, toolCalling: 'native' }, declared: { jsonMode: declared }, probed: { jsonMode: probed }, probedAt: NOW().toISOString() });

  it.each([
    ['json_object', 'none'],
    ['none', 'json_object'],
  ] as const)('keeps the declared %s over a probed %s', (declared, probed) => {
    expect(jsonModeOf(merge(declared, probed))).toBe(declared);
  });

  it('keeps the probed value when nothing is declared', () => {
    const merged = mergeCapabilities({ defaults: { ...defaults, toolCalling: 'native' }, declared: {}, probed: { jsonMode: 'json_object' }, probedAt: NOW().toISOString() });
    expect(jsonModeOf(merged)).toBe('json_object');
  });
});
