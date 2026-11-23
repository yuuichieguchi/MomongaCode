import { describe, expect, it } from 'vitest';
import type { MemoryJudgementView, MemoryView } from '@momonga/protocol';
import * as format from '../src/memory/format.ts';
import { formatMemory } from '../src/memory/format.ts';

type Judgement = MemoryJudgementView;

const formatter = (): ((judgement: Judgement) => string) => {
  const found = (format as Record<string, unknown>)['formatMemoryJudgement'];
  if (typeof found !== 'function') throw new Error('memory/format.ts does not export formatMemoryJudgement');
  return found as (judgement: Judgement) => string;
};

const leveller = (): ((judgement: Judgement) => 'info' | 'warning') => {
  const found = (format as Record<string, unknown>)['memoryJudgementLevel'];
  if (typeof found !== 'function') throw new Error('memory/format.ts does not export memoryJudgementLevel');
  return found as (judgement: Judgement) => 'info' | 'warning';
};

const CLASSIFIER = 'openai/gpt-5-mini';

const NO_CLASSIFIER = 'no classifier model is configured: set autoMode.classifier in the user settings, or run /auto-mode and choose one';

const judgement = (overrides: Partial<Judgement> = {}): Judgement => ({ memoryId: 'mem-1', outcome: 'left', classifier: CLASSIFIER, judgedAt: 0, owed: true, closed: false, ...overrides });

describe('the line of a judged memory', () => {
  it('says auto mode kept a memory the classifier judged safe with high confidence', () => {
    expect(formatter()(judgement({ outcome: 'kept', verdict: 'safe', confidence: 'high' }))).toBe(
      'auto mode kept memory mem-1; classifier openai/gpt-5-mini judged it safe with high confidence',
    );
  });

  it.each(['medium', 'low'] as const)('says auto mode left a memory waiting that the classifier judged safe with %s confidence', (confidence) => {
    expect(formatter()(judgement({ verdict: 'safe', confidence }))).toBe('auto mode left memory mem-1 waiting; classifier openai/gpt-5-mini judged it safe without high confidence');
  });

  it.each(['high', 'medium', 'low'] as const)('says auto mode left a memory waiting that the classifier judged unsafe with %s confidence', (confidence) => {
    expect(formatter()(judgement({ verdict: 'unsafe', confidence }))).toBe('auto mode left memory mem-1 waiting; classifier openai/gpt-5-mini judged it unsafe');
  });

  it('gives the failure text when the classifier could not be asked', () => {
    expect(formatter()({ memoryId: 'mem-2', outcome: 'left', failure: NO_CLASSIFIER, judgedAt: 0, owed: true, closed: false })).toBe(`auto mode left memory mem-2 waiting; ${NO_CLASSIFIER}`);
  });

  it('gives the failure text when the classifier answered wrongly, whatever classifier is named', () => {
    expect(formatter()(judgement({ memoryId: 'mem-3', failure: 'the classifier stream ended without a terminal event' }))).toBe(
      'auto mode left memory mem-3 waiting; the classifier stream ended without a terminal event',
    );
  });

  it('names the classifier of the record', () => {
    expect(formatter()(judgement({ outcome: 'kept', classifier: 'ollama/qwen3:8b', verdict: 'safe', confidence: 'high' }))).toBe(
      'auto mode kept memory mem-1; classifier ollama/qwen3:8b judged it safe with high confidence',
    );
  });
});

describe('the level of the line of a judged memory', () => {
  it('is a warning when the classifier failed', () => {
    expect(leveller()(judgement({ failure: NO_CLASSIFIER }))).toBe('warning');
  });

  it.each([
    ['kept', 'safe', 'high'],
    ['left', 'safe', 'medium'],
    ['left', 'unsafe', 'high'],
  ] as const)('is info for %s, %s, %s', (outcome, verdict, confidence) => {
    expect(leveller()(judgement({ outcome, verdict, confidence }))).toBe('info');
  });
});

const MEMORY: MemoryView = {
  id: 'mem-1',
  scope: 'project',
  origin: 'trusted',
  project: '/work/project',
  text: 'The build uses pnpm.',
  source: { kind: 'tool', sessionId: 's1', runId: 'r1', step: 2, callId: 'c1', seq: 9 },
  createdAt: 0,
  keptAt: 1000,
  kind: 'fact',
  state: 'active',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [],
  contributedAt: null,
  keptByClassifier: null,
  status: 'unbound',
};

const SHOWN_TODAY = [
  'id: mem-1',
  'scope: project',
  'origin: trusted',
  'kind: fact',
  'status: unbound',
  'project: /work/project',
  'created: 1970-01-01T00:00:00.000Z',
  'kept: 1970-01-01T00:00:01.000Z',
  'source: session s1, run r1, step 2, call c1, event 9',
  '',
  '  The build uses pnpm.',
].join('\n');

describe('memory show of a memory auto mode kept', () => {
  it('is as today for a memory no classifier kept', () => {
    expect(formatMemory(MEMORY)).toBe(SHOWN_TODAY);
  });

  it('names auto mode and the classifier directly after the kept line', () => {
    expect(formatMemory({ ...MEMORY, keptByClassifier: CLASSIFIER })).toBe(
      [
        'id: mem-1',
        'scope: project',
        'origin: trusted',
        'kind: fact',
        'status: unbound',
        'project: /work/project',
        'created: 1970-01-01T00:00:00.000Z',
        'kept: 1970-01-01T00:00:01.000Z',
        'kept by: auto mode, classifier openai/gpt-5-mini',
        'source: session s1, run r1, step 2, call c1, event 9',
        '',
        '  The build uses pnpm.',
      ].join('\n'),
    );
  });

  it('puts the line before the validity line of a memory that has one', () => {
    const withValidity = { ...MEMORY, validity: { intervals: [{ status: 'unbound', from: 0, to: null }], changes: [] } } as unknown as MemoryView;
    const before = formatMemory(withValidity).split('\n');
    const after = formatMemory({ ...withValidity, keptByClassifier: CLASSIFIER }).split('\n');
    const kept = before.indexOf('kept: 1970-01-01T00:00:01.000Z');
    expect(before[kept + 1]?.startsWith('validity: ')).toBe(true);
    expect(after).toEqual([...before.slice(0, kept + 1), 'kept by: auto mode, classifier openai/gpt-5-mini', ...before.slice(kept + 1)]);
  });
});
