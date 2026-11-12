import { describe, expect, it } from 'vitest';
import { MIN_ROOM_TOKENS, PinnedOverflowError, PinnedRoomError, buildContext, inputCeilingFor, renderMemories } from '@momonga/context';
import type { ContextOverflowError } from '@momonga/context';
import type { GoverningFactView, InputItem, MemoryView } from '@momonga/protocol';
import { PROJECT, ROOT_AGENTS, capabilitiesFor, developerTexts, harness, inputFor, sourcesWith, stepsOf, textOf, touchedFile, user } from './helpers.ts';

const fact = (id: string, text: string, overrides: Partial<GoverningFactView> = {}): GoverningFactView => ({
  id,
  kind: 'constraint',
  target: 'pandas',
  text,
  scope: { level: 'user' },
  validFrom: 1,
  validUntil: null,
  retiredAt: null,
  supersedes: [],
  enforcement: null,
  source: { kind: 'command', at: 1 },
  ...overrides,
});

const RULE = 'Never use pandas; use polars.';

const governing = (active: GoverningFactView[], conflicts: { target: string; ids: string[] }[] = []) => ({ active, conflicts });

const indexOfRule = (input: readonly InputItem[], text: string): number => input.findIndex((item) => item.type === 'message' && textOf(item.content).includes(text));

const rejection = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (caught: unknown) => caught);

describe('the governing block', () => {
  it('is one developer message directly after the pinned layers', async () => {
    const capabilities = capabilitiesFor(200_000);
    const { ports } = harness(capabilities, { files: { [ROOT_AGENTS]: 'Use tabs.' } });
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ governing: governing([fact('g1', RULE), fact('g2', 'Second rule.', { target: 'x' })]) }) }), ports);
    const position = indexOfRule(result.input, RULE);
    expect(position).toBe(2);
    expect(result.input[position]).toMatchObject({ type: 'message', role: 'developer' });
    expect(developerTexts(result.input).filter((text) => text.includes(RULE) && text.includes('Second rule.'))).toHaveLength(1);
  });

  it('renders the text a person confirmed exactly', async () => {
    const capabilities = capabilitiesFor(200_000);
    const { ports } = harness(capabilities);
    const text = 'Use `a<b` & keep "quotes".';
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ governing: governing([fact('g1', text)]) }) }), ports);
    expect(developerTexts(result.input).join('\n')).toContain(text);
  });

  it('adds nothing with no facts', async () => {
    const capabilities = capabilitiesFor(200_000);
    const { ports } = harness(capabilities);
    const bare = await buildContext(inputFor(capabilities), ports);
    const empty = await buildContext(inputFor(capabilities, { sources: sourcesWith({ governing: governing([]) }) }), ports);
    expect(empty.input).toEqual(bare.input);
    expect(empty.notices).toEqual([]);
  });

  it('stays out of the pinned digest, so the active set may grow during a run', async () => {
    const capabilities = capabilitiesFor(200_000);
    const { ports } = harness(capabilities);
    const before = await buildContext(inputFor(capabilities), ports);
    const after = await buildContext(inputFor(capabilities, { sources: sourcesWith({ governing: governing([fact('g1', RULE)]) }), expectedPinnedDigest: before.pinnedDigest }), ports);
    expect(after.pinnedDigest).toBe(before.pinnedDigest);
    expect(developerTexts(after.input).join('\n')).toContain(RULE);
  });

  it('enters the prefix digest', async () => {
    const capabilities = capabilitiesFor(200_000);
    const { ports } = harness(capabilities);
    const before = await buildContext(inputFor(capabilities), ports);
    const after = await buildContext(inputFor(capabilities, { sources: sourcesWith({ governing: governing([fact('g1', RULE)]) }) }), ports);
    expect(after.prefixDigest).not.toBe(before.prefixDigest);
  });

  it('never enters compaction input', async () => {
    const capabilities = capabilitiesFor(9000, { maxOutputTokens: 512 });
    const { ports } = harness(capabilities);
    const history = stepsOf([9000, 9000, 9000, 9000, 9000, 9000, 100, 100, 100, 100]);
    const overflowWith = (sources: Parameters<typeof sourcesWith>[0]) => rejection(buildContext(inputFor(capabilities, { sources: sourcesWith({ history, ...sources }) }), ports));
    const bare = (await overflowWith({})) as ContextOverflowError;
    const held = (await overflowWith({ governing: governing([fact('g1', RULE)]) })) as ContextOverflowError;
    expect(held.compaction).toBeDefined();
    expect(JSON.stringify(held.compaction?.input)).not.toContain(RULE);
    expect(held.floorTokens).toBeGreaterThan(bare.floorTokens);
  });

  it('survives when nested instructions are dropped for room', async () => {
    const capabilities = capabilitiesFor(4000, { maxOutputTokens: 256 });
    const nestedFile = `${PROJECT}/pkg/AGENTS.md`;
    const { ports } = harness(capabilities, { files: { [nestedFile]: 'n'.repeat(40_000) } });
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ governing: governing([fact('g1', RULE)]) }), touchedPaths: [touchedFile(`${PROJECT}/pkg/a.ts`)] }),
      ports,
    );
    expect(result.notices.map((notice) => notice.code)).toContain('instructions_dropped');
    expect(developerTexts(result.input).join('\n')).toContain(RULE);
  });

  it('never drops a fact: overflow fails with governing in the breakdown, kept out of instructions', async () => {
    const capabilities = capabilitiesFor(4000, { maxOutputTokens: 256 });
    const { ports } = harness(capabilities, { files: { [ROOT_AGENTS]: 'Use tabs.' } });
    const huge = 'g'.repeat(80_000);
    const error = await rejection(buildContext(inputFor(capabilities, { sources: sourcesWith({ governing: governing([fact('g1', huge)]) }) }), ports));
    expect(error).toBeInstanceOf(PinnedOverflowError);
    const { breakdown } = error as PinnedOverflowError;
    expect(breakdown.governing).toBeGreaterThanOrEqual(20_000);
    expect(breakdown.instructions).toBeLessThan(1000);
  });

  it('fails with a room error when it fits but leaves too little room', async () => {
    const capabilities = capabilitiesFor(4000, { maxOutputTokens: 256 });
    const { ports } = harness(capabilities);
    const { inputTokens: bareTokens } = await buildContext(inputFor(capabilities), ports);
    const nearTokens = inputCeilingFor(capabilities) - bareTokens - Math.floor(MIN_ROOM_TOKENS / 2);
    const near = 'g'.repeat(4 * nearTokens);
    const error = await rejection(buildContext(inputFor(capabilities, { sources: sourcesWith({ governing: governing([fact('g1', near)]) }) }), ports));
    expect(error).toBeInstanceOf(PinnedRoomError);
    expect((error as PinnedRoomError).breakdown.governing).toBeGreaterThanOrEqual(nearTokens);
  });

  it('counts in the floor: memories get the room left after it', async () => {
    const capabilities = capabilitiesFor(200_000);
    const { ports } = harness(capabilities);
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history: [user(1, 'hi')], governing: governing([fact('g1', RULE)]) }) }), ports);
    const plain = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history: [user(1, 'hi')] }) }), ports);
    expect(result.inputTokens).toBeGreaterThan(plain.inputTokens);
  });
});

