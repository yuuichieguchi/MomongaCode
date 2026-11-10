import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STOP_VALUES, createJsonLogger, gatewayMaxCloseMs, createUdsClient, decodeSse, systemClock, FIRST_GENERATION, fixedSocket } from '@momonga/foundation';
import type { TextStream, UdsClient } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import type { GatewayProcess } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, ownedStart, createFakeFm, fakeExec, killGroupsForCleanup, registerCleanup, startFakeChatCompletions, withTempDir } from '@momonga/testkit';
import type { CleanupContext, FakeChatCompletionsServer, FakeScriptedReply } from '@momonga/testkit';
import { PROCESS_VERSION, baseEnv, ccTarget, homePaths, writeSettings, prepareHome } from './gateway-process-helpers.ts';
import { userInput } from './gateway-helpers.ts';
import {
  REDACTED,
  REDACTED_401,
  SK,
  TEST_API_KEY,
  TEST_API_KEY_ENV,
  databaseFilesUnder,
  expectFilesFreeOfCredential,
  expectNoCredential,
  expectRedacted,
} from './credential-support.ts';
import { placeFakeFm } from './fm-record-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const body = { model: 'fast', input: userInput('hi') };

const echo401 = (message: string): FakeScriptedReply => ({
  kind: 'error',
  status: 401,
  body: { error: { message, type: 'invalid_request_error', param: null, code: 'invalid_api_key' } },
});

const rawBody401 = (text: string): FakeScriptedReply => ({ kind: 'error', status: 401, body: text });

const captureLog = (): TextStream & { text(): string } => {
  const chunks: string[] = [];
  return {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(''),
  };
};

type ScanOptions = { markerInTraces?: boolean; forbidden?: readonly string[] };

type Stack = {
  home: string;
  fake: FakeChatCompletionsServer;
  handle: GatewayProcess;
  client: UdsClient;
  log: ReturnType<typeof captureLog>;
  closeAndScan(options?: ScanOptions): Promise<void>;
};

const startKeyedStack = async (
  context: CleanupContext,
  reply: FakeScriptedReply,
  options: { keyValue?: string } = {},
): Promise<Stack> => {
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', routes: [{ match: () => true, reply }] });
  registerCleanup(context, () => fake.close());
  const home = withTempDir(context, { asHome: true });
  prepareHome(home);
  writeSettings(home, {
    models: { aliases: { fast: ['primary'] }, targets: { primary: ccTarget(fake.socketPath, { apiKeyEnv: TEST_API_KEY_ENV }) } },
  });
  const log = captureLog();
  const handle = await ownedStart(context, startGatewayProcess({
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home, { [TEST_API_KEY_ENV]: options.keyValue ?? TEST_API_KEY }),
    version: PROCESS_VERSION,
    logger: createJsonLogger({ service: 'gateway', clock: systemClock, stream: log, level: 'debug' }),
    stdout: { write: () => true },
  }));
  let closed = false;
  registerCleanup(
    context,
    async () => {
      if (!closed) await handle.close();
    },
    gatewayMaxCloseMs(DEFAULT_STOP_VALUES),
  );
  const client = createUdsClient(fixedSocket(handle.socketPath));
  registerCleanup(context, () => client.close());
  const closeAndScan = async (scan: ScanOptions = {}): Promise<void> => {
    closed = true;
    await handle.close();
    expectNoCredential(log.text(), TEST_API_KEY);
    const files = databaseFilesUnder(homePaths(home).root);
    expect(files.some((file) => file.endsWith(path.join('state', 'gateway.db')))).toBe(true);
    const traces = files.filter((file) => file.includes(`${path.sep}traces${path.sep}`));
    expect(traces.length).toBeGreaterThan(0);
    expectFilesFreeOfCredential(files, TEST_API_KEY);
    const tracesBytes = traces.map((file) => fs.readFileSync(file).toString('latin1')).join('\n');
    if (scan.markerInTraces === true) expect(tracesBytes).toContain(REDACTED);
    const everything = [log.text(), ...files.map((file) => fs.readFileSync(file).toString('latin1'))].join('\n');
    for (const forbidden of scan.forbidden ?? []) expect(everything).not.toContain(forbidden);
  };
  return { home, fake, handle, client, log, closeAndScan };
};

