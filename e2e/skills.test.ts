import { PERSON_CAPABILITY_HEADER } from '@momonga/protocol';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUdsClient, fixedSocket } from '@momonga/foundation';
import { ESTIMATED_CHARACTERS_PER_TOKEN } from '@momonga/protocol';
import { DEFAULT_KEEP_RECENT_TURNS } from '../packages/context/src/levels.ts';
import { isCompactionRequest, journalOfRows, ofType, overflowStepRange, stackPinsOf, summaryRoute, wireTokensOfBody } from './support/budget.ts';
import type { JournalEvent } from './support/budget.ts';
import { skipCase, titleOf } from './support/cases.ts';
import { readDb } from './support/db.ts';
import { createE2eHome } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { SESSION_PATH, createRuntimeClient } from './support/runtime-client.ts';
import { personCapabilityOfHome } from './support/runtime-client.ts';
import { platformSandbox, sandboxOrSkip } from './support/sandbox.ts';
import type { RuntimeClient } from './support/runtime-client.ts';
import { startStack } from './support/stack.ts';
import { chatCompletions, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS } from './support/wait.ts';
import { firstGeneration, standInEnv } from '@momonga/testkit';

const BODY_MARKER = 'PDF-SKILL-BODY-MARKER-4f7a';
const GUIDE_MARKER = 'PDF-GUIDE-RESOURCE-MARKER-9c1e';
const SUMMARY = 'The user asked about a pdf. The pdf skill was activated and several small files were read. Next step: report the result.';
const LONG_REQUESTS = 3;
const FIRST_TASK = 'Read the pdf';

type EventRow = { seq: number; type: string; payload_json: string };

const writeSkill = (root: string, name: string, description: string, resources: Record<string, string> = {}): string => {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# PDF\n\n${BODY_MARKER}\n\nRun scripts/extract.py on the file.\n`);
  for (const [relative, text] of Object.entries(resources)) {
    fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
    fs.writeFileSync(path.join(directory, relative), text);
  }
  return directory;
};

const journalOf = (home: E2eHome, runId: string): JournalEvent[] =>
  journalOfRows(readDb<EventRow>(home.paths.databases.runtime, 'SELECT seq, type, payload_json FROM events WHERE run_id = ? ORDER BY seq', runId));

const statusOf = (home: E2eHome, runId: string): { status: string; stopReason: string | null; error: string | null } =>
  readDb<{ status: string; stop_reason: string | null; error_json: string | null }>(
    home.paths.databases.runtime,
    'SELECT status, stop_reason, error_json FROM runs WHERE id = ?',
    runId,
  ).map((row) => ({ status: row.status, stopReason: row.stop_reason, error: row.error_json }))[0] ?? { status: 'missing', stopReason: null, error: null };

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

type LongRequestSizing = { prefix: number; requestTokens: number; requests: string[] };

const longRequestText = (index: number, tokens: number): string => {
  const chars = ESTIMATED_CHARACTERS_PER_TOKEN * tokens;
  return `Request ${index + 1}. ${`filler words about unrelated subjects ${index} `.repeat(chars)}`.slice(0, chars);
};

const longRequestSizing = async (home: E2eHome, firstRunId: string, requestsOfFirstRun: readonly { body: unknown }[]): Promise<LongRequestSizing> => {
  const lastRequest = requestsOfFirstRun.at(-1);
  expect(lastRequest, `the first run made no model request (${JSON.stringify(statusOf(home, firstRunId))}), so the fixed prefix no longer fits`).toBeDefined();
  const started = ofType(journalOf(home, firstRunId), 'run.started')[0];
  const pins = stackPinsOf(started?.data['pins']);
  const prefix = wireTokensOfBody(lastRequest?.body);
  const range = await overflowStepRange(pins, prefix, LONG_REQUESTS);
  const requestTokens = range.lowest;
  const requests = Array.from({ length: LONG_REQUESTS }, (_, index) => longRequestText(index, requestTokens));
  return { prefix, requestTokens, requests };
};

const runToEnd = async (runtime: RuntimeClient, runId: string): Promise<void> => {
  const stream = runtime.events(runId);
  await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
  await stream.close();
};

type Json = Record<string, any>;