describe('conflicts', () => {
  const facts = [fact('g1', 'Use tabs.', { target: 'indent' }), fact('g2', 'Use spaces.', { target: 'indent' })];
  const conflicts = [{ target: 'indent', ids: ['g1', 'g2'] }];

  it('render inside the block with both texts, target and ids', async () => {
    const capabilities = capabilitiesFor(200_000);
    const { ports } = harness(capabilities);
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ governing: governing(facts, conflicts) }) }), ports);
    const block = developerTexts(result.input).find((text) => text.includes('Use tabs.')) ?? '';
    expect(block).toContain('Use spaces.');
    expect(block).toMatch(/conflict/i);
    expect(block).toContain('indent');
    expect(block).toContain('g1');
    expect(block).toContain('g2');
  });

  it('raise a governing_conflict notice naming the target', async () => {
    const capabilities = capabilitiesFor(200_000);
    const { ports } = harness(capabilities);
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ governing: governing(facts, conflicts) }) }), ports);
    const notice = result.notices.find((entry) => entry.code === 'governing_conflict');
    expect(notice?.message).toContain('indent');
  });
});

const memory = (id: string, status: MemoryView['status']): MemoryView => ({
  id,
  scope: 'user',
  origin: 'trusted',
  project: null,
  text: `note ${id}`,
  source: { kind: 'tool', sessionId: 's', runId: 'r', step: 1, callId: id, seq: 1 },
  createdAt: 0,
  keptAt: 0,
  kind: 'fact',
  state: 'active',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [],
  contributedAt: null,
  status,
});

describe('recalled memory status', () => {
  it('shows the status of every note', () => {
    const text = renderMemories([memory('a', 'verified'), memory('b', 'stale')], 0);
    expect(text).toMatch(/<memory id="a"[^>]* status="verified"/);
    expect(text).toMatch(/<memory id="b"[^>]* status="stale"/);
  });

  it('tells the model not to rely on a stale note', () => {
    expect(renderMemories([memory('b', 'stale')], 0)).toContain('Do not rely on a note with status="stale"');
  });
});
