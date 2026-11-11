import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { HISTORY_OUTPUT_HEAD_CHARS, HISTORY_OUTPUT_TAIL_CHARS } from '../src/search-constants.ts';
import { enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';
import { indexAll } from './search-fixture.ts';

const ELISION_CHARS = '\n…\n'.length;

const GROUP_MAX_CHARS = HISTORY_OUTPUT_HEAD_CHARS + HISTORY_OUTPUT_TAIL_CHARS + ELISION_CHARS;

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

const requested = (step: number): RunEventPayload => ({ type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: {} }) as unknown as RunEventPayload;

const responded = (step: number, output: unknown[]): RunEventPayload => ({ type: 'model.responded', step, attempt: 1, response: { status: 'completed', output, usage } }) as unknown as RunEventPayload;

const parallelStep = (calls: number): RunEventPayload[] => [
  requested(1),
  responded(1, []),
  ...Array.from(
    { length: calls },
    (_, index): RunEventPayload =>
      ({ type: 'tool.call', callId: `c${index}`, providerCallId: `c${index}`, name: 'Read', kind: 'read', title: `Read /f${index}`, rawInput: { file_path: `/f${index}` }, locations: [{ path: `/f${index}` }] }) as unknown as RunEventPayload,
  ),
  ...Array.from(
    { length: calls },
    (_, index): RunEventPayload => ({ type: 'tool.completed', callId: `c${index}`, status: 'completed', output: `${'o'.repeat(HISTORY_OUTPUT_HEAD_CHARS + HISTORY_OUTPUT_TAIL_CHARS)}${index}` }) as unknown as RunEventPayload,
  ),
];

type IndexedDocument = { level: string; body: string; paths: string[] };

const indexedDocumentsOf = async (events: readonly RunEventPayload[]): Promise<IndexedDocument[]> => {
  const { store, dbPath } = harness();
  const session = newSession(store);
  const run = await enqueue(store, session.id, 'task');
  const claim = mustClaim(store, 'w1');
  expect(store.append(claim, [...events]).kind).toBe('ok');
  expect((await store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
  await indexAll(store);
  return rawDb(dbPath)
    .prepare('SELECT level, body, paths_json FROM search_docs WHERE run_id = ? ORDER BY id')
    .all(run.id)
    .map((row) => ({ level: String(row['level']), body: String(row['body']), paths: JSON.parse(String(row['paths_json'])) as string[] }));
};

describe('search document size', () => {
  it.each([1, 5, 40])('bounds a step document by three groups however many calls the step holds (%i calls)', async (calls) => {
    const documents = await indexedDocumentsOf(parallelStep(calls));
    const step = documents.find((document) => document.level === 'step');
    expect(step).toBeDefined();
    expect(step?.body.length).toBeLessThanOrEqual(3 * GROUP_MAX_CHARS + 2);
    expect(step?.paths).toHaveLength(calls);
  });

  it('keeps the last non-empty agent text as the final text when the last response holds only tool calls', async () => {
    const message = [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'the last words said' }] }];
    const call = [{ type: 'function_call', id: 'f1', call_id: 'c1', name: 'Read', arguments: '{}' }];
    const documents = await indexedDocumentsOf([requested(1), responded(1, message), requested(2), responded(2, call)]);
    const run = documents.find((document) => document.level === 'run');
    expect(run?.body).toContain('the last words said');
  });

  it('keeps the head and the tail of the joined outputs of parallel calls', async () => {
    const body = (await indexedDocumentsOf(parallelStep(5))).find((document) => document.level === 'step')?.body ?? '';
    expect(body).toContain('Read /f0');
    expect(body.endsWith('4')).toBe(true);
  });
});