const rawClient = (home: E2eHome) => {
  const client = createUdsClient(fixedSocket(firstGeneration(home.paths).sockets.runtime), { connectTimeoutMs: 0 });
  const call = async (method: string, target: string, body?: unknown): Promise<{ status: number; json: Json }> => {
    const response = await client.request({
      method,
      path: target,
      headers: { [PERSON_CAPABILITY_HEADER]: await personCapabilityOfHome(home), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Json) };
  };
  return { call, close: () => client.close() };
};

const trust = async (home: E2eHome): Promise<void> => {
  const raw = rawClient(home);
  try {
    const response = await raw.call('PUT', '/v1/trust', { path: home.project, decision: 'trusted' });
    expect(response.status).toBe(200);
  } finally {
    await raw.close();
  }
};

const createSession = async (home: E2eHome, permissionMode: string): Promise<string> => {
  const raw = rawClient(home);
  try {
    const response = await raw.call('POST', '/v1/sessions', {
      cwd: home.project,
      env: { HOME: home.home, ...standInEnv(SESSION_PATH), TMPDIR: home.sessionTmp },
      permissionMode,
      bypassAllowed: permissionMode === 'bypassPermissions',
    });
    expect(response.status).toBe(201);
    return response.json['session'].id as string;
  } finally {
    await raw.close();
  }
};

describe('g: agent skills', () => {
  it(titleOf('g-skills'), { timeout: 4 * E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    writeSkill(path.join(home.project, '.agents', 'skills'), 'pdf', 'Extract PDF text. Use when: the user mentions PDFs', { 'scripts/extract.py': 'print(1)' });
    const script = [toolCallReply('activate_skill', { name: 'pdf' }, 'call_skill'), textReply('The pdf skill is active.')];
    for (let index = 0; index < LONG_REQUESTS; index += 1) script.push(textReply(`Noted ${index + 1}.`));
    const stack = await startStack({
      home,
      script,
      routes: [summaryRoute(SUMMARY)],
    });
    await trust(home);
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const first = (await runtime.createRun(session.id, FIRST_TASK)).run;
      await runToEnd(runtime, first.id);
      const sizing = await longRequestSizing(home, first.id, chatCompletions(stack.fake));
      const later: string[] = [];
      for (const long of sizing.requests) {
        const { run } = await runtime.createRun(session.id, long);
        await runToEnd(runtime, run.id);
        later.push(run.id);
      }

      for (const runId of [first.id, ...later]) expect(statusOf(home, runId)).toEqual({ status: 'COMPLETED', stopReason: null, error: null });
      const journal = journalOf(home, first.id);

      const posts = chatCompletions(stack.fake);
      const firstRequest = JSON.stringify(posts[0]?.body);
      expect(firstRequest).toContain('<available_skills>');
      expect(firstRequest).toContain('<name>pdf</name>');
      expect(firstRequest).toContain('Extract PDF text. Use when: the user mentions PDFs');
      expect(firstRequest).toContain('activate_skill');
      expect(firstRequest).not.toContain(BODY_MARKER);

      const call = ofType(journal, 'tool.call').find((event) => event.data['name'] === 'activate_skill');
      expect(call?.data['rawInput']).toEqual({ name: 'pdf' });
      const completed = ofType(journal, 'tool.completed')[0];
      expect(String(completed?.data['output'])).toContain('<skill_content name="pdf">');
      expect(String(completed?.data['output'])).toContain(BODY_MARKER);
      expect(String(completed?.data['output'])).toContain('<file>scripts/extract.py</file>');
      expect(String(completed?.data['output'])).not.toContain('print(1)');
      expect(ofType(journal, 'skill.activated').map((event) => event.data['name'])).toEqual(['pdf']);
      for (const runId of later) expect(ofType(journalOf(home, runId), 'skill.activated')).toEqual([]);

      const compactions = later.flatMap((runId) => ofType(journalOf(home, runId), 'context.compacted'));
      expect(compactions.length, `each of ${LONG_REQUESTS} requests holds ${sizing.requestTokens} tokens, the smallest size at which the last request stops fitting after the report of the one before it, after the ${sizing.prefix}-token request that ended the first run`).toBeGreaterThanOrEqual(1);
      const firstCompactionPost = posts.findIndex((post) => isCompactionRequest(post.body));
      expect(firstCompactionPost).toBeGreaterThan(1);
      const afterCompaction = posts.slice(firstCompactionPost + 1).filter((post) => !isCompactionRequest(post.body));
      expect(afterCompaction.length).toBeGreaterThanOrEqual(1);
      for (const post of posts.slice(1)) {
        expect(occurrences(JSON.stringify(post.body), BODY_MARKER), 'the activated skill survives the compaction and stays out of the summary request').toBe(isCompactionRequest(post.body) ? 0 : 1);
      }
      for (const post of posts.filter((candidate) => !isCompactionRequest(candidate.body))) {
        const tools = (post.body as { tools?: { function?: { name?: string } }[] }).tools ?? [];
        expect(tools.map((tool) => tool.function?.name)).toContain('activate_skill');
      }
      for (const [turn, runId] of [first.id, ...later].entries()) {
        const journalOfRun = journalOf(home, runId);
        const reductions = ofType(journalOfRun, 'context.compacted').map(() => ({ code: 'recent_turns_shrunk', reduction: { turn, from: DEFAULT_KEEP_RECENT_TURNS, to: 1 } }));
        expect(ofType(journalOfRun, 'notice').map((event) => ({ code: event.data['code'], reduction: event.data['reduction'] }))).toEqual(reductions);
      }
    } finally {
      await runtime.close();
    }
  });

  it(titleOf('g-skills-explicit'), { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const directory = writeSkill(path.join(home.project, '.agents', 'skills'), 'pdf', 'Extract PDF text');
    const stack = await startStack({ home, script: [textReply('Started with the skill.')] });
    await trust(home);
    const raw = rawClient(home);
    const runtime = createRuntimeClient(home);
    try {
      const sessionId = await createSession(home, 'bypassPermissions');
      const listed = await raw.call('GET', `/v1/sessions/${sessionId}/skills`);
      expect(listed).toEqual({
        status: 200,
        json: { skills: [{ name: 'pdf', description: 'Extract PDF text', scope: 'project', location: path.join(directory, 'SKILL.md') }], warnings: [] },
      });

      const created = await raw.call('POST', `/v1/sessions/${sessionId}/runs`, { input: 'Summarize the attached file', skill: 'pdf' });
      expect(created.status).toBe(202);
      const runId = created.json['run'].id as string;
      await runToEnd(runtime, runId);

      expect(statusOf(home, runId)).toEqual({ status: 'COMPLETED', stopReason: null, error: null });
      const journal = journalOf(home, runId);
      expect(journal.map((event) => event.type).slice(0, 2)).toEqual(['user.message', 'skill.activated']);
      expect(ofType(journal, 'tool.call')).toEqual([]);
      const posts = chatCompletions(stack.fake);
      expect(posts).toHaveLength(1);
      const request = JSON.stringify(posts[0]?.body);
      expect(occurrences(request, BODY_MARKER)).toBe(1);
      expect(request).toContain('Activated skill pdf');
      expect(request).toContain('Summarize the attached file');

      const publicEvents = runtime.events(runId);
      const frames = await publicEvents.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await publicEvents.close();
      const activated = frames.find((frame) => frame.data.type === 'skill.activated');
      expect(activated?.data['name']).toBe('pdf');
      expect(JSON.stringify(frames)).not.toContain(BODY_MARKER);

      const unknown = await raw.call('POST', `/v1/sessions/${sessionId}/runs`, { input: 'x', skill: 'nope' });
      expect(unknown.status).toBe(422);
      expect(unknown.json['error']).toMatchObject({ code: 'unknown_skill', param: 'skill' });
    } finally {
      await raw.close();
      await runtime.close();
    }
  });

  it(titleOf('g-skills-resources'), { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const directory = writeSkill(home.paths.skills, 'pdf', 'Extract PDF text', { 'references/guide.md': `${GUIDE_MARKER}\n` });
    const guide = path.join(directory, 'references', 'guide.md');
    const stack = await startStack({
      home,
      script: [
        toolCallReply('activate_skill', { name: 'pdf' }, 'call_skill'),
        toolCallReply('Read', { file_path: guide }, 'call_guide'),
        toolCallReply('Read', { file_path: home.paths.settingsFile }, 'call_settings'),
        textReply('Read the guide.'),
      ],
    });
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'manual' });
      const { run } = await runtime.createRun(session.id, 'Use the pdf guide');
      await runToEnd(runtime, run.id);

      expect(statusOf(home, run.id)).toEqual({ status: 'COMPLETED', stopReason: null, error: null });
      const journal = journalOf(home, run.id);
      expect(ofType(journal, 'tool.permission.requested')).toEqual([]);
      const completed = ofType(journal, 'tool.completed');
      expect(completed).toHaveLength(3);
      expect(String(completed[0]?.data['output'])).toContain('<file>references/guide.md</file>');
      expect(completed[1]?.data['status']).toBe('completed');
      expect(String(completed[1]?.data['output'])).toContain(GUIDE_MARKER);
      expect(completed[2]?.data['status']).toBe('failed');
      expect(String(completed[2]?.data['output'])).toContain('is blocked by the sandbox policy');
      expect(String(completed[2]?.data['output'])).toContain(home.paths.settingsFile);
      expect(chatCompletions(stack.fake)).toHaveLength(4);
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(skipCase('g-skills-bash-resource'))(titleOf('g-skills-bash-resource'), { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const directory = writeSkill(home.paths.skills, 'pdf', 'Extract PDF text', { 'references/guide.md': `${GUIDE_MARKER}\n` });
    const guide = path.join(directory, 'references', 'guide.md');
    const stack = await startStack({
      home,
      needsBash: true,
      script: [
        toolCallReply('activate_skill', { name: 'pdf' }, 'call_skill'),
        toolCallReply('Bash', { command: `cat '${guide}'; echo rc=$?` }, 'call_guide'),
        toolCallReply('Bash', { command: `cat '${home.paths.settingsFile}'; echo rc=$?` }, 'call_settings'),
        textReply('Read the guide.'),
      ],
    });
    expect(stack.sandbox).toBe(platformSandbox());
    const runtime = createRuntimeClient(home);
    try {
      expect((await runtime.health()).sandbox).toBe(platformSandbox());
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Use the pdf guide');
      await runToEnd(runtime, run.id);

      expect(statusOf(home, run.id)).toEqual({ status: 'COMPLETED', stopReason: null, error: null });
      const completed = ofType(journalOf(home, run.id), 'tool.completed');
      expect(completed).toHaveLength(3);
      expect(String(completed[1]?.data['output'])).toContain(GUIDE_MARKER);
      expect(String(completed[1]?.data['output'])).toContain('rc=0');
      expect(String(completed[2]?.data['output'])).toContain(`reading ${home.paths.settingsFile} is denied in every permission mode`);
      expect(String(completed[2]?.data['output'])).not.toContain('rc=');
      expect(chatCompletions(stack.fake)).toHaveLength(4);
    } finally {
      await runtime.close();
    }
  });

  it(titleOf('g-skills-untrusted'), { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const skills = path.join(home.project, '.agents', 'skills');
    writeSkill(skills, 'pdf', 'Extract PDF text');
    const stack = await startStack({ home, script: [textReply('No skills here.')] });
    const raw = rawClient(home);
    const runtime = createRuntimeClient(home);
    try {
      const sessionId = await createSession(home, 'bypassPermissions');
      const listed = await raw.call('GET', `/v1/sessions/${sessionId}/skills`);
      expect(listed.json).toEqual({ skills: [], warnings: [`Project skills in ${skills} were skipped because the folder is not trusted`] });

      const unknown = await raw.call('POST', `/v1/sessions/${sessionId}/runs`, { input: 'x', skill: 'pdf' });
      expect(unknown.status).toBe(422);
      expect(unknown.json['error']).toMatchObject({ code: 'unknown_skill' });

      const { run } = await runtime.createRun(sessionId, 'Say hello');
      await runToEnd(runtime, run.id);
      const request = JSON.stringify(chatCompletions(stack.fake)[0]?.body);
      expect(request).not.toContain('available_skills');
      expect(request).not.toContain('activate_skill');
      const notices = ofType(journalOf(home, run.id), 'notice').map((event) => event.data['message']);
      expect(notices).toEqual([`Project skills in ${skills} were skipped because the folder is not trusted`]);
    } finally {
      await raw.close();
      await runtime.close();
    }
  });
});
