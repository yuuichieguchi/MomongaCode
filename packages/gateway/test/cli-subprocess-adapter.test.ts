import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { planProfileOf } from '@momonga/config';
import { CREDENTIAL_CAPABILITY_ENV, EXTERNAL_CLI_PATH_ENV } from '@momonga/foundation';
import { TEST_FENCE, createFakeClock, createFakeTimers } from '@momonga/testkit';
import type { AdapterContext, AdapterRequest, StreamEvent } from '@momonga/protocol';
import { buildCliArgs, classifyCliError, createCliSubprocessAdapter } from '../src/adapters/cli-subprocess/adapter.ts';
import type { CliChildProcess } from '../src/adapters/cli-subprocess/adapter.ts';
import { parseExternalCliStatus } from '../src/adapters/cli-subprocess/status.ts';
import { createRequestValidator } from '../src/core/validation.ts';
import { externalCliEnv } from '../src/process-ports.ts';

const CLAUDE_PROFILE = planProfileOf('claude-code');
const CLAUDE_CLI = CLAUDE_PROFILE.externalCli!;

const makeFakeChild = (script: { lines?: string[]; stderr?: string; code?: number | null; error?: NodeJS.ErrnoException; holdOpen?: boolean }) => {
  const child = new EventEmitter() as unknown as CliChildProcess & EventEmitter & { killedSignals: string[]; stdinText: string };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdinText = '';
  stdin.on('data', (chunk: Buffer) => {
    child.stdinText += chunk.toString('utf8');
  });
  Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null, killedSignals: [] });
  child.kill = (signal?: NodeJS.Signals | number) => {
    child.killedSignals.push(String(signal ?? 'SIGTERM'));
    (child as { signalCode: string | null }).signalCode = 'SIGTERM';
    stdout.end();
    stderr.end();
    child.emit('close', null);
    child.emit('exit', null);
    return true;
  };

  queueMicrotask(() => {
    if (script.error !== undefined) {
      child.emit('error', script.error);
      stdout.end();
      stderr.end();
      return;
    }
    if (script.stderr) stderr.write(script.stderr);
    for (const line of script.lines ?? []) stdout.write(`${line}\n`);
    if (!script.holdOpen) {
      stdout.end();
      stderr.end();
      (child as { exitCode: number | null }).exitCode = script.code ?? 0;
      child.emit('close', script.code ?? 0);
      child.emit('exit', script.code ?? 0);
    }
  });
  return child;
};

const makeContext = (signal: AbortSignal = new AbortController().signal): AdapterContext => ({
  signal,
  attempt: 1,
  reasoningOrigin: { own: () => undefined },
  target: { name: 'claude-code/sonnet', display: 'claude-code/sonnet', model: 'sonnet' },
  capabilities: {
    contextWindow: 200000,
    maxOutputTokens: 16384,
    toolCalling: 'native',
    structuredOutput: 'none',
    streaming: true,
    stopSequences: false,
    schemaDialect: 'json-schema-2020-12',
    tokenCounting: 'estimated',
    usageReported: true,
    maxConcurrency: 1,
    source: 'declared',
    imageInput: false,
  },
});

const collect = async (gen: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
};

