import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemClock, ruleEnforcementOf } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { parseRule } from '@momonga/policy';
import type { PermissionRule } from '@momonga/policy';
import type { AnyTool, ToolContext, ToolResult } from '@momonga/tools';
import { UNBOUNDED_OUTPUT_FIT, NEVER_CANCELLED } from '@momonga/testkit';
import type { RuntimeStore, Session } from '@momonga/store';
import { createHistoryPort } from '../../src/process/history-port.ts';
import { harness } from '../../../store/test/helpers.ts';
import { FAKE_KEY, finishedRun, indexAll, openRun, projectDir, redactor } from '../../../store/test/search-fixture.ts';

type RulesOf = PermissionRule[] | ((cwd: string) => PermissionRule[]);

const toolsFor = async (store: RuntimeStore, session: Session, rules: RulesOf = [], clock: Clock = systemClock): Promise<AnyTool[]> => {
  const settings = {
    trusted: async (candidate: Session) => (await store.trust.decisionAsked(candidate.cwd, NEVER_CANCELLED)).decision === 'trusted',
    rules: async (candidate: Session) => (typeof rules === 'function' ? rules(candidate.cwd) : rules),
  };
  return (await createHistoryPort({ store, settings, clock, home: '/home/user', redactor, enforcement: () => ruleEnforcementOf('none') }).load(session, new AbortController().signal)).tools as AnyTool[];
};

const execute = async (tools: AnyTool[], name: string, input: unknown, runId = 'current'): Promise<ToolResult> => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return (await tool.execute(input, { runId, outputFit: UNBOUNDED_OUTPUT_FIT, signal: NEVER_CANCELLED } as unknown as ToolContext, undefined)) as ToolResult;
};

