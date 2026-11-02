import { describe, expect, it } from 'vitest';
import { HISTORY_OUTPUT_HEAD_CHARS, HISTORY_OUTPUT_TAIL_CHARS } from '../src/search-constants.ts';
import { buildDocuments } from '../src/search-documents.ts';
import type { RecordedEvent } from '../src/search-documents.ts';
import { redactor } from './search-fixture.ts';

const ELISION_CHARS = '\n…\n'.length;

const GROUP_MAX_CHARS = HISTORY_OUTPUT_HEAD_CHARS + HISTORY_OUTPUT_TAIL_CHARS + ELISION_CHARS;

const parallelStep = (calls: number): RecordedEvent[] => [
  { seq: 1, step: 0, type: 'user.message', payload: { type: 'user.message', text: 'task' } },
  { seq: 2, step: 1, type: 'model.requested', payload: {} },
  ...Array.from({ length: calls }, (_, index): RecordedEvent => ({ seq: 3 + index, step: 1, type: 'tool.call', payload: { type: 'tool.call', callId: `c${index}`, name: 'Read', title: `Read /f${index}`, locations: [{ path: `/f${index}` }] } })),
  ...Array.from({ length: calls }, (_, index): RecordedEvent => ({ seq: 3 + calls + index, step: 1, type: 'tool.completed', payload: { type: 'tool.completed', callId: `c${index}`, output: `${'o'.repeat(10_000)}${index}` } })),
];

describe('search document size', () => {
  it.each([1, 5, 40])('bounds a step document by three groups however many calls the step holds (%i calls)', (calls) => {
    const documents = buildDocuments(parallelStep(calls), 'COMPLETED', redactor);
    const step = documents.find((document) => document.level === 'step');
    expect(step?.body.length).toBeLessThanOrEqual(3 * GROUP_MAX_CHARS + 2);
    expect(step?.paths).toHaveLength(calls);
  });

  it('keeps the last non-empty agent text as the final text when the last response holds only tool calls', () => {
    const responded = (seq: number, step: number, output: unknown[]): RecordedEvent => ({ seq, step, type: 'model.responded', payload: { type: 'model.responded', response: { output } } });
    const message = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'the last words said' }] }];
    const events: RecordedEvent[] = [{ seq: 1, step: 0, type: 'user.message', payload: { type: 'user.message', text: 'task' } }, responded(2, 1, message), responded(3, 2, [{ type: 'function_call' }])];
    const run = buildDocuments(events, 'STOPPED', redactor).find((document) => document.level === 'run');
    expect(run?.body).toContain('the last words said');
  });

  it('keeps the head and the tail of the joined outputs of parallel calls', () => {
    const body = buildDocuments(parallelStep(5), 'COMPLETED', redactor).find((document) => document.level === 'step')?.body ?? '';
    expect(body).toContain('Read /f0');
    expect(body.endsWith('4')).toBe(true);
  });
});
