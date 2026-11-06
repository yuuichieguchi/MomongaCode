import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectProcessLock, isProcessAlive, momongaLayout } from '@momonga/foundation';
import type { FakeRoute } from '@momonga/testkit';
import { OWNER_FILE, ROOT_PREFIX, parseEvalOwner } from '../packages/cli/src/eval/context-host.ts';
import { SHORT_TEMP_BASE } from '../packages/cli/src/eval/context-effects.ts';
import { titleOf } from './support/cases.ts';
import { startCli, runCli } from './support/cli.ts';
import { createE2eHome } from './support/home.ts';
import { baseSettings, sandboxChoiceOf, startUpstream, writeSettingsFile } from './support/stack.ts';
import { chatCompletions, hangReply, textReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_SUPERVISOR_CLOSE_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const HANG_TASK = 'Hang forever.';
const QUICK_TASK = 'Say done.';

const userMessages = (body: unknown): string[] =>
  (((body as { messages?: { role?: unknown; content?: unknown }[] }).messages ?? []).filter((message) => message.role === 'user').map((message) => String(message.content)));

const asks = (body: unknown, needle: string): boolean => userMessages(body).some((text) => text.includes(needle));

const ROUTES: FakeRoute[] = [
  { match: (body) => asks(body, HANG_TASK), reply: hangReply('still thinking') },
  { match: (body) => asks(body, QUICK_TASK), reply: textReply('Done.') },
];

const datasetOf = (name: string, input: string) =>
  JSON.stringify({
    format: 'momonga-eval-context/1',
    name,
    cases: (['on', 'off'] as const).map((compaction) => ({
      id: `${name}-${compaction}`,
      scenario: name,
      compaction,
      input,
      permissionMode: 'acceptEdits',
      onAsk: 'allow_once',
      runs: 1,
      minPassRate: 1,
      rules: [],
      revisionDepth: 0,
      noise: { level: 0, topics: ['testing'] },
      graders: [{ kind: 'status', equals: 'COMPLETED' }],
    })),
  });

const rootOwnedBy = (pid: number): string | undefined =>
  fs
    .readdirSync(SHORT_TEMP_BASE)
    .filter((name) => name.startsWith(ROOT_PREFIX))
    .map((name) => path.join(SHORT_TEMP_BASE, name))
    .find((root) => {
      try {
        return parseEvalOwner(fs.readFileSync(path.join(root, OWNER_FILE), 'utf8'))?.pid === pid;
      } catch {
        return false;
      }
    });

describe('momonga eval context after SIGKILL', () => {
  it(titleOf('eval-context-kill'), { timeout: 4 * E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const fake = await startUpstream(home, { home, routes: ROUTES });
    writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));
    const hanging = path.join(home.root, 'hang.json');
    fs.writeFileSync(hanging, datasetOf('hang', HANG_TASK));

    const running = startCli(home, ['eval', 'context', hanging, '--alias', 'default'], { boundMs: 4 * E2E_RUN_COMPLETED_BOUND_MS });
    const root = await until(() => rootOwnedBy(running.pid), { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the case home to name its owner' });
    await until(() => chatCompletions(fake).length > 0, { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the case run to reach the upstream' });
    const lock = await inspectProcessLock(momongaLayout(root).locks.supervisor);
    if (lock.state !== 'held') throw new Error(`the case daemon holds no supervisor lock (${lock.state})`);
    const daemon = lock.pid;
    expect(isProcessAlive(daemon)).toBe(true);

    running.kill('SIGKILL');
    const killed = await running.result;
    expect(killed.signal).toBe('SIGKILL');

    await until(() => !isProcessAlive(daemon), { deadlineMs: E2E_SUPERVISOR_CLOSE_BOUND_MS, description: 'the case daemon to stop after its CLI was killed' });
    expect(fs.existsSync(root)).toBe(true);

    const quick = path.join(home.root, 'quick.json');
    fs.writeFileSync(quick, datasetOf('quick', QUICK_TASK));
    const next = await runCli(home, ['eval', 'context', quick, '--alias', 'default'], { boundMs: 4 * E2E_RUN_COMPLETED_BOUND_MS });
    expect(next.code).toBe(0);
    expect(fs.existsSync(root)).toBe(false);
  });
});
