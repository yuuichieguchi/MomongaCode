import { describe, expect, it } from 'vitest';
import type { MemoryView } from '@momonga/protocol';
import { MEMORY_SAVE_TOOL_NAME, MEMORY_SEARCH_RESULT_LIMIT, MEMORY_SEARCH_TOOL_NAME, MEMORY_TEXT_MAX_CHARS, createMemoryTools } from '@momonga/tools';
import type { MemoryStorePort, MemorySaveRequest } from '@momonga/tools';
import { call, makeHarness, toolSetOf } from '../harness.ts';
import { keyFor } from '../helpers.ts';

const TITLE_CTX = { cwd: '/work/a', workingDirectory: '/work/a' };
const FAKE_KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';

const viewOf = (overrides: Partial<MemoryView> = {}): MemoryView => ({
  id: 'mem-1',
  scope: 'user',
  origin: 'trusted',
  project: null,
  text: 'prefers tabs',
  source: { kind: 'tool', sessionId: 's1', runId: 'run-1', step: 1, callId: 'c1', seq: 4 },
  createdAt: Date.UTC(2026, 10, 2),
  keptAt: Date.UTC(2026, 10, 3),
  kind: 'fact',
  state: 'active',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [],
  contributedAt: null,
  status: 'unbound',
  ...overrides,
});

const fakePort = (found: MemoryView[] = []) => {
  const saved: MemorySaveRequest[] = [];
  const searched: string[][] = [];
  const includes: string[] = [];
  const port: MemoryStorePort = {
    save: (request) => {
      saved.push(request);
      return { memory: viewOf({ scope: request.scope, text: request.text }), created: true };
    },
    search: (terms, options) => {
      searched.push([...terms]);
      includes.push(options.include);
      return found;
    },
  };
  return { port, saved, searched, includes };
};

const toolSet = async (port: MemoryStorePort, trusted = true) => toolSetOf(...createMemoryTools({ port, trusted }));

