import { describe, expect, it } from 'vitest';
import type { MemoryView } from '@momonga/protocol';
import { MEMORY_SAVE_TOOL_NAME, MEMORY_SEARCH_RESULT_LIMIT, MEMORY_SEARCH_TOOL_NAME, MEMORY_TEXT_MAX_CHARS, createMemoryTools } from '@momonga/tools';
import type { MemoryStorePort, MemorySaveRequest } from '@momonga/tools';
import { call, makeHarness, toolSetOf } from '../harness.ts';
import { keyFor } from '../helpers.ts';

const FAKE_KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';

const viewOf = (overrides: Partial<MemoryView> = {}): MemoryView => ({
  id: 'mem-1',
  scope: 'user',
  project: null,
  text: 'prefers tabs',
  source: { sessionId: 's1', runId: 'run-1', step: 1, callId: 'c1', seq: 4 },
  createdAt: Date.UTC(2026, 10, 2),
  lastUsedAt: Date.UTC(2026, 10, 3),
  ...overrides,
});

const fakePort = (found: MemoryView[] = []) => {
  const saved: MemorySaveRequest[] = [];
  const searched: string[][] = [];
  const port: MemoryStorePort = {
    save: (request) => {
      saved.push(request);
      return { memory: viewOf({ scope: request.scope, text: request.text }), created: true };
    },
    search: (terms) => {
      searched.push([...terms]);
      return found;
    },
  };
  return { port, saved, searched };
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
    expect(saved).toEqual([{ scope: 'project', text: 'prefers tabs', runId: 'run-1', step: 1, callId: 'c1' }]);
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
    expect(saved).toEqual([{ scope: 'user', text: 'prefers tabs', runId: 'run-1', step: 1, callId: 'c2' }]);
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
    const { port, searched } = fakePort([viewOf(), viewOf({ id: 'mem-2', scope: 'project', project: '/p', text: 'run make', source: { sessionId: 's2', runId: 'run-9', step: 3, callId: 'c7', seq: 12 } })]);
    const harness = makeHarness();
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSet(port), [call('c1', MEMORY_SEARCH_TOOL_NAME, { query: ' tabs   make ' })]));
    expect(searched).toEqual([['tabs', 'make']]);
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    const output = outcome?.kind === 'result' ? outcome.result.output : '';
    expect(output.split('\n')).toEqual([
      '[mem-1] (user memory, saved 2026-11-02T00:00:00.000Z in run run-1 step 1, last used 2026-11-03T00:00:00.000Z) prefers tabs',
      '[mem-2] (project memory, saved 2026-11-02T00:00:00.000Z in run run-9 step 3, last used 2026-11-03T00:00:00.000Z) run make',
    ]);
  });

  it('caps the matches it shows and says how many were left out', async () => {
    const many = Array.from({ length: MEMORY_SEARCH_RESULT_LIMIT + 3 }, (_, index) => viewOf({ id: `mem-${index}` }));
    const harness = makeHarness();
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSet(fakePort(many).port), [call('c1', MEMORY_SEARCH_TOOL_NAME, { query: 'tabs' })]));
    const lines = (outcome?.kind === 'result' ? outcome.result.output : '').split('\n');
    expect(lines).toHaveLength(MEMORY_SEARCH_RESULT_LIMIT + 1);
    expect(lines.at(-1)).toBe('3 more matches were not shown; narrow the query.');
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
