import { describe, expect, it } from 'vitest';
import type { MemoryJudgementView, MemoryView } from '@momonga/protocol';
import * as format from '../src/memory/format.ts';
import { formatMemory, shownModelIn } from '../src/memory/format.ts';
import type { ShownModel } from '../src/memory/format.ts';

type Judgement = MemoryJudgementView;

const AS_STORED = shownModelIn(new Map());

const formatter = (shownModel: ShownModel = AS_STORED): ((judgement: Judgement) => string) => {
  const found = (format as Record<string, unknown>)['formatMemoryJudgement'];
  if (typeof found !== 'function') throw new Error('memory/format.ts does not export formatMemoryJudgement');
  return (judgement) => (found as (judgement: Judgement, shownModel: ShownModel) => string)(judgement, shownModel);
};

const leveller = (): ((judgement: Judgement) => 'info' | 'warning') => {
  const found = (format as Record<string, unknown>)['memoryJudgementLevel'];
  if (typeof found !== 'function') throw new Error('memory/format.ts does not export memoryJudgementLevel');
  return found as (judgement: Judgement) => 'info' | 'warning';
};

const CLASSIFIER = 'openai/gpt-5-mini';

const NO_CLASSIFIER = 'the memory judgement passed its deadline of 1000 ms';

const judgement = (overrides: Partial<Judgement> = {}): Judgement => ({ memoryId: 'mem-1', outcome: 'left', classifier: CLASSIFIER, judgedAt: 0, owed: true, closed: false, ...overrides });

describe('the line of a judged memory', () => {
  it('says auto review kept a memory the classifier judged safe with high confidence', () => {
    expect(formatter()(judgement({ outcome: 'kept', verdict: 'safe', confidence: 'high' }))).toBe(
      'auto review kept memory mem-1; model openai/gpt-5-mini judged it safe with high confidence',
    );
  });

  it.each(['medium', 'low'] as const)('says auto review left a memory waiting that the classifier judged safe with %s confidence', (confidence) => {
    expect(formatter()(judgement({ verdict: 'safe', confidence }))).toBe('auto review left memory mem-1 waiting; model openai/gpt-5-mini judged it safe without high confidence');
  });

  it.each(['high', 'medium', 'low'] as const)('says auto review left a memory waiting that the classifier judged unsafe with %s confidence', (confidence) => {
    expect(formatter()(judgement({ verdict: 'unsafe', confidence }))).toBe('auto review left memory mem-1 waiting; model openai/gpt-5-mini judged it unsafe');
  });

  it('gives the failure text when the classifier could not be asked', () => {
    expect(formatter()({ memoryId: 'mem-2', outcome: 'left', failure: NO_CLASSIFIER, judgedAt: 0, owed: true, closed: false })).toBe(`auto review left memory mem-2 waiting; ${NO_CLASSIFIER}`);
  });

  it('gives the failure text when the classifier answered wrongly, whatever classifier is named', () => {
    expect(formatter()(judgement({ memoryId: 'mem-3', failure: 'the classifier stream ended without a terminal event' }))).toBe(
      'auto review left memory mem-3 waiting; the classifier stream ended without a terminal event',
    );
  });

  it('names the classifier of the record', () => {
    expect(formatter()(judgement({ outcome: 'kept', classifier: 'ollama/qwen3:8b', verdict: 'safe', confidence: 'high' }))).toBe(
      'auto review kept memory mem-1; model ollama/qwen3:8b judged it safe with high confidence',
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

describe('memory show of a memory auto review kept', () => {
  it('is as today for a memory no classifier kept', () => {
    expect(formatMemory(MEMORY, AS_STORED)).toBe(SHOWN_TODAY);
  });

  it('names auto review and the model directly after the kept line', () => {
    expect(formatMemory({ ...MEMORY, keptByClassifier: CLASSIFIER }, AS_STORED)).toBe(
      [
        'id: mem-1',
        'scope: project',
        'origin: trusted',
        'kind: fact',
        'status: unbound',
        'project: /work/project',
        'created: 1970-01-01T00:00:00.000Z',
        'kept: 1970-01-01T00:00:01.000Z',
        'kept by: auto review, model openai/gpt-5-mini',
        'source: session s1, run r1, step 2, call c1, event 9',
        '',
        '  The build uses pnpm.',
      ].join('\n'),
    );
  });

  it('puts the line before the validity line of a memory that has one', () => {
    const withValidity = { ...MEMORY, validity: { intervals: [{ status: 'unbound', from: 0, to: null }], changes: [] } } as unknown as MemoryView;
    const before = formatMemory(withValidity, AS_STORED).split('\n');
    const after = formatMemory({ ...withValidity, keptByClassifier: CLASSIFIER }, AS_STORED).split('\n');
    const kept = before.indexOf('kept: 1970-01-01T00:00:01.000Z');
    expect(before[kept + 1]?.startsWith('validity: ')).toBe(true);
    expect(after).toEqual([...before.slice(0, kept + 1), 'kept by: auto review, model openai/gpt-5-mini', ...before.slice(kept + 1)]);
  });
});

const CANON = 'ollama/gemma-3-4b:latest';

const DISPLAY = 'ollama/gemma-3-4b';

const UNCONFIGURED = 'openai/gpt-9';

const BY_DISPLAY = shownModelIn(new Map([[CANON, DISPLAY]]));

describe('the model a person sees is named by its display', () => {
  it.each([
    ['kept, safe with high confidence', judgement({ outcome: 'kept', classifier: CANON, verdict: 'safe', confidence: 'high' }), `auto review kept memory mem-1; model ${DISPLAY} judged it safe with high confidence`],
    ['left, safe without high confidence', judgement({ classifier: CANON, verdict: 'safe', confidence: 'low' }), `auto review left memory mem-1 waiting; model ${DISPLAY} judged it safe without high confidence`],
    ['left, unsafe', judgement({ classifier: CANON, verdict: 'unsafe', confidence: 'high' }), `auto review left memory mem-1 waiting; model ${DISPLAY} judged it unsafe`],
    ['left, a model missing from the lookup as stored', judgement({ classifier: UNCONFIGURED, verdict: 'unsafe', confidence: 'high' }), `auto review left memory mem-1 waiting; model ${UNCONFIGURED} judged it unsafe`],
    ['a failure as it is', judgement({ classifier: CANON, failure: NO_CLASSIFIER }), `auto review left memory mem-1 waiting; ${NO_CLASSIFIER}`],
  ] as const)('on the line of %s', (_name, record, line) => {
    expect(formatter(BY_DISPLAY)(record)).toBe(line);
  });

  it.each([
    ['by its display', CANON, `kept by: auto review, model ${DISPLAY}`],
    ['as stored when it is missing from the lookup', UNCONFIGURED, `kept by: auto review, model ${UNCONFIGURED}`],
  ])('on the kept by line %s', (_name, classifier, keptBy) => {
    const lines = formatMemory({ ...MEMORY, keptByClassifier: classifier }, BY_DISPLAY).split('\n');
    expect(lines[lines.indexOf('kept: 1970-01-01T00:00:01.000Z') + 1]).toBe(keptBy);
  });
});
