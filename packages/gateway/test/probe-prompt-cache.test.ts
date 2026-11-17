import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesFromProbe, decideToolCalling, endpointKeyOf, probeOllamaTarget, runProbe } from '@momonga/gateway';
import type { Capabilities, ProbeReport } from '@momonga/protocol';
import { startFakeChatCompletions, testKernelLock } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { createProbedEndpointTarget } from '../src/probe/endpoint-target.ts';
import { isProbeReport } from '../src/probe/report-schema.ts';
import { makeDir } from './gateway-helpers.ts';
import { OLLAMA_MODEL, startFakeOllama } from './ollama-support.ts';
import { REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';
import { NO_PROBE_START } from './fm-record-support.ts';
import { UNCONFIGURED_NETWORK } from '@momonga/testkit';
import { hostProbePorts, probePortsAt } from './probe-ports-support.ts';

type CachingBehaviour = 'automatic' | 'none' | 'unreported' | 'malformed';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const NOW = () => new Date('2026-11-05T12:00:00.000Z');

const startFake = async (): Promise<FakeChatCompletionsServer> => {
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', streamUsage: true });
  closers.push(() => fake.close());
  return fake;
};

const cachedTokensFor = (behaviour: CachingBehaviour, repeated: boolean, promptTokens: number): Record<string, unknown> | undefined => {
  if (behaviour === 'unreported') return undefined;
  if (behaviour === 'malformed') return { cached_tokens: 'many' };
  return { cached_tokens: behaviour === 'automatic' && repeated ? promptTokens : 0 };
};

const withCachedTokens = (payload: unknown, details: (promptTokens: number) => Record<string, unknown> | undefined): unknown => {
  if (typeof payload !== 'object' || payload === null) return payload;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return payload;
  const promptTokens = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  const added = details(typeof promptTokens === 'number' ? promptTokens : 0);
  return added === undefined ? payload : { ...payload, usage: { ...usage, prompt_tokens_details: added } };
};

const rewriteSse = (text: string, details: (promptTokens: number) => Record<string, unknown> | undefined): string =>
  text
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') return line;
      try {
        return `data: ${JSON.stringify(withCachedTokens(JSON.parse(line.slice('data: '.length)), details))}`;
      } catch {
        return line;
      }
    })
    .join('\n');

const startCachingServer = async (fake: FakeChatCompletionsServer, behaviour: CachingBehaviour): Promise<string> => {
  const socketPath = path.join(makeDir(), 'caching.sock');
  const seen = new Set<string>();
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const isCompletion = request.method === 'POST' && request.url === '/v1/chat/completions';
      const repeated = isCompletion && seen.has(raw);
      if (isCompletion) seen.add(raw);
      const details = (promptTokens: number) => cachedTokensFor(behaviour, repeated, promptTokens);
      const forwarded = http.request(
        { socketPath: fake.socketPath, method: request.method, path: request.url, headers: { ...request.headers, 'content-length': Buffer.byteLength(raw) } },
        (upstream) => {
          const parts: Buffer[] = [];
          upstream.on('data', (chunk: Buffer) => parts.push(chunk));
          upstream.on('end', () => {
            const text = Buffer.concat(parts).toString('utf8');
            const contentType = String(upstream.headers['content-type'] ?? '');
            let out = text;
            if (isCompletion && contentType.includes('text/event-stream')) out = rewriteSse(text, details);
            else if (isCompletion && contentType.includes('application/json')) {
              try {
                out = JSON.stringify(withCachedTokens(JSON.parse(text), details));
              } catch {
                out = text;
              }
            }
            const { 'content-length': _length, 'transfer-encoding': _encoding, ...headers } = upstream.headers;
            response.writeHead(upstream.statusCode ?? 502, { ...headers, 'content-length': Buffer.byteLength(out) });
            response.end(out);
          });
        },
      );
      forwarded.end(raw);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return socketPath;
};

const probeThrough = async (behaviour: CachingBehaviour): Promise<ProbeReport> => {
  const fake = await startFake();
  const socketPath = await startCachingServer(fake, behaviour);
  return runProbe({ socketPath, samples: 2, ports: probePortsAt(NOW) });
};

const plainReport = async (): Promise<ProbeReport> => {
  const fake = await startFake();
  return runProbe({ socketPath: fake.socketPath, samples: 2, ports: probePortsAt(NOW) });
};

describe('the probe sends one request twice and records the prompt cache from the second answer', () => {
  it('records automatic when the second answer reports cached tokens', async () => {
    const report = await probeThrough('automatic');
    expect(report.promptCache).toEqual({ kind: 'automatic' });
  });

  it('records none when the second answer reports zero cached tokens', async () => {
    const report = await probeThrough('none');
    expect(report.promptCache).toEqual({ kind: 'none' });
  });

  it('records nothing when the answers carry no cached-token field', async () => {
    const report = await probeThrough('unreported');
    expect(report).not.toHaveProperty('promptCache');
    expect(isProbeReport(report)).toBe(true);
  });

  it('writes a report the schema accepts with the recorded cache', async () => {
    const report = await probeThrough('automatic');
    expect(report.promptCache).toEqual({ kind: 'automatic' });
    expect(isProbeReport(report)).toBe(true);
  });
});