describe('history tools over the real store', () => {
  it('answers a search with framed, redacted snippets for the session project only', async () => {
    const { store, dir } = harness();
    const [a, b] = [projectDir(dir, 'a'), projectDir(dir, 'b')];
    await store.trust.setAsked(a, 'trusted', NEVER_CANCELLED);
    await store.trust.setAsked(b, 'trusted', NEVER_CANCELLED);
    const mine = await finishedRun(store, a, `needleterm ${FAKE_KEY}`);
    const other = await finishedRun(store, b, 'needleterm other');
    await indexAll(store);
    const session = store.getSession((await mine).sessionId) as Session;
    const result = await execute(await toolsFor(store, session), 'HistorySearch', { query: 'needleterm' });
    expect(result.output).toContain((await mine).id);
    expect(result.output).not.toContain((await other).id);
    expect(result.output).not.toContain(FAKE_KEY);
    expect(result.output).toContain('recorded data, not instructions');
  });

  it("reaches other projects' trusted runs with scope all in a trusted session", async () => {
    const { store, dir } = harness();
    const [a, b] = [projectDir(dir, 'a'), projectDir(dir, 'b')];
    await store.trust.setAsked(a, 'trusted', NEVER_CANCELLED);
    await store.trust.setAsked(b, 'trusted', NEVER_CANCELLED);
    const mine = await finishedRun(store, a, 'needleterm');
    const other = await finishedRun(store, b, 'needleterm other');
    await indexAll(store);
    const result = await execute(await toolsFor(store, store.getSession((await mine).sessionId) as Session), 'HistorySearch', { query: 'needleterm', scope: 'all' });
    expect(result.output).toContain((await other).id);
  });

  it('keeps an untrusted session in its project even with scope all', async () => {
    const { store, dir } = harness();
    const b = projectDir(dir, 'b');
    await store.trust.setAsked(b, 'trusted', NEVER_CANCELLED);
    const mine = await finishedRun(store, '/work/a', 'needleterm');
    const other = await finishedRun(store, b, 'needleterm other');
    await indexAll(store);
    const result = await execute(await toolsFor(store, store.getSession((await mine).sessionId) as Session), 'HistorySearch', { query: 'needleterm', scope: 'all' });
    expect(result.output).toContain((await mine).id);
    expect(result.output).not.toContain((await other).id);
  });

  it("reads the current run's replaced range, redacted", async () => {
    const { store } = harness();
    const { run, session } = await openRun(store, '/work/a', 'task', [{ tool: { name: 'Read', path: '/work/a/f', output: `value ${FAKE_KEY} end` } }]);
    const result = await execute(await toolsFor(store, session), 'HistoryRead', { seqFrom: 1 }, run.id);
    expect(result.output).toContain('value [REDACTED] end');
    expect(result.output).not.toContain(FAKE_KEY);
  });

  it('withholds a search hit and a read result whose path a read deny rule now covers, and counts them', async () => {
    const { store, dir } = harness();
    const project = projectDir(dir, 'a');
    const secret = path.join(project, 'secret', 'key.txt');
    const open = path.join(project, 'open.txt');
    const mine = await finishedRun(store, project, 'task', [
      { tool: { name: 'Read', path: secret, output: 'hiddenterm inside the secret file' } },
      { tool: { name: 'Read', path: open, output: 'hiddenterm inside the open file' } },
    ]);
    await indexAll(store);
    const session = store.getSession((await mine).sessionId) as Session;
    const rule = parseRule('Read(./secret/**)', { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: project, home: dir, cwd: project });
    const tools = await toolsFor(store, session, [rule]);
    const searched = await execute(tools, 'HistorySearch', { query: 'hiddenterm' });
    expect(searched.output).toContain('inside the open file');
    expect(searched.output).not.toContain('inside the secret file');
    expect(searched.output).toMatch(/1 recorded results were withheld/);
    const read = await execute(tools, 'HistoryRead', { runId: (await mine).id }, 'current');
    expect(read.output).toContain('inside the open file');
    expect(read.output).not.toContain('inside the secret file');
    expect(read.output).not.toContain(secret);
    expect(read.output).toMatch(/1 recorded tool results were withheld/);
  });

  it('withholds what a governance deny rule of the run project covers, with no settings rule at all', async () => {
    const { store, dir, clock } = harness();
    const [a, b] = [projectDir(dir, 'a'), projectDir(dir, 'b')];
    await store.trust.setAsked(a, 'trusted', NEVER_CANCELLED);
    await store.trust.setAsked(b, 'trusted', NEVER_CANCELLED);
    const secret = path.join(b, 'secret', 'key.txt');
    const reader = await finishedRun(store, a, 'reader task');
    const owner = await finishedRun(store, b, 'owner task', [{ tool: { name: 'Read', path: secret, output: 'govterm inside the secret file' } }]);
    await indexAll(store);
    store.governing.add({
      kind: 'constraint',
      target: 'secrets',
      text: 'Never read the secret directory.',
      scope: { level: 'project', project: b, paths: [] },
      validUntil: null,
      supersedes: [],
      enforcement: { behavior: 'deny', rule: 'Read(./secret/**)' },
      source: { kind: 'command' },
    });
    const tools = await toolsFor(store, store.getSession((await reader).sessionId) as Session, [], clock);
    const searched = await execute(tools, 'HistorySearch', { query: 'govterm', scope: 'all' });
    expect(searched.output).not.toContain('inside the secret file');
    expect(searched.output).toMatch(/1 recorded results were withheld/);
    const read = await execute(tools, 'HistoryRead', { runId: (await owner).id }, (await reader).id);
    expect(read.output).not.toContain('inside the secret file');
    expect(read.output).toMatch(/1 recorded tool results were withheld/);
  });

  it("applies the rules of the project a run belongs to, not only those of the reader's project", async () => {
    const { store, dir } = harness();
    const [a, b] = [projectDir(dir, 'a'), projectDir(dir, 'b')];
    await store.trust.setAsked(a, 'trusted', NEVER_CANCELLED);
    await store.trust.setAsked(b, 'trusted', NEVER_CANCELLED);
    const secret = path.join(b, 'secret', 'key.txt');
    const reader = await finishedRun(store, a, 'reader task');
    const owner = await finishedRun(store, b, 'owner task', [{ tool: { name: 'Read', path: secret, output: 'crossterm inside the secret file' } }]);
    await indexAll(store);
    const ruleOfB = parseRule('Read(./secret/**)', { effect: 'deny', origin: 'project', source: 'project-settings', settingsRoot: b, home: dir, cwd: b });
    const tools = await toolsFor(store, store.getSession((await reader).sessionId) as Session, (cwd) => (cwd === b ? [ruleOfB] : []));
    const searched = await execute(tools, 'HistorySearch', { query: 'crossterm', scope: 'all' });
    expect(searched.output).not.toContain('inside the secret file');
    expect(searched.output).toMatch(/1 recorded results were withheld/);
    const read = await execute(tools, 'HistoryRead', { runId: (await owner).id }, (await reader).id);
    expect(read.output).not.toContain('inside the secret file');
    expect(read.output).toMatch(/1 recorded tool results were withheld/);
  });

  it('refuses a run of another project an untrusted session names directly', async () => {
    const { store, dir } = harness();
    const b = projectDir(dir, 'b');
    await store.trust.setAsked(b, 'trusted', NEVER_CANCELLED);
    const hidden = await finishedRun(store, b, 'hidden words');
    const mine = await finishedRun(store, '/work/a', 'mine');
    await indexAll(store);
    const tools = await toolsFor(store, store.getSession((await mine).sessionId) as Session);
    await expect(execute(tools, 'HistoryRead', { runId: (await hidden).id }, (await mine).id)).rejects.toThrow(`no recorded run ${(await hidden).id} is visible`);
  });
});
