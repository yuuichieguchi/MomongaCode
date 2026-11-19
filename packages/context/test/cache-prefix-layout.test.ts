import { describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import type { BuildContextInput, HistoryItem } from '@momonga/context';
import type { GoverningFactView, InputItem, MemoryView } from '@momonga/protocol';
import { COMPACT_AT, floorRatio } from '@momonga/protocol';
import { inputCeilingFor } from '@momonga/context';
import {
  HOME,
  MODEL,
  PROJECT,
  ROOT_AGENTS,
  SYSTEM_PROMPT,
  TASK,
  assistant,
  call,
  capabilitiesFor,
  fakeBlobs,
  fakeReader,
  harness,
  inputFor,
  output,
  sourcesWith,
  textOf,
  touchedFile,
  user,
  withTurnsBeforeCurrent,
} from './helpers.ts';
import { weightMeter, weightOf, weightOfAll } from './weight-meter.ts';
import { TEST_FENCE } from '@momonga/testkit';

type Arrival = { kind: 'instructions'; path: string; content: string } | { kind: 'skill'; name: string; content: string };

type CachePrefixInput = BuildContextInput & { layout: 'cachePrefix'; pinnedMemoryIds?: readonly string[]; arrivals?: readonly Arrival[] };

const cachePrefix = (input: BuildContextInput, extra: { pinnedMemoryIds?: readonly string[]; arrivals?: readonly Arrival[] } = {}): BuildContextInput => {
  const withLayout: CachePrefixInput = { ...input, layout: 'cachePrefix', ...extra };
  return withLayout;
};

const RULE = 'Never use pandas; use polars.';

const fact = (id: string, text: string): GoverningFactView => ({
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
});

const memoryOf = (index: number): MemoryView => ({
  id: `mem-${index}`,
  scope: 'user',
  origin: 'trusted',
  project: null,
  text: `Note number ${index}: prefer small commits.`,
  source: { kind: 'tool', sessionId: 's1', runId: `run-${index}`, step: index, callId: `c${index}`, seq: index + 3 },
  createdAt: Date.UTC(2026, 10, 1, 0, 0, index),
  keptAt: Date.UTC(2026, 10, 2, 0, 0, index),
  kind: 'fact',
  state: 'active',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [],
  contributedAt: null,
  status: 'unbound',
});

const indexOfText = (input: readonly InputItem[], text: string): number =>
  input.findIndex((item) => item.type === 'message' && textOf(item.content).includes(text));

const SKILL = { name: 'deploy', content: 'Deploy carefully.' };
const SKILL_TEXT = 'Activated skill deploy:';
const MEMORY_TAG = '<recalled_memories>';

const zonedSources = () =>
  sourcesWith({
    governing: { active: [fact('g1', RULE)], conflicts: [] },
    memories: [memoryOf(1)],
    activatedSkills: [SKILL],
    history: [user(1, 'first question')],
    taskSeq: 0,
  });

describe('zone layout of F with context.cachePrefix (4.1)', () => {
  it('orders F as memory block, arrivals, then the governing block last, directly before H', async () => {
    const capabilities = capabilitiesFor(200_000);
    const { ports } = harness(capabilities, { files: { [ROOT_AGENTS]: 'Use tabs.' } });

    const built = await buildContext(cachePrefix(inputFor(capabilities, { sources: zonedSources() }), { arrivals: [{ kind: 'skill', ...SKILL }] }), ports);

    const memory = indexOfText(built.input, MEMORY_TAG);
    const skill = indexOfText(built.input, SKILL_TEXT);
    const governing = indexOfText(built.input, RULE);
    const task = indexOfText(built.input, textOf(TASK.content));
    expect([memory, skill, governing].every((index) => index > 0)).toBe(true);
    expect(memory).toBeLessThan(skill);
    expect(skill).toBeLessThan(governing);
    expect(governing).toBe(task - 1);
  });

  it('keeps today\'s order, governing directly after the pinned layers, without the setting', async () => {
    const capabilities = capabilitiesFor(200_000);
    const { ports } = harness(capabilities, { files: { [ROOT_AGENTS]: 'Use tabs.' } });

    const built = await buildContext(inputFor(capabilities, { sources: zonedSources() }), ports);

    expect(indexOfText(built.input, RULE)).toBeLessThan(indexOfText(built.input, MEMORY_TAG));
  });
});

describe('memories ranked once per run (4.1)', () => {
  it('renders exactly the pinned memory ids, in the pinned order, whatever the current ranking', async () => {
    const capabilities = capabilitiesFor(200_000);
    const { ports } = harness(capabilities);
    const sources = sourcesWith({ memories: [memoryOf(1), memoryOf(2), memoryOf(3)] });

    const built = await buildContext(cachePrefix(inputFor(capabilities, { sources }), { pinnedMemoryIds: ['mem-3', 'mem-1'] }), ports);

    expect(built.loadedMemoryIds).toEqual(['mem-3', 'mem-1']);
    const block = built.input[indexOfText(built.input, MEMORY_TAG)];
    const text = block?.type === 'message' ? textOf(block.content) : '';
    expect(text).toContain('Note number 3');
    expect(text).toContain('Note number 1');
    expect(text).not.toContain('Note number 2');
    expect(text.indexOf('Note number 3')).toBeLessThan(text.indexOf('Note number 1'));
  });
});

describe('arrivals of F are append-only (4.1, 0.2 #4)', () => {
  it('keeps an admitted nested file and refuses a newly discovered one that does not fit, with instructions_dropped', async () => {
    const capabilities = capabilitiesFor(4000);
    const { ports } = harness(capabilities, { files: { '/proj/a/AGENTS.md': 'a rules', '/proj/b/AGENTS.md': 'B'.repeat(12_000) } });
    const input = inputFor(capabilities, { touchedPaths: [touchedFile('/proj/a/x.ts'), touchedFile('/proj/b/y.ts')] });

    const built = await buildContext(cachePrefix(input, { arrivals: [{ kind: 'instructions', path: '/proj/a/AGENTS.md', content: 'a rules' }] }), ports);

    expect(indexOfText(built.input, 'a rules')).toBeGreaterThan(0);
    expect(indexOfText(built.input, 'BBBB')).toBe(-1);
    expect(built.notices.filter((notice) => notice.code === 'instructions_dropped').map((notice) => notice.message)).toEqual([
      expect.stringContaining('/proj/b/AGENTS.md'),
    ]);
  });

  it('places a skill by its arrival in journal order, before a nested file that arrived after it', async () => {
    const capabilities = capabilitiesFor(200_000);
    const { ports } = harness(capabilities, { files: { '/proj/a/AGENTS.md': 'a rules' } });
    const input = inputFor(capabilities, { sources: sourcesWith({ activatedSkills: [SKILL] }), touchedPaths: [touchedFile('/proj/a/x.ts')] });
    const arrivals: Arrival[] = [
      { kind: 'skill', ...SKILL },
      { kind: 'instructions', path: '/proj/a/AGENTS.md', content: 'a rules' },
    ];

    const built = await buildContext(cachePrefix(input, { arrivals }), ports);

    const skill = indexOfText(built.input, SKILL_TEXT);
    expect(skill).toBeGreaterThan(0);
    expect(indexOfText(built.input, 'a rules')).toBe(skill + 1);
  });

  it('replaces an edited nested file in place among the arrivals, keeping journal order', async () => {
    const capabilities = capabilitiesFor(200_000);
    const { ports } = harness(capabilities, { files: { '/proj/a/AGENTS.md': 'a rules v2', '/proj/b/AGENTS.md': 'b rules' } });
    const input = inputFor(capabilities, {
      sources: sourcesWith({ activatedSkills: [SKILL] }),
      touchedPaths: [touchedFile('/proj/a/x.ts'), touchedFile('/proj/b/y.ts')],
    });
    const arrivals: Arrival[] = [
      { kind: 'instructions', path: '/proj/a/AGENTS.md', content: 'a rules v1' },
      { kind: 'skill', ...SKILL },
      { kind: 'instructions', path: '/proj/b/AGENTS.md', content: 'b rules' },
    ];

    const built = await buildContext(cachePrefix(input, { arrivals }), ports);

    const edited = indexOfText(built.input, 'a rules v2');
    const skill = indexOfText(built.input, SKILL_TEXT);
    const other = indexOfText(built.input, 'b rules');
    expect(indexOfText(built.input, 'a rules v1')).toBe(-1);
    expect(edited).toBeGreaterThan(0);
    expect(skill).toBe(edited + 1);
    expect(other).toBe(skill + 1);
  });
});

const OUTPUT_WEIGHT = 1000;
const outputOfWeight = (seq: number, callId: string): HistoryItem => {
  const empty = output(seq, callId, '');
  return output(seq, callId, 'o'.repeat(OUTPUT_WEIGHT - weightOf(empty.item)));
};

const candidateHistory = (capabilities: ReturnType<typeof capabilitiesFor>): HistoryItem[] => {
  const floor = weightOf({ type: 'message', role: 'system', content: SYSTEM_PROMPT }) + weightOf(TASK);
  const highMark = floor + floorRatio(COMPACT_AT, inputCeilingFor(capabilities) - floor);
  const oldTurn: HistoryItem[] = [user(1, 'old question')];
  for (let index = 1; index <= 4; index += 1) oldTurn.push(call(2 * index, `c${index}`), outputOfWeight(2 * index + 1, `c${index}`));
  oldTurn.push(assistant(10, 'old answer'));
  const withPad = (pad: number): HistoryItem[] => withTurnsBeforeCurrent([...oldTurn, user(11, 'p'.repeat(pad))]);
  const pad = highMark + 1 - floor - weightOfAll(withPad(0).map((entry) => entry.item));
  return withPad(pad);
};

const candidateInput = (capabilities: ReturnType<typeof capabilitiesFor>): BuildContextInput => ({ reasoningRoom: 0,
  capabilities,
  model: MODEL,
  sources: sourcesWith({ history: candidateHistory(capabilities) }),
  evicted: new Set<string>(),
  recordedReferences: new Set<string>(),
  touchedPaths: [],
  trusted: true,
  projectRoot: PROJECT,
  home: HOME,
  fence: TEST_FENCE,
});

const portsOf = () => ({ meter: weightMeter(), blobs: fakeBlobs(), instructions: fakeReader() });

describe('eviction on crossing H with context.cachePrefix (4.4, candidate rule)', () => {
  it('evicts every unprotected output in one batch when the total crosses H by one token', async () => {
    const capabilities = capabilitiesFor(8200, { maxOutputTokens: 1024 });

    const built = await buildContext(cachePrefix(candidateInput(capabilities)), portsOf());

    expect(built.evictions.map((eviction) => eviction.callId)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('stops at the baseline low mark without the setting, leaving the newest unprotected output', async () => {
    const capabilities = capabilitiesFor(8200, { maxOutputTokens: 1024 });

    const built = await buildContext(candidateInput(capabilities), portsOf());

    const evicted = built.evictions.map((eviction) => eviction.callId);
    expect(evicted.length).toBeGreaterThan(0);
    expect(evicted).not.toContain('c4');
  });
});
