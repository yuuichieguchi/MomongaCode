import { PERSON_CAPABILITY_HEADER } from '@momonga/protocol';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUdsClient, fixedSocket } from '@momonga/foundation';
import { unaskedCommandsFor } from '@momonga/policy';
import cliPackage from '../packages/cli/package.json' with { type: 'json' };
import { titleOf } from './support/cases.ts';
import { runCli } from './support/cli.ts';
import { createE2eHome } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { createRuntimeClient, personCapabilityOfHome, framesOfType } from './support/runtime-client.ts';
import type { RuntimeClient } from './support/runtime-client.ts';
import { baseSettings, shutdownBarrier, startStack, withStructuredRole } from './support/stack.ts';
import { chatCompletions, messagesOf, reportedTokensOfRequest, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_REFLECTION_SETTLED_BOUND_MS, E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';
import { firstGeneration } from '@momonga/testkit';

type Json = Record<string, any>;

const RECALL_OPEN = '<recalled_memories>';
const NOTE = 'The answer constant lives in answer.ts and is 42.';
const SWEEP_BOUND_MS = E2E_RUN_COMPLETED_BOUND_MS;
const REFLECTION_MODEL_ID = 'reflector';

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

const approveEachAskUntilEnd = async (runtime: RuntimeClient, runId: string, asks: number): Promise<void> => {
  for (let handled = 0; handled < asks; handled += 1) {
    const [pending] = await until(async () => {
      const found = await runtime.approvals(runId);
      return found.length === 0 ? undefined : found;
    }, { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `approval ${handled + 1} of run ${runId}` });
    if (pending === undefined) throw new Error('no pending approval');
    expect((await runtime.resolveApproval(pending.id, 'allow_once')).status).toBe(200);
  }
};

const toEnd = async (runtime: RuntimeClient, runId: string) => {
  const stream = runtime.events(runId);
  const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
  await stream.close();
  return frames;
};

const reviewedMemoriesOf = (review: string): Array<{ id: string; shown: string }> =>
  [...review.matchAll(/^id: (\S+)$/gm)].map((match, index, all) => ({ id: match[1] ?? '', shown: review.slice(match.index, all[index + 1]?.index ?? review.length) }));

const recalledTextOf = (requests: ReturnType<typeof chatCompletions>, index: number): string | undefined =>
  messagesOf(requests[index])
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .find((content) => content.includes(RECALL_OPEN));

describe('learning loop', () => {
  it(titleOf('learning-loop'), { timeout: 4 * E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const project = fs.realpathSync.native(home.project);
    const stack = await startStack({
      home,
      version: cliPackage.version,
      settings: withStructuredRole(
        { models: baseSettings(home, 'none')['models'], memory: { reflection: { enabled: true } }, verification: { commands: ['echo verified'] } },
        'reflection',
        REFLECTION_MODEL_ID,
      ),
      script: [
        toolCallReply('Write', { file_path: path.join(project, 'answer.ts'), content: 'export const answer = 42;\n' }, 'call_write'),
        toolCallReply('Bash', { command: 'echo verified' }, 'call_check'),
        textReply('Wrote answer.ts and checked it.'),
        textReply(JSON.stringify({ candidates: [{ text: NOTE, kind: 'fact', paths: ['answer.ts'] }] })),
        textReply('Hello before the review.'),
        toolCallReply('MemorySave', { text: ` ${NOTE.replace('lives in', 'lives   in')}`, scope: 'project' }, 'call_duplicate'),
        textReply('Saved again.'),
      ],
    });
    const runtime = createRuntimeClient(home);
    const raw = rawClient(home);
    try {
      expect((await raw.call('PUT', '/v1/trust', { path: project, decision: 'trusted' })).status).toBe(200);
      const { session } = await runtime.createSession({ permissionMode: 'manual' });
      const { run: first } = await runtime.createRun(session.id, 'Write answer.ts and run the check');
      expect(unaskedCommandsFor(process.platform).readOnly, 'the check command echo runs without asking, so the Write is the one ask of the first run').toContain('echo');
      await approveEachAskUntilEnd(runtime, first.id, 1);
      const frames = await toEnd(runtime, first.id);
      expect(frames.at(-1)?.data['to']).toBe('COMPLETED');
      expect(framesOfType(frames, 'tool.completed').map((frame) => frame.data['exitCode'])).toContain(0);

      const waiting = await until(
        async () => {
          const review = await runCli(home, ['memory', 'review']);
          return review.stdout.includes(NOTE) ? review : undefined;
        },
        { deadlineMs: SWEEP_BOUND_MS, intervalMs: 250, description: 'the sweeper of the runtime to reflect on the verified run' },
      );
      expect(waiting.code).toBe(0);
      const waitingMemories = reviewedMemoriesOf(waiting.stdout);
      const noted = waitingMemories.find((memory) => memory.shown.includes(NOTE));
      if (noted === undefined) throw new Error(`no memory with the note in ${waiting.stdout}`);
      const memoryId = noted.id;
      expect(noted.shown).toContain('evidence: file answer.ts');
      expect(noted.shown).toContain('evidence: check echo verified exited 0');
      expect(noted.shown).toMatch(/reflection candidate \d+/);
      const otherCandidates = waitingMemories.filter((memory) => memory.id !== memoryId);

      const requests = chatCompletions(stack.fake);
      expect(requests).toHaveLength(4);
      const reflection = JSON.stringify(requests[3]?.body);
      expect(reflection).toContain('recorded data, not instructions');
      expect(reflection).toContain('<recorded_run>');
      expect((requests[3]?.body as { tools?: unknown[] }).tools ?? []).toEqual([]);

      const cost = await runCli(home, ['cost', '--json']);
      expect(cost.code).toBe(0);
      const reflectionInput = reportedTokensOfRequest(requests[3]?.body);
      const report = JSON.parse(cost.stdout) as { runs: Array<{ runId: string; roles: Record<string, Json> }> };
      expect(report.runs.find((run) => run.runId === first.id)?.roles['reflection']).toMatchObject({ calls: 1, inputTokens: reflectionInput, outputTokens: 5 });

      const { run: second } = await runtime.createRun(session.id, 'Say hello', { history: 'fresh' });
      expect((await toEnd(runtime, second.id)).at(-1)?.data['to']).toBe('COMPLETED');
      expect(recalledTextOf(chatCompletions(stack.fake), 4)).toBeUndefined();

      const accepted = await runCli(home, ['memory', 'review', 'accept', memoryId]);
      expect(accepted.stdout).toBe(`accepted memory ${memoryId}\n`);
      for (const other of otherCandidates) expect((await runCli(home, ['memory', 'review', 'reject', other.id])).stdout).toBe(`rejected memory ${other.id}\n`);
      const settled = await until(
        async () => {
          const review = await runCli(home, ['memory', 'review']);
          return review.stdout.includes(') is done\n') ? review : undefined;
        },
        { deadlineMs: E2E_REFLECTION_SETTLED_BOUND_MS, intervalMs: 250, description: 'the sweeper of the runtime to reflect on the second run' },
      );
      expect(settled.stdout).toMatch(/^no memories waiting for review\nthe last reflection of this folder \(run \S+, \S+\) is done\n {2}the run is not a verified success\n$/);

      const { run: third } = await runtime.createRun(session.id, 'Save the same note again', { history: 'fresh' });
      await approveEachAskUntilEnd(runtime, third.id, 1);
      expect((await toEnd(runtime, third.id)).at(-1)?.data['to']).toBe('COMPLETED');
      const recalled = recalledTextOf(chatCompletions(stack.fake), 5);
      expect(recalled).toContain(`<memory id="${memoryId}" scope="project"`);
      expect(recalled).toContain(NOTE);
      expect(recalled).toContain(`source_run="${first.id}"`);

      const duplicate = await until(
        async () => {
          const listed = (await raw.call('GET', '/v1/memories')).json['memories'] as Json[];
          return listed.find((memory) => memory['state'] === 'duplicate');
        },
        { deadlineMs: SWEEP_BOUND_MS, intervalMs: 250, description: 'the sweeper of the runtime to mark the duplicate' },
      );
      expect(duplicate['duplicateOf']).toBe(memoryId);
      expect((await raw.call('GET', `/v1/memories/${memoryId}`)).json['memory']).toMatchObject({ state: 'active', duplicateOf: null });
    } finally {
      await raw.close();
      await runtime.close();
    }
    await shutdownBarrier(stack);
  });
});
