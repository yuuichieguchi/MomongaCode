import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemClock } from '@momonga/foundation';
import { createChatCompletionsAdapter, createGateway } from '@momonga/gateway';
import type { GatewayConfig } from '@momonga/gateway';
import { startFakeChatCompletions } from '@momonga/testkit';
import { titleOf } from './support/cases.ts';
import { createE2eHome, registerE2eCleanup } from './support/home.ts';
import { toolCallReply } from './support/upstream.ts';
import { E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

const COMPLIANCE_DIR = path.join(import.meta.dirname, '..', 'compliance', 'open-responses');
const BUN = path.join(COMPLIANCE_DIR, 'node_modules', '.bin', 'bun');
const SUITE_ENTRY = path.join(COMPLIANCE_DIR, 'suite', 'bin', 'compliance-test.ts');
const DEBUG_TOKEN = 'fake-open-responses-debug-token';
const MODEL_ALIAS = 'fast';
const HMAC_KEY = Buffer.from('momonga-test-hmac-key-0001-padded-to-32-bytes', 'utf8');

const WEBSOCKET_TESTS = [
  'websocket-response',
  'websocket-sequential-responses',
  'websocket-continuation',
  'websocket-reconnect-store-false-recovery',
  'websocket-previous-response-not-found',
  'websocket-failed-continuation-evicts-cache',
  'websocket-compact-new-chain',
] as const;

const UNSUPPORTED_TESTS = [...WEBSOCKET_TESTS, 'image-input'] as const;

type SuiteResult = { id: string; name: string; status: 'passed' | 'failed' | 'skipped'; errors?: string[] };
type SuiteOutput = { summary: { passed: number; failed: number; skipped: number; total: number }; results: SuiteResult[] };

const gatewayConfig: GatewayConfig = {
  models: { aliases: { [MODEL_ALIAS]: ['fm'] }, targets: { fm: { kind: 'chat-completions', model: 'system', maxConcurrency: 4, admissionTimeoutMs: 5000 } } },
  retry: { maxAttempts: 3, baseMs: 100, maxMs: 10_000 },
  breaker: { failureThreshold: 5, openMs: 30_000 },
  limits: { maxBodyBytes: 1_000_000, maxIdempotencyFrameBytes: 8_000_000, idempotencyReaderStallMs: 30_000 },
  idempotency: { ttlMs: 60_000 },
  closeGraceMs: 1000,
  sseKeepAliveMs: 15_000,
  detachedMaxMs: 1_800_000,
};

const runSuite = (baseUrl: string, cwd: string, env: Record<string, string>): Promise<{ output: SuiteOutput; exitCode: number | null }> =>
  new Promise((resolve, reject) => {
    if (!fs.existsSync(BUN)) {
      reject(new Error(`bun is not installed at ${BUN}; run: npm ci --prefix compliance/open-responses`));
      return;
    }
    const child = spawn(BUN, ['run', SUITE_ENTRY, '--base-url', baseUrl, '--api-key', DEBUG_TOKEN, '--model', MODEL_ALIAS, '--json'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    registerE2eCleanup(() => void child.kill('SIGKILL'));
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => void (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => void (stderr += chunk));
    child.once('error', reject);
    child.once('close', (exitCode) => {
      try {
        resolve({ output: JSON.parse(stdout) as SuiteOutput, exitCode });
      } catch (error) {
        reject(new Error(`the compliance suite printed no JSON result (exit ${exitCode}): ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });

describe('Open Responses compliance suite against the gateway TCP debug listener', () => {
  it(titleOf('open-responses-compliance'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const fake = await startFakeChatCompletions({
      scenario: 'tools-ok',
      routes: [{ match: (body) => JSON.stringify(body).includes('weather like in San Francisco'), reply: toolCallReply('get_weather', { location: 'San Francisco, CA' }) }],
    });
    registerE2eCleanup(() => fake.close());
    const adapter = createChatCompletionsAdapter({
      resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
      toolCalling: () => 'native',
      capabilities: async () => ({
        contextWindow: 4096,
        maxOutputTokens: 1024,
        toolCalling: 'native',
        structuredOutput: 'json_schema',
        streaming: true,
        stopSequences: false,
        imageInput: false,
        parallelToolCalls: true,
        schemaDialect: 'json-schema-2020-12',
        tokenCounting: 'estimated',
        usageReported: true,
        maxConcurrency: 4,
        source: 'config',
      }),
      clock: systemClock,
    });
    registerE2eCleanup(() => adapter.close());
    const gateway = await createGateway({
      credentials: [],
      config: gatewayConfig,
      adapters: { fm: adapter },
      clock: systemClock,
      timers: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) },
      dbPath: path.join(home.root, 'gateway-compliance.db'),
      hmacKey: HMAC_KEY,
      socketPath: path.join(home.root, 'gw.sock'),
      version: 'e2e',
      debugTcp: { host: '127.0.0.1', port: 0, token: DEBUG_TOKEN },
    });
    registerE2eCleanup(() => gateway.close());

    const { output, exitCode } = await runSuite(`http://127.0.0.1:${gateway.tcpPort}/v1`, home.root, { PATH: '/usr/bin:/bin', HOME: home.home, TMPDIR: home.sessionTmp });
    for (const result of output.results) console.log(`${result.status.padEnd(7)} ${result.id}${result.errors === undefined ? '' : `: ${result.errors.join('; ')}`}`);
    console.log(JSON.stringify(output.summary));

    const failedIds = output.results.filter((result) => result.status === 'failed').map((result) => result.id).sort();
    expect(failedIds).toEqual([...UNSUPPORTED_TESTS].sort());
    expect(output.results.filter((result) => result.status === 'skipped')).toEqual([]);
    expect(output.summary).toEqual({ passed: output.results.length - UNSUPPORTED_TESTS.length, failed: UNSUPPORTED_TESTS.length, skipped: 0, total: output.results.length });
    for (const result of output.results.filter((entry) => (WEBSOCKET_TESTS as readonly string[]).includes(entry.id))) expect(result.errors).toEqual(['WebSocket connection failed']);
    expect(output.results.find((result) => result.id === 'image-input')?.errors?.join(' ')).toMatch(/HTTP 400/);
    expect(exitCode).toBe(1);
    const passedIds = output.results.filter((result) => result.status === 'passed').map((result) => result.id);
    expect(passedIds).toEqual(expect.arrayContaining(['basic-response', 'streaming-response', 'tool-calling', 'multi-turn', 'compact-response', 'compact-missing-model', 'system-prompt']));
  });
});
