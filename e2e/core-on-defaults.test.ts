import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MEMORY_SHARE } from '@momonga/memory';
import { createBuiltinTools } from '@momonga/tools';
import cliPackage from '../packages/cli/package.json' with { type: 'json' };
import { journalOfRows, ofType } from './support/budget.ts';
import { titleOf } from './support/cases.ts';
import { runCli } from './support/cli.ts';
import { readDb } from './support/db.ts';
import { createE2eHome } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import type { RuntimeClient } from './support/runtime-client.ts';
import { baseSettings, shutdownBarrier, startStack, withStructuredRole } from './support/stack.ts';
import { chatCompletions, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

type EventRow = { seq: number; type: string; payload_json: string };
type ChatTool = { type: string; function: { name: string; description: string } };

const NOTE = 'The answer constant lives in answer.ts and is 42.';
const REFLECTION_ALIAS = 'reflector';

const emptyHomeSettings = (home: E2eHome, extra: Readonly<Record<string, unknown>> = {}): string => {
  const base = baseSettings(home, 'none');
  const ripgrep = (base['tools'] as { ripgrep: string }).ripgrep;
  return JSON.stringify({ ...extra, models: extra['models'] ?? base['models'], tools: { ripgrep } }, null, 2);
};

const journalOf = (home: E2eHome, runId: string) =>
  journalOfRows(readDb<EventRow>(home.paths.databases.runtime, 'SELECT seq, type, payload_json FROM events WHERE run_id = ? ORDER BY seq', runId));

const runToEnd = async (runtime: RuntimeClient, runId: string) => {
  const stream = runtime.events(runId);
  const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
  await stream.close();
  return frames;
};

const ONE_ASK_FOR_THE_WRITE_THE_ECHO_IS_READ_ONLY = 1;

const approveEachAsk = async (runtime: RuntimeClient, runId: string, asks: number): Promise<void> => {
  for (let handled = 0; handled < asks; handled += 1) {
    const [pending] = await until(async () => {
      const found = await runtime.approvals(runId);
      return found.length === 0 ? undefined : found;
    }, { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `approval ${handled + 1} of run ${runId}` });
    if (pending === undefined) throw new Error('no pending approval');
    expect((await runtime.resolveApproval(pending.id, 'allow_once')).status).toBe(200);
  }
};

const trust = async (runtime: RuntimeClient, project: string): Promise<void> => {
  const response = await runtime.json('PUT', '/v1/trust', { path: project, decision: 'trusted' });
  expect(response.status).toBe(200);
};

describe('the core areas on by default (design core-on 6, test 11)', () => {
  it(titleOf('core-on-token-defaults'), { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home, version: cliPackage.version, settingsText: emptyHomeSettings(home), script: [textReply('Done.')] });
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'manual' });
      const { run } = await runtime.createRun(session.id, 'Say done');
      expect((await runToEnd(runtime, run.id)).at(-1)?.data['to']).toBe('COMPLETED');

      const pins = ofType(journalOf(home, run.id), 'run.started')[0]?.data['pins'] as Record<string, unknown> | undefined;
      expect(pins?.['token']).toEqual({
        cachePrefix: true,
        conciseDescriptions: true,
        outputFormatters: ['log', 'json', 'grep', 'identicalOutput'],
        loopGuidance: true,
        observedCapacity: true,
        deferred: [],
      });
      expect(pins?.['memoryShare']).toBe(DEFAULT_MEMORY_SHARE);

      const offered = ((chatCompletions(stack.fake)[0]?.body as { tools?: ChatTool[] }).tools ?? []).find((tool) => tool.function.name === 'Read');
      const read = createBuiltinTools().find((tool) => tool.name === 'Read');
      expect(read?.conciseDescription).toBeDefined();
      expect(offered?.function.description).toBe(read?.conciseDescription);
    } finally {
      await runtime.close();
    }
    await shutdownBarrier(stack);
  });

  it(titleOf('core-on-memory-defaults'), { timeout: 3 * E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const project = fs.realpathSync.native(home.project);
    const stack = await startStack({
      home,
      version: cliPackage.version,
      settingsText: emptyHomeSettings(home, withStructuredRole({ models: baseSettings(home, 'none')['models'], verification: { commands: ['echo verified'] } }, 'reflection', REFLECTION_ALIAS)),
      script: [
        toolCallReply('Write', { file_path: path.join(project, 'answer.ts'), content: 'export const answer = 42;\n' }, 'call_write'),
        toolCallReply('Bash', { command: 'echo verified' }, 'call_check'),
        textReply('Wrote answer.ts and checked it.'),
        textReply(JSON.stringify({ candidates: [{ text: NOTE, kind: 'fact', paths: ['answer.ts'] }] })),
      ],
    });
    const runtime = createRuntimeClient(home);
    try {
      await trust(runtime, project);
      const { session } = await runtime.createSession({ permissionMode: 'manual' });
      const { run } = await runtime.createRun(session.id, 'Write answer.ts and run the check');
      await approveEachAsk(runtime, run.id, ONE_ASK_FOR_THE_WRITE_THE_ECHO_IS_READ_ONLY);
      expect((await runToEnd(runtime, run.id)).at(-1)?.data['to']).toBe('COMPLETED');

      const review = await until(
        async () => {
          const listed = await runCli(home, ['memory', 'review']);
          return listed.stdout.includes(NOTE) ? listed : undefined;
        },
        { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, intervalMs: 250, description: 'the reflection of the verified run under the default settings' },
      );
      expect(review.stdout).toContain('reflection candidate 0');
      expect(chatCompletions(stack.fake)).toHaveLength(4);
    } finally {
      await runtime.close();
    }
    await shutdownBarrier(stack);
  });
});