const post = async (client: UdsClient, payload: unknown): Promise<{ status: number; text: string }> => {
  const response = await client.request({
    method: 'POST',
    path: '/v1/responses',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, text: await response.text() };
};

const sseFramesOf = async (client: UdsClient, payload: unknown): Promise<string[]> => {
  const response = await client.request({
    method: 'POST',
    path: '/v1/responses',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  const frames: string[] = [];
  for await (const frame of decodeSse(response.body)) frames.push(frame.data);
  return frames;
};

describe('T1: a 401 echo of the configured key', () => {
  it.for([false, true])('is redacted in the response with stream %s, and logs and DB bytes stay clean', async (stream, context) => {
    const stack = await startKeyedStack(context, echo401(`Incorrect API key provided: ${TEST_API_KEY}`));
    const response = await post(stack.client, { ...body, stream });
    expect(response.status).toBe(401);
    const error = JSON.parse(response.text).error;
    expect(error.code).toBe('authentication_failed');
    expect(error.message).toBe(REDACTED_401);
    expectRedacted(response.text, TEST_API_KEY);
    await stack.closeAndScan({ markerInTraces: true });
  });

  it.for([
    { label: 'stars and suffix', masked: `${SK}proj-${'*'.repeat(36)}5hQA` },
    { label: 'dots and suffix', masked: `${SK}...5hQA` },
  ])('redacts a masked key with $label, including its suffix', async ({ masked }, context) => {
    const stack = await startKeyedStack(context, echo401(`Incorrect API key provided: ${masked}. You can find your API key at https://platform.openai.com/account/api-keys.`));
    const response = await post(stack.client, body);
    expect(response.status).toBe(401);
    expect(response.text).toContain(REDACTED);
    expect(response.text).not.toContain('5hQA');
    expect(response.text).not.toContain(`${SK}proj`);
    expect(response.text).not.toContain('***');
    expect(response.text).not.toContain(`${SK}...`);
    await stack.closeAndScan({ markerInTraces: true, forbidden: ['5hQA', `${SK}proj`, `${SK}...`] });
  });

  it('redacts the trimmed key when the env value has surrounding whitespace', async (context) => {
    const stack = await startKeyedStack(context, echo401(`Incorrect API key provided: ${TEST_API_KEY}`), { keyValue: `  ${TEST_API_KEY}  ` });
    const response = await post(stack.client, body);
    expect(response.status).toBe(401);
    expect(JSON.parse(response.text).error.message).toBe(REDACTED_401);
    await stack.closeAndScan({ markerInTraces: true });
  });
});

describe('T2: no cut before redaction, and the 64 KiB read drops a cut token', () => {
  it('redacts a key at character 485 of a 700-character non-JSON body and keeps the rest of the body', async (context) => {
    const tail = 'END-OF-BODY';
    const raw = `${'w'.repeat(484)}${TEST_API_KEY}${'w'.repeat(183)}${tail}`;
    expect(JSON.stringify(raw)).toHaveLength(700);
    expect(JSON.stringify(raw).indexOf(TEST_API_KEY)).toBe(485);
    const stack = await startKeyedStack(context, rawBody401(raw));
    const response = await post(stack.client, body);
    expect(response.status).toBe(401);
    const message = JSON.parse(response.text).error.message as string;
    expectRedacted(message, TEST_API_KEY);
    expect(message.endsWith(`${tail}"`)).toBe(true);
    await stack.closeAndScan();
  });

  it('drops the partial key at the 64 KiB cut after a star run collapses into one marker', async (context) => {
    const starCount = MAX_ERROR_BODY_BYTES - 8 - 2;
    const raw = `${'*'.repeat(starCount - 1)}a ${TEST_API_KEY} ${'tail '.repeat(100)}`;
    const served = JSON.stringify(raw);
    expect(served.indexOf(TEST_API_KEY)).toBe(MAX_ERROR_BODY_BYTES - 8);
    expect(served.slice(MAX_ERROR_BODY_BYTES - 8, MAX_ERROR_BODY_BYTES)).toBe('momonga-');
    const stack = await startKeyedStack(context, rawBody401(raw));
    const response = await post(stack.client, body);
    expect(response.status).toBe(401);
    const message = JSON.parse(response.text).error.message as string;
    expect(message.length).toBeLessThan(100);
    expectRedacted(message, TEST_API_KEY);
    await stack.closeAndScan();
  });
});

describe('T2: the 64 KiB read drops a cut token that carries an escape', () => {
  it('drops a key echoed with \\/ escapes when the cut lands after the escape', async (context) => {
    const key = 'momonga/test/api-key-01';
    const echoed = key.replaceAll('/', '\\/');
    const raw = `${'*'.repeat(MAX_ERROR_BODY_BYTES - 15)}a ${echoed} ${'tail '.repeat(100)}`;
    const served = JSON.stringify(raw);
    const servedKey = JSON.stringify(echoed).slice(1, -1);
    expect(served.indexOf(servedKey)).toBe(MAX_ERROR_BODY_BYTES - 12);
    expect(served.slice(MAX_ERROR_BODY_BYTES - 12, MAX_ERROR_BODY_BYTES)).toBe('momonga\\\\/te');
    const stack = await startKeyedStack(context, rawBody401(raw), { keyValue: key });
    const response = await post(stack.client, body);
    expect(response.status).toBe(401);
    const message = JSON.parse(response.text).error.message as string;
    expect(message).toContain(REDACTED);
    for (const form of [key, echoed, servedKey]) expectNoCredential(message, form);
    await stack.closeAndScan();
  });
});

describe('T3: upstream text inside the stream', () => {
  it('keeps a mid-stream {"error":…} chunk text out of the output (P3a stays closed)', async (context) => {
    const upstreamText = `upstream said ${TEST_API_KEY}`;
    const reply: FakeScriptedReply = {
      kind: 'raw-sse',
      events: [
        JSON.stringify({ id: 'chatcmpl-raw', object: 'chat.completion.chunk', created: 0, model: 'system', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] }),
        JSON.stringify({ error: { message: upstreamText } }),
      ],
    };
    const stack = await startKeyedStack(context, reply);
    const frames = await sseFramesOf(stack.client, { ...body, stream: true });
    expect(JSON.parse(frames.at(-1) ?? '{}').type).toBe('response.failed');
    const all = frames.join('\n');
    expect(all).not.toContain('upstream said');
    expectNoCredential(all, TEST_API_KEY);
    await stack.closeAndScan();
  });

  it.for([true, false])('redacts a finish_reason that echoes the key (stream %s)', async (stream, context) => {
    const reply: FakeScriptedReply = {
      kind: 'stream',
      chunks: [{ delta: { role: 'assistant', content: 'partial' } }, { delta: {}, finishReason: TEST_API_KEY }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    };
    const stack = await startKeyedStack(context, reply);
    if (stream) {
      const frames = await sseFramesOf(stack.client, { ...body, stream: true });
      const failed = frames.map((frame) => JSON.parse(frame)).find((frame) => frame.type === 'response.failed');
      expect(failed).toBeDefined();
      expectRedacted(JSON.stringify(failed), TEST_API_KEY);
      for (const frame of frames) expectNoCredential(frame, TEST_API_KEY);
    } else {
      const response = await post(stack.client, { ...body, stream: false });
      expect(response.status).toBe(502);
      expectRedacted(response.text, TEST_API_KEY);
    }
    await stack.closeAndScan();
  });
});

describe('T4: compaction over the process gateway', () => {
  it('redacts the 401 echo on /v1/responses/compact', async (context) => {
    const stack = await startKeyedStack(context, echo401(`Incorrect API key provided: ${TEST_API_KEY}`));
    const response = await stack.client.request({
      method: 'POST',
      path: '/v1/responses/compact',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fast',
        input: [
          ...userInput('Fix the parser bug'),
          { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{"path":"src/parse.ts"}' },
          { type: 'function_call_output', call_id: 'c1', output: 'export const parse = 1;' },
        ],
      }),
    });
    const text = await response.text();
    expect(response.status).toBe(401);
    expectRedacted(text, TEST_API_KEY);
    await stack.closeAndScan();
  });
});

type FmStackOptions = {
  exec: NonNullable<Parameters<typeof startGatewayProcess>[0]['exec']>;
  execWithStdin?: NonNullable<Parameters<typeof startGatewayProcess>[0]['execWithStdin']>;
};

const startFmStack = async (context: CleanupContext, options: FmStackOptions) => {
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok' });
  registerCleanup(context, () => fake.close());
  const fm = await createFakeFm({ dir: withTempDir(context) });
  const dumpFile = path.join(path.dirname(fm.binaryPath), 'env.jsonl');
  fm.configure({ envDumpFile: dumpFile });
  registerCleanup(context, () => {
    const pids = fs.existsSync(dumpFile)
      ? fs
          .readFileSync(dumpFile, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as { argv: string[]; pid: number })
          .filter((record) => record.argv[0] === 'serve')
          .map((record) => record.pid)
      : [];
    return killGroupsForCleanup(pids);
  });
  const home = withTempDir(context, { asHome: true });
  prepareHome(home);
  writeSettings(home, {
    models: {
      aliases: { default: ['fm'], keyed: ['cc'] },
      targets: { fm: { adapter: 'managed', server: 'fm', toolCalling: 'native' }, cc: ccTarget(fake.socketPath, { apiKeyEnv: TEST_API_KEY_ENV }) },
    },
  });
  await placeFakeFm(home, fm.binaryPath);
  const handle = await ownedStart(context, startGatewayProcess({
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home, { [TEST_API_KEY_ENV]: TEST_API_KEY }),
    version: PROCESS_VERSION,
    exec: options.exec,
    ...(options.execWithStdin === undefined ? {} : { execWithStdin: options.execWithStdin }),
    stdout: { write: () => true },
    logger: createJsonLogger({ service: 'gateway', clock: systemClock, stream: captureLog() }),
  }));
  registerCleanup(
    context,
    async () => {
      await handle.close();
    },
    gatewayMaxCloseMs(DEFAULT_STOP_VALUES),
  );
  const client = createUdsClient(fixedSocket(handle.socketPath));
  registerCleanup(context, () => client.close());
  return { client };
};

describe('T5: fm text with a configured key on another target', () => {
  it('redacts the fm license output in GET /v1/momonga/health', async (context) => {
    const exec: FmStackOptions['exec'] = async (file, args) =>
      args[0] === 'license' ? { exitCode: 1, stdout: `license status: ${TEST_API_KEY}`, stderr: '' } : fakeExec(file, args);
    const { client } = await startFmStack(context, { exec });
    const response = await client.request({ method: 'GET', path: '/v1/momonga/health' });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text).targets.fm).toMatchObject({ ok: false, reason: 'precondition_failed', detail: `license status: ${REDACTED}` });
    expectRedacted(text, TEST_API_KEY);
  });

  it('redacts fm count-tokens stderr in a 502 adapter_error', async (context) => {
    const { client } = await startFmStack(context, {
      exec: fakeExec,
      execWithStdin: async () => ({ exitCode: 2, stdout: '', stderr: `bad ${TEST_API_KEY}` }),
    });
    const response = await client.request({
      method: 'POST',
      path: '/v1/momonga/count_tokens',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'default', input: 'one two three' }),
    });
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(JSON.parse(text).error).toMatchObject({ code: 'adapter_error', message: `the target "fm": the token counter failed with exit code 2: bad ${REDACTED}` });
    expectRedacted(text, TEST_API_KEY);
  });
});
