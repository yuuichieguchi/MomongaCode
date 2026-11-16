import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_INTERRUPTED } from '@momonga/foundation';
import type { FakeRoute } from '@momonga/testkit';
import { titleOf } from './support/cases.ts';
import { startCli } from './support/cli.ts';
import { readDb } from './support/db.ts';
import { createE2eHome } from './support/home.ts';
import { sharedTempBase } from './support/run-env.ts';
import { baseSettings, sandboxChoiceOf, startUpstream, writeSettingsFile } from './support/stack.ts';
import { evalRootsOwnedBy } from './support/teardown.ts';
import { chatCompletions, hangReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const HANG_TASK = 'Hang forever.';

const ROUTES: FakeRoute[] = [{ match: () => true, reply: hangReply('still thinking') }];

const DATASET = JSON.stringify({
  format: 'momonga-eval/1',
  name: 'hang',
  cases: [{ id: 'hang', input: HANG_TASK, permissionMode: 'acceptEdits', onAsk: 'allow_once', runs: 2, minPassRate: 1, files: { 'notes.txt': 'a note\n' }, graders: [{ kind: 'status', equals: 'COMPLETED' }] }],
});

describe('momonga eval after two interrupts in a row', () => {
  it(titleOf('eval-interrupt-cleanup'), { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const fake = await startUpstream(home, { home, routes: ROUTES });
    writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));
    const dataset = path.join(home.root, 'hang.json');
    fs.writeFileSync(dataset, DATASET);
    const workspaces = (): string[] => evalRootsOwnedBy(sharedTempBase(), (owner) => owner === home.home);

    expect(workspaces()).toEqual([]);

    const running = startCli(home, ['eval', dataset]);
    await until(() => chatCompletions(fake).length > 0, { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the first run of the case to reach the upstream' });
    const [root, ...otherRoots] = workspaces();
    expect(root).toBeDefined();
    expect(otherRoots).toEqual([]);
    const caseRuns = readDb<{ status: string }>(path.join(root as string, path.relative(home.home, home.paths.databases.runtime)), 'SELECT status FROM runs');
    expect(caseRuns).toHaveLength(1);
    const requestsBeforeInterrupt = chatCompletions(fake).length;

    running.interrupt();
    running.interrupt();
    const ended = await running.result;

    expect(ended.signal).toBeNull();
    expect(ended.code).toBe(EXIT_INTERRUPTED);
    expect(ended.stderr).not.toContain('Error');
    expect(workspaces()).toEqual([]);
    expect(chatCompletions(fake)).toHaveLength(requestsBeforeInterrupt);
  });
});
