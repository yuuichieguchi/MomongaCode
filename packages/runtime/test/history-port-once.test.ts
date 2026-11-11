import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ruleEnforcementOf, systemClock } from '@momonga/foundation';
import { parseRule } from '@momonga/policy';
import type { AnyTool, ToolContext, ToolResult } from '@momonga/tools';
import { NEVER_CANCELLED, UNBOUNDED_OUTPUT_FIT } from '@momonga/testkit';
import type { RuntimeStore, Session } from '@momonga/store';
import { createHistoryPort } from '../src/process/history-port.ts';
import { harness } from '../../store/test/helpers.ts';
import { finishedRun, indexAll, projectDir, redactor } from '../../store/test/search-fixture.ts';

const RUNS = 3;

const searchOver = async () => {
  const { store, dir } = harness();
  const project = projectDir(dir, 'a');
  const stepsOf = (run: number) => [
    { tool: { name: 'Read', path: path.join(project, 'secret', `file-${run}.txt`), output: `needleterm in the secret file ${run}` } },
    { tool: { name: 'Read', path: path.join(project, 'open', `file-${run}.txt`), output: `needleterm in the open file ${run}` } },
  ];
  const first = await finishedRun(store, project, 'first task', stepsOf(0));
  for (let run = 1; run < RUNS; run += 1) await finishedRun(store, project, `task ${run}`, stepsOf(run));
  await indexAll(store);
  const session = store.getSession(first.sessionId) as Session;
  const rule = parseRule('Read(./secret/**)', { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: project, home: dir, cwd: project });
  const query = vi.spyOn(store.search, 'query');
  const port = createHistoryPort({
    store: store as Pick<RuntimeStore, 'search' | 'governing'>,
    settings: { trusted: async () => false, rules: async () => [rule] },
    clock: systemClock,
    home: dir,
    redactor,
    enforcement: () => ruleEnforcementOf('none'),
  });
  const tools = (await port.load(session)).tools as AnyTool[];
  const tool = tools.find((candidate) => candidate.name === 'HistorySearch');
  if (tool === undefined) throw new Error('no HistorySearch tool');
  const result = (await tool.execute({ query: 'needleterm' }, { runId: 'current', outputFit: UNBOUNDED_OUTPUT_FIT, signal: NEVER_CANCELLED } as unknown as ToolContext, undefined)) as ToolResult;
  return { result, query };
};

describe('a history search asks the store once', () => {
  it('runs the store query once however many path verdicts it has to ask for, and still withholds what a deny rule covers', async () => {
    const { result, query } = await searchOver();

    expect(query).toHaveBeenCalledTimes(1);
    for (let run = 0; run < RUNS; run += 1) expect(result.output).toContain(`needleterm in the open file ${run}`);
    expect(result.output).not.toContain('in the secret file');
    expect(result.output).toMatch(new RegExp(`${RUNS} recorded results were withheld`));
  });
});