type CacheProbeOutcome = { kind: 'recorded'; promptCache: unknown } | { kind: 'refused' };

const outcomeOf = async (probe: () => Promise<{ promptCache?: unknown }>): Promise<CacheProbeOutcome> => {
  try {
    const report = await probe();
    return { kind: 'recorded', promptCache: report.promptCache };
  } catch {
    return { kind: 'refused' };
  }
};

describe('both probes read the cached-token count by one rule (S1)', () => {
  it('treats a cached count that is not a number the same way in the chat-completions and the Ollama probe', async () => {
    const chatCompletions = await outcomeOf(() => probeThrough('malformed'));
    const ollama = await outcomeOf(async () => {
      const fake = await startFakeOllama({ cacheProbe: 'malformed' });
      return (await probeOllamaTarget({ ports: hostProbePorts, lock: testKernelLock(), probeRecordDir: makeDir(), upstream: { kind: 'tcp', baseUrl: fake.origin, network: UNCONFIGURED_NETWORK }, key: { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_MODEL }, model: OLLAMA_MODEL, contextWindow: 32768 })).report;
    });
    expect([{ kind: 'recorded', promptCache: undefined }, { kind: 'refused' }]).toContainEqual(chatCompletions);
    expect(ollama).toEqual(chatCompletions);
  });

  it('records nothing in either probe when the cached count is absent', async () => {
    const chatCompletions = await outcomeOf(() => probeThrough('unreported'));
    const ollama = await outcomeOf(async () => {
      const fake = await startFakeOllama({ cacheProbe: 'unreported' });
      return (await probeOllamaTarget({ ports: hostProbePorts, lock: testKernelLock(), probeRecordDir: makeDir(), upstream: { kind: 'tcp', baseUrl: fake.origin, network: UNCONFIGURED_NETWORK }, key: { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_MODEL }, model: OLLAMA_MODEL, contextWindow: 32768 })).report;
    });
    expect(chatCompletions).toEqual({ kind: 'recorded', promptCache: undefined });
    expect(ollama).toEqual(chatCompletions);
  });
});

describe('a probe report records only what a probe can observe', () => {
  it('accepts automatic and none, and refuses key and breakpoints, which are declared only', async () => {
    const report = await plainReport();
    expect(isProbeReport({ ...report, promptCache: { kind: 'automatic' } })).toBe(true);
    expect(isProbeReport({ ...report, promptCache: { kind: 'none' } })).toBe(true);
    expect(isProbeReport({ ...report, promptCache: { kind: 'key' } })).toBe(false);
    expect(isProbeReport({ ...report, promptCache: { kind: 'breakpoints', maxBreakpoints: 4 } })).toBe(false);
    expect(isProbeReport({ ...report, promptCache: 'automatic' })).toBe(false);
  });
});

describe('the probed prompt cache becomes the target capability', () => {
  it.for(['automatic', 'none'] as const)('carries a recorded %s into the capabilities', async (kind) => {
    const report = { ...(await plainReport()), promptCache: { kind } as const };
    expect(capabilitiesFromProbe(report, decideToolCalling(report)).promptCache).toEqual({ kind });
  });

  it('leaves the capability absent when the probe recorded nothing', async () => {
    const report = await plainReport();
    expect(capabilitiesFromProbe(report, decideToolCalling(report))).not.toHaveProperty('promptCache');
  });

  const probedTarget = (declared: Capabilities, report: ProbeReport) =>
    createProbedEndpointTarget({ written: declared,
      toolCalling: 'auto', readReported: async () => ({}), targetName: 'remote',
      endpoint: 'unix:/nowhere',
      model: 'm',
      declared,
      record: { identity: 'id', identityFields: [], report },
      readRecord: async () => ({ identity: 'id', identityFields: [], report }),
      startProbe: NO_PROBE_START,
      readIdentity: async () => 'id',
      saveRecord: async () => undefined,
    });

  it('gives a probed target the recorded cache when nothing is declared', async () => {
    const report = { ...(await plainReport()), promptCache: { kind: 'automatic' as const } };
    const capabilities = await probedTarget(REMOTE_CAPABILITIES, report).capabilities();
    expect(capabilities.promptCache).toEqual({ kind: 'automatic' });
  });

  it('keeps a declared key over a recorded automatic, because the probe cannot observe a key', async () => {
    const report = { ...(await plainReport()), promptCache: { kind: 'automatic' as const } };
    const capabilities = await probedTarget({ ...REMOTE_CAPABILITIES, promptCache: { kind: 'key' } }, report).capabilities();
    expect(capabilities.promptCache).toEqual({ kind: 'key' });
  });
});