describe('external CLI status parsing', () => {
  it('detects missing CLI, active JSON login with email, and signed-out states', () => {
    expect(parseExternalCliStatus(CLAUDE_CLI, { kind: 'missing' })).toEqual({ state: 'missing', cause: CLAUDE_CLI.installHint });
    expect(parseExternalCliStatus(CLAUDE_CLI, { kind: 'exited', code: 0, stdout: JSON.stringify({ loggedIn: true, email: 'dev@example.com' }), stderr: '' })).toEqual({
      state: 'active',
      email: 'dev@example.com',
    });
    expect(parseExternalCliStatus(CLAUDE_CLI, { kind: 'exited', code: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' })).toEqual({
      state: 'not_signed_in',
      cause: 'Not signed in; run claude auth login',
    });
    expect(parseExternalCliStatus(CLAUDE_CLI, { kind: 'exited', code: 1, stdout: '', stderr: 'not logged in' })).toEqual({
      state: 'not_signed_in',
      cause: 'Not signed in; run claude auth login',
    });
  });
});

describe('CLI subprocess adapter', () => {
  it('accepts reasoning.effort = max in the gateway create request validator', () => {
    const validator = createRequestValidator();
    const parsed = validator.parseCreate({ model: 'claude-code/fable', input: 'hello', reasoning: { effort: 'max' } });
    expect(parsed.reasoning?.effort).toBe('max');
  });

  it('builds stateless, no-tools CLI args with exact effort levels including xhigh and max', () => {
    const args = buildCliArgs(CLAUDE_CLI, 'fable', 'max', 'Be concise');
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools',
      '',
      '--no-session-persistence',
      '--setting-sources',
      '',
      '--model',
      'fable',
      '--effort',
      'max',
      '--system-prompt',
      'Be concise',
    ]);
  });

  it('streams text deltas, parses usage and modelUsage, and handles envelope tool calls', async () => {
    const observed: Array<{ model: string; numbers: { contextWindow?: number; maxOutputTokens?: number } }> = [];
    const seenArgs: string[][] = [];
    const clock = createFakeClock(1_800_000_000_000);
    const adapter = createCliSubprocessAdapter({
      profile: CLAUDE_PROFILE,
      cli: CLAUDE_CLI,
      capabilities: async () => makeContext().capabilities,
      clock,
      timers: createFakeTimers(clock),
      statusExec: async () => ({ kind: 'exited', code: 0, stdout: '{"loggedIn":true}', stderr: '' }),
      onObservedModel: (model, numbers) => observed.push({ model, numbers }),
      spawnProcess: (_cmd, args) => {
        seenArgs.push([...args]);
        if (seenArgs.length === 1) {
          return makeFakeChild({
            lines: [
              JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } }),
              JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'from Claude' } } }),
              JSON.stringify({
                type: 'result',
                is_error: false,
                usage: { input_tokens: 120, output_tokens: 15, cache_read_input_tokens: 30 },
                modelUsage: { 'claude-sonnet-4-6': { contextWindow: 200000, maxOutputTokens: 64000 } },
              }),
            ],
          });
        }
        return makeFakeChild({
          lines: [
            JSON.stringify({
              type: 'stream_event',
              event: {
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: '```json\n{"kind":"tool_calls","calls":[{"name":"read_file","arguments":{"path":"README.md"}}]}\n```' },
              },
            }),
            JSON.stringify({ type: 'result', is_error: false, usage: { input_tokens: 50, output_tokens: 20 } }),
          ],
        });
      },
    });

    const plainReq: AdapterRequest = { model: 'sonnet', input: [{ type: 'message', role: 'user', content: 'hi' }], reasoning_effort: 'xhigh' };
    const plainEvents = await collect(adapter.create(plainReq, makeContext()));
    const completed = plainEvents.find((event) => event.type === 'response.completed');
    expect(completed?.type).toBe('response.completed');
    expect(observed).toEqual([{ model: 'claude-sonnet-4-6', numbers: { contextWindow: 200000, maxOutputTokens: 64000 } }]);
    expect(seenArgs[0]).toContain('xhigh');

    const toolReq: AdapterRequest = {
      model: 'opus',
      input: [{ type: 'message', role: 'user', content: 'read readme' }],
      tools: [{ type: 'function', name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      fence: TEST_FENCE,
    };
    const toolEvents = await collect(adapter.create(toolReq, makeContext()));
    expect(toolEvents.some((event) => event.type === 'response.output_item.done' && event.item.type === 'function_call' && event.item.name === 'read_file')).toBe(true);
  });

  it('classifies auth, rate-limit, eligibility, missing binary, and network errors into plan codes', () => {
    expect(classifyCliError(CLAUDE_CLI, CLAUDE_PROFILE, 'spawn claude ENOENT', 'ENOENT').code).toBe('sign_in_required');
    expect(classifyCliError(CLAUDE_CLI, CLAUDE_PROFILE, 'Not logged in. Please sign in').code).toBe('plan_credential_rejected');
    expect(classifyCliError(CLAUDE_CLI, CLAUDE_PROFILE, 'Rate limit exceeded (429)').code).toBe('plan_usage_limit');
    expect(classifyCliError(CLAUDE_CLI, CLAUDE_PROFILE, '403 subscription not eligible').code).toBe('plan_not_eligible');
    expect(classifyCliError(CLAUDE_CLI, CLAUDE_PROFILE, 'upstream overloaded').code).toBe('plan_route_unavailable');
  });

  it('terminates the subprocess on abort', async () => {
    let spawned: ReturnType<typeof makeFakeChild> | undefined;
    const clock = createFakeClock(1_800_000_000_000);
    const adapter = createCliSubprocessAdapter({
      profile: CLAUDE_PROFILE,
      cli: CLAUDE_CLI,
      capabilities: async () => makeContext().capabilities,
      clock,
      timers: createFakeTimers(clock),
      statusExec: async () => ({ kind: 'exited', code: 0, stdout: '{"loggedIn":true}', stderr: '' }),
      spawnProcess: () => {
        spawned = makeFakeChild({ holdOpen: true });
        return spawned;
      },
    });
    const controller = new AbortController();
    const pending = collect(adapter.create({ model: 'haiku', input: [{ type: 'message', role: 'user', content: 'hi' }] }, makeContext(controller.signal)));
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(spawned?.killedSignals).toContain('SIGTERM');
  });

  it('builds a clean external CLI env with the user PATH while stripping gateway credentials', () => {
    const built = externalCliEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/alice',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
      [EXTERNAL_CLI_PATH_ENV]: '/Users/alice/.local/bin:/opt/homebrew/bin:/usr/bin:/bin',
      [CREDENTIAL_CAPABILITY_ENV]: 'secret-cap',
      ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
    });
    expect(built['PATH']).toBe('/Users/alice/.local/bin:/opt/homebrew/bin:/usr/bin:/bin');
    expect(built['HOME']).toBe('/Users/alice');
    expect(built['HTTPS_PROXY']).toBe('http://proxy:3128');
    expect(built[EXTERNAL_CLI_PATH_ENV]).toBeUndefined();
    expect(built[CREDENTIAL_CAPABILITY_ENV]).toBeUndefined();
    expect(built['ANTHROPIC_API_KEY']).toBeUndefined();
  });
});
