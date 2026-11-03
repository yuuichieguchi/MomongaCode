import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startFakeChatCompletions } from '@momonga/testkit';
import { titleOf } from './support/cases.ts';
import { createE2eHome, registerE2eCleanup } from './support/home.ts';
import { SUPERVISOR_APP_VERSION } from './support/app-version.ts';
import { roleMainOverride } from './support/launcher.ts';
import { readLog } from './support/log-reader.ts';
import { DEFAULT_E2E_DEPS, startStack } from './support/stack.ts';
import { toolCallReply } from './support/upstream.ts';
import { E2E_CHILD_READY_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const COMPLIANCE_DIR = path.join(import.meta.dirname, '..', 'compliance', 'open-responses');
const BUN = path.join(COMPLIANCE_DIR, 'node_modules', '.bin', 'bun');
const SUITE_ENTRY = path.join(COMPLIANCE_DIR, 'suite', 'bin', 'compliance-test.ts');
const EXPECTED_TESTS = 17;
const DEBUG_TOKEN = 'fake-open-responses-debug-token';
const MODEL_ALIAS = 'default';

type SuiteResult = { id: string; name: string; status: 'passed' | 'failed' | 'skipped'; errors?: string[] };
type SuiteOutput = { summary: { passed: number; failed: number; skipped: number; total: number }; results: SuiteResult[] };

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

const waitForDebugPort = async (logFile: string): Promise<number> =>
  until(
    () => {
      const record = readLog(logFile).find((entry) => entry.msg === 'gateway.debug_listener');
      return typeof record?.['port'] === 'number' ? record['port'] : undefined;
    },
    { deadlineMs: E2E_CHILD_READY_BOUND_MS, description: 'the gateway to log its debug listener port' },
  );

describe('Open Responses compliance suite against the supervised gateway debug listener', () => {
  it(titleOf('open-responses-compliance'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const fake = await startFakeChatCompletions({
      scenario: 'tools-ok',
      imageInput: true,
      maxConcurrency: 8,
      socketPath: home.upstreamSocket,
      routes: [{ match: (body) => JSON.stringify(body).includes('weather like in San Francisco'), reply: toolCallReply('get_weather', { location: 'San Francisco, CA' }) }],
    });
    registerE2eCleanup(() => fake.close());
    const tokenFile = path.join(home.root, 'debug.token');
    fs.writeFileSync(tokenFile, `${DEBUG_TOKEN}\n`, { mode: 0o600 });
    await startStack({
      home,
      upstream: fake,
      settings: {
        models: {
          aliases: { [MODEL_ALIAS]: ['primary'] },
          targets: {
            primary: {
              adapter: 'chat-completions',
              provider: 'fake',
              model: 'system',
              socketPath: home.upstreamSocket,
              maxConcurrency: 8,
              capabilities: { contextWindow: 8192, maxOutputTokens: 1024, imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 }, parallelToolCalls: true },
            },
          },
        },
      },
      deps: {
        ...DEFAULT_E2E_DEPS,
        launcherOverrides: { gateway: roleMainOverride('gateway', SUPERVISOR_APP_VERSION, ['--debug-tcp-port=0', `--debug-tcp-token-file=${tokenFile}`]) },
      },
    });
    const port = await waitForDebugPort(home.paths.logFiles.gateway);

    const { output, exitCode } = await runSuite(`http://127.0.0.1:${port}/v1`, home.root, { PATH: '/usr/bin:/bin', HOME: home.home, TMPDIR: home.sessionTmp });
    for (const result of output.results) console.log(`${result.status.padEnd(7)} ${result.id}${result.errors === undefined ? '' : `: ${result.errors.join('; ')}`}`);
    console.log(JSON.stringify(output.summary));

    expect(output.results.filter((result) => result.status !== 'passed')).toEqual([]);
    expect(output.summary).toEqual({ passed: EXPECTED_TESTS, failed: 0, skipped: 0, total: EXPECTED_TESTS });
    expect(output.results.map((result) => result.id)).toEqual(expect.arrayContaining(['websocket-response', 'websocket-continuation', 'image-input', 'tool-calling', 'compact-response']));
    expect(exitCode).toBe(0);
  });
});
