import { describe, expect, it } from 'vitest';
import { openDatabase } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import { createJournalReader } from '@momonga/store';
import { contributionAtTerminal } from '@momonga/runtime';
import { answeredRun, chainBuilder, referenceHarness, referenceOf } from '../../../store/test/support/reference.ts';
import type { ChainBuilder, ReferenceHarness } from '../../../store/test/support/reference.ts';

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

const said = (step: number, text: string): RunEventPayload[] => [
  { type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { tool_choice: 'auto' } },
  {
    type: 'model.responded',
    step,
    attempt: 1,
    response: { status: 'completed', output: [{ type: 'message', id: `m${step}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }], usage },
  } as RunEventPayload,
];

const MEMORIES: Record<string, string> = { m1: 'see src/gen/zorpquux.ts', m2: 'see src/gen/novelxyz.ts' };

describe('11d: the contribution hook resolves inherited segments through the reader', () => {
  it('treats an identifier retained in the inherited history as not new and one absent from it as new, for a reference event', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'Look around', (claim) => b.append(claim, said(1, 'I edited src/gen/zorpquux.ts')), { fresh: true });
    const child = await answeredRun(h, b, 'Continue', (claim) =>
      b.append(claim, [
        { type: 'context.memories_loaded', memories: [{ id: 'm1', status: 'unbound' }, { id: 'm2', status: 'unbound' }] },
        ...said(101, 'Now src/gen/zorpquux.ts and src/gen/novelxyz.ts'),
      ]),
    );
    expect(referenceOf(h.store, child.id)).toMatchObject({ form: 'reference' });

    const db = openDatabase(h.dbPath);
    try {
      const reader = createJournalReader(db, {
        lookups: {
          memories: { get: (id: string) => (MEMORIES[id] === undefined ? undefined : ({ text: MEMORIES[id] } as never)) },
          governing: { get: () => undefined },
        },
      });
      const measured = reader.measure(contributionAtTerminal, { runId: child.id, leading: [] });
      expect(measured.contribution?.items).toContainEqual({ kind: 'memory', id: 'm1', contributed: false });
      expect(measured.contribution?.items).toContainEqual({ kind: 'memory', id: 'm2', contributed: true });
    } finally {
      db.close();
    }
  });
});

type Claimed = Parameters<ChainBuilder['text']>[0];

type Shape = (h: ReferenceHarness, b: ChainBuilder, oldShape: boolean) => Promise<string>;

const LOADED: RunEventPayload = { type: 'context.memories_loaded', memories: [{ id: 'm1', status: 'unbound' }, { id: 'm2', status: 'unbound' }] };

const measuredOf = (h: ReferenceHarness, runId: string) => {
  const db = openDatabase(h.dbPath);
  try {
    const reader = createJournalReader(db, {
      lookups: {
        memories: { get: (id: string) => (MEMORIES[id] === undefined ? undefined : ({ text: MEMORIES[id] } as never)) },
        governing: { get: () => undefined },
      },
    });
    return reader.measure(contributionAtTerminal, { runId, leading: [] }).contribution?.items;
  } finally {
    db.close();
  }
};

const both = async (shape: Shape) => {
  const results = [];
  for (const oldShape of [false, true]) {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const child = await shape(h, b, oldShape);
    const inherited = h.store.readRunEvents(child, 0, 1000).find((event) => event.type === 'context.inherited');
    expect(inherited === undefined ? undefined : 'form' in inherited ? inherited.form : 'copy').toBe(oldShape ? 'copy' : 'reference');
    results.push(measuredOf(h, child));
  }
  const [reference, copy] = results;
  return { reference, copy };
};

const finalRun = async (h: ReferenceHarness, b: ChainBuilder, oldShape: boolean, body: (claim: Claimed) => void) =>
  (await answeredRun(h, b, 'Continue', (claim) => {
    b.append(claim, [LOADED]);
    body(claim);
    b.append(claim, said(201, 'Now src/gen/zorpquux.ts and src/gen/novelxyz.ts'));
  }, { oldShape })).id;

describe('11d parity: the reference form contributes exactly what the copy form contributes (13.12 reader table)', () => {
  it('with a compaction floor in the source that replaced the mention', async () => {
    const { reference, copy } = await both(async (h, b, oldShape) => {
      await answeredRun(h, b, 'Look around', (claim) => {
        b.append(claim, said(1, 'I edited src/gen/zorpquux.ts'));
        b.text(claim);
        b.compact(claim, 2);
      }, { fresh: true });
      return finalRun(h, b, oldShape, () => undefined);
    });
    expect(reference).toEqual(copy);
    expect(copy).toContainEqual({ kind: 'memory', id: 'm1', contributed: true });
  });

  it('with an own compaction of the child after the inheritance', async () => {
    const { reference, copy } = await both(async (h, b, oldShape) => {
      await answeredRun(h, b, 'Look around', (claim) => b.append(claim, said(1, 'I edited src/gen/zorpquux.ts')), { fresh: true });
      return finalRun(h, b, oldShape, (claim) => {
        b.text(claim);
        b.compact(claim, 3);
      });
    });
    expect(reference).toEqual(copy);
  });

  it('through a two-run chain', async () => {
    const { reference, copy } = await both(async (h, b, oldShape) => {
      await answeredRun(h, b, 'Look around', (claim) => b.append(claim, said(1, 'I edited src/gen/zorpquux.ts')), { fresh: true });
      await answeredRun(h, b, 'Middle', (claim) => b.text(claim), { oldShape });
      return finalRun(h, b, oldShape, () => undefined);
    });
    expect(reference).toEqual(copy);
    expect(copy).toContainEqual({ kind: 'memory', id: 'm1', contributed: false });
    expect(copy).toContainEqual({ kind: 'memory', id: 'm2', contributed: true });
  });
});