describe('memory tools', () => {
  it('asks for approval before saving in the default mode, naming no path', async () => {
    const { port, saved } = fakePort();
    const harness = makeHarness();
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSet(port), [call('c1', MEMORY_SAVE_TOOL_NAME, { text: 'prefers tabs', scope: 'user' })]),
    );
    expect(outcome?.kind).toBe('needs_approval');
    expect(saved).toEqual([]);
  });

  it('saves with the run, step and call as the source once approved', async () => {
    const { port, saved } = fakePort();
    const harness = makeHarness();
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSet(port), [call('c1', MEMORY_SAVE_TOOL_NAME, { text: 'prefers tabs', scope: 'project' }, 'allow_once')]),
    );
    expect(saved).toEqual([{ scope: 'project', text: 'prefers tabs', runId: 'run-1', step: 1, callId: 'c1', signal: expect.any(AbortSignal) }]);
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'Saved project memory mem-1.' } });
  });

  it('is refused in plan mode, which only runs read-only tools', async () => {
    const { port, saved } = fakePort();
    const harness = makeHarness();
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSet(port), [call('c1', MEMORY_SAVE_TOOL_NAME, { text: 'prefers tabs', scope: 'user' })], { mode: 'plan' }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect(saved).toEqual([]);
  });

  it('refuses text that looks like a credential before any approval is asked', async () => {
    const { port, saved } = fakePort();
    const harness = makeHarness();
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSet(port), [call('c1', MEMORY_SAVE_TOOL_NAME, { text: `my key is ${FAKE_KEY}`, scope: 'user' })]),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect(JSON.stringify(outcome)).toContain('credential or secret');
    expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY);
    expect(saved).toEqual([]);
  });

  it('refuses a project memory in an untrusted folder instead of saving it as a user memory', async () => {
    const { port, saved } = fakePort();
    const harness = makeHarness();
    const set = await toolSet(port, false);
    const [refused] = await harness.executor.runBatch(
      harness.input(set, [call('c1', MEMORY_SAVE_TOOL_NAME, { text: 'tests live in test/', scope: 'project' }, 'allow_once')]),
    );
    expect(refused).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect(JSON.stringify(refused)).toContain('trusted folders');
    const [accepted] = await harness.executor.runBatch(
      harness.input(set, [call('c2', MEMORY_SAVE_TOOL_NAME, { text: 'prefers tabs', scope: 'user' }, 'allow_once')]),
    );
    expect(accepted?.kind).toBe('result');
    expect(saved).toEqual([{ scope: 'user', text: 'prefers tabs', runId: 'run-1', step: 1, callId: 'c2', signal: expect.any(AbortSignal) }]);
  });

  it('rejects whitespace-only text, unknown scopes and text beyond the cap', async () => {
    const { port, saved } = fakePort();
    const harness = makeHarness();
    const set = await toolSet(port);
    const outcomes = await harness.executor.runBatch(
      harness.input(set, [
        call('c1', MEMORY_SAVE_TOOL_NAME, { text: '   ', scope: 'user' }, 'allow_once'),
        call('c2', MEMORY_SAVE_TOOL_NAME, { text: 'x', scope: 'team' }, 'allow_once'),
        call('c3', MEMORY_SAVE_TOOL_NAME, { text: 'x'.repeat(MEMORY_TEXT_MAX_CHARS + 1), scope: 'user' }, 'allow_once'),
      ]),
    );
    expect(outcomes.map((outcome) => outcome.kind === 'result' && outcome.result.status)).toEqual(['failed', 'failed', 'failed']);
    expect(saved).toEqual([]);
  });

  it('runs an interrupted save again, which is safe because the store keeps one memory per call', async () => {
    const { port, saved } = fakePort();
    const harness = makeHarness();
    harness.idempotency.port.begin(keyFor('run-1', 1, 'c1'), { expiresAt: harness.clock.now() + 60_000, meta: { tool: MEMORY_SAVE_TOOL_NAME, runId: 'run-1' } });
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSet(port), [call('c1', MEMORY_SAVE_TOOL_NAME, { text: 'prefers tabs', scope: 'user' }, 'allow_once')]),
    );
    expect(saved).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: 'result', reconciled: 'not_applied', result: { status: 'completed' } });
  });

  it('searches by words and shows the provenance of each match without asking', async () => {
    const { port, searched } = fakePort([viewOf(), viewOf({ id: 'mem-2', scope: 'project', project: '/p', text: 'run make', source: { kind: 'tool', sessionId: 's2', runId: 'run-9', step: 3, callId: 'c7', seq: 12 } })]);
    const harness = makeHarness();
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSet(port), [call('c1', MEMORY_SEARCH_TOOL_NAME, { query: ' tabs   make ' })]));
    expect(searched).toEqual([['tabs', 'make']]);
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    const output = outcome?.kind === 'result' ? outcome.result.output : '';
    expect(output.split('\n')).toEqual([
      '[mem-1] (user memory, trusted origin, status unbound, saved 2026-11-02T00:00:00.000Z in run run-1 step 1) prefers tabs',
      '[mem-2] (project memory, trusted origin, status unbound, saved 2026-11-02T00:00:00.000Z in run run-9 step 3) run make',
    ]);
  });

  it('asks the port for live memories by default and for all of them on request', async () => {
    const { port, includes } = fakePort();
    const harness = makeHarness();
    const set = await toolSet(port);
    await harness.executor.runBatch(
      harness.input(set, [call('c1', MEMORY_SEARCH_TOOL_NAME, { query: 'tabs' }), call('c2', MEMORY_SEARCH_TOOL_NAME, { query: 'tabs', include: 'all' })]),
    );
    expect(includes).toEqual(['live', 'all']);
  });

  it('shows status and, for memories that are no longer live, their validity', async () => {
    const retired = viewOf({ id: 'mem-old', status: 'stale', state: 'archived', retiredAt: Date.UTC(2026, 10, 4), supersedes: ['mem-older'] });
    const harness = makeHarness();
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSet(fakePort([retired]).port), [call('c1', MEMORY_SEARCH_TOOL_NAME, { query: 'tabs', include: 'all' })]),
    );
    const output = outcome?.kind === 'result' ? outcome.result.output : '';
    expect(output).toBe(
      '[mem-old] (user memory, trusted origin, status stale, state archived, retired 2026-11-04T00:00:00.000Z, supersedes mem-older, saved 2026-11-02T00:00:00.000Z in run run-1 step 1) prefers tabs',
    );
  });

  it('marks a note that was replaced, so a model that asks for all notes does not rely on it', async () => {
    const harness = makeHarness();
    const replaced = viewOf({ id: 'mem-old', supersededBy: ['mem-new'] });
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSet(fakePort([replaced]).port), [call('c1', MEMORY_SEARCH_TOOL_NAME, { query: 'tabs', include: 'all' })]),
    );
    const output = outcome?.kind === 'result' ? outcome.result.output : '';
    expect(output).toContain('status unbound, superseded by mem-new, saved');
  });

  it('passes kind, paths and supersedes to the port only when the model gave them', async () => {
    const { port, saved } = fakePort();
    const harness = makeHarness();
    await harness.executor.runBatch(
      harness.input(await toolSet(port), [
        call('c1', MEMORY_SAVE_TOOL_NAME, { text: 'parser lives in src/parser.ts', scope: 'project', kind: 'fact', paths: ['src/parser.ts'], supersedes: ['mem-9'] }, 'allow_once'),
      ]),
    );
    expect(saved).toEqual([{ scope: 'project', text: 'parser lives in src/parser.ts', runId: 'run-1', step: 1, callId: 'c1', signal: expect.any(AbortSignal), kind: 'fact', paths: ['src/parser.ts'], supersedes: ['mem-9'] }]);
  });

  describe('what the approver sees of a MemorySave', () => {
    const saveTool = () => {
      const tool = createMemoryTools({ port: fakePort().port, trusted: true }).find((candidate) => candidate.name === MEMORY_SAVE_TOOL_NAME);
      if (tool === undefined) throw new Error('MemorySave is missing');
      return tool;
    };
    const subjectCtx = { cwd: '/work', roots: ['/work'] } as never;

    it('names the notes it replaces and the paths it binds in the title', () => {
      const title = saveTool().title({ text: 'x', scope: 'user', supersedes: ['mem-1', 'mem-2'], paths: ['src/a.ts'] }, TITLE_CTX);
      expect(title).toBe('Save a user memory replacing mem-1, mem-2 bound to src/a.ts');
      expect(saveTool().title({ text: 'x', scope: 'project' }, TITLE_CTX)).toBe('Save a project memory');
    });

    it('puts text, kind, paths and supersedes in the subject, so the digest covers everything later sessions see', () => {
      const input = { text: 'prefers tabs', scope: 'user', kind: 'procedure', supersedes: ['mem-1'], paths: ['src/a.ts'] };
      expect(saveTool().subject(input, subjectCtx)).toEqual({
        kind: 'memory',
        tool: MEMORY_SAVE_TOOL_NAME,
        scope: 'user',
        text: 'prefers tabs',
        memoryKind: 'procedure',
        paths: ['src/a.ts'],
        supersedes: ['mem-1'],
      });
      expect(saveTool().subject({ text: 'a', scope: 'user' }, subjectCtx)).toEqual({
        kind: 'memory',
        tool: MEMORY_SAVE_TOOL_NAME,
        scope: 'user',
        text: 'a',
        memoryKind: 'fact',
        paths: [],
        supersedes: [],
      });
    });
  });

  it('caps the matches it shows and says that more exist', async () => {
    const many = Array.from({ length: MEMORY_SEARCH_RESULT_LIMIT + 3 }, (_, index) => viewOf({ id: `mem-${index}` }));
    const harness = makeHarness();
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSet(fakePort(many).port), [call('c1', MEMORY_SEARCH_TOOL_NAME, { query: 'tabs' })]));
    const lines = (outcome?.kind === 'result' ? outcome.result.output : '').split('\n');
    expect(lines).toHaveLength(MEMORY_SEARCH_RESULT_LIMIT + 1);
    expect(lines.at(-1)).toBe('More matches were not shown; narrow the query.');
  });

  it('reports an empty search plainly and rejects a blank query', async () => {
    const harness = makeHarness();
    const set = await toolSet(fakePort().port);
    const [none, blank] = await harness.executor.runBatch(
      harness.input(set, [call('c1', MEMORY_SEARCH_TOOL_NAME, { query: 'nothing' }), call('c2', MEMORY_SEARCH_TOOL_NAME, { query: '   ' })]),
    );
    expect(none).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'No saved memory matches.' } });
    expect(blank).toMatchObject({ kind: 'result', result: { status: 'failed' } });
  });
});

describe('MemorySearch with include all', () => {
  it('prints the intervals of validity of each note and names the notes it returned in a structured field', async () => {
    const note = viewOf({
      id: 'mem-old',
      status: 'stale',
      validity: {
        intervals: [
          { status: 'verified', from: Date.UTC(2026, 10, 2), to: Date.UTC(2026, 10, 4), closedBy: 'observation' },
          { status: 'stale', from: Date.UTC(2026, 10, 4), to: Date.UTC(2026, 10, 6), closedBy: 'successor' },
        ],
        changes: [{ from: 'verified', to: 'stale', changedBetween: [Date.UTC(2026, 10, 2), Date.UTC(2026, 10, 4)] }],
      },
    });
    const harness = makeHarness();
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSet(fakePort([note]).port), [call('c1', MEMORY_SEARCH_TOOL_NAME, { query: 'tabs', include: 'all' })]),
    );
    const output = outcome?.kind === 'result' ? outcome.result.output : '';
    expect(output).toContain('validity verified observed 2026-11-02T00:00:00.000Z to 2026-11-04T00:00:00.000Z; stale observed 2026-11-04T00:00:00.000Z to 2026-11-06T00:00:00.000Z (successor)');
    expect(outcome?.kind === 'result' ? outcome.result.memories : undefined).toEqual(['mem-old']);
  });
});
