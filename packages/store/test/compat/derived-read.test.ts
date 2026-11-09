import { describe, expect, it } from 'vitest';
import { REPAIR_PAGE_EVENTS } from '../../src/derived-repair.ts';
import { enqueue, harness, mustClaim, newSession, rawDb } from '../helpers.ts';
import { appendForeignRunEvent } from './fixtures.ts';

const answer = (text: string): Record<string, unknown> => ({
  step: 1,
  attempt: 1,
  target: 'primary',
  response: { id: `resp-${text}`, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
});

const finishedByOlderBuild = (lagEvents: number) => {
  const env = harness();
  const run = enqueue(env.store, newSession(env.store).id, 'task');
  mustClaim(env.store, 'w-old');
  const db = rawDb(env.dbPath);
  db.exec('BEGIN');
  for (let index = 0; index < lagEvents; index += 1) appendForeignRunEvent(db, run.id, 'notice', { level: 'info', message: `old ${index}`, code: `old.${index}` });
  appendForeignRunEvent(db, run.id, 'model.responded', answer('first answer'));
  db.exec('COMMIT');
  return { ...env, run, db };
};

const lastAnswerInEvents = (db: ReturnType<typeof rawDb>, runId: string): string => {
  const row = db.prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'model.responded' ORDER BY seq DESC LIMIT 1").get(runId);
  const payload: unknown = JSON.parse(String(row?.['payload_json']));
  const text = (payload as { response: { output: { content: { text: string }[] }[] } }).response.output[0]?.content[0]?.text;
  if (text === undefined) throw new Error('the answer carries no text');
  return text;
};

describe('a read of a derivation brings it up to date (H7, 11.5 correction rules 1 and 4)', () => {
  it('an older-build append that lands while the read pages still shows in what the read returns, which is what its snapshot events say', async () => {
    const { store, run, db } = finishedByOlderBuild(2 * REPAIR_PAGE_EVENTS + 10);
    let appended = 0;
    let stopped = false;
    const appendBetweenPages = (): void => {
      if (stopped || appended >= 2) return;
      appended += 1;
      appendForeignRunEvent(db, run.id, 'model.responded', answer(`later answer ${appended}`));
      setImmediate(appendBetweenPages);
    };
    setImmediate(appendBetweenPages);
    const text = await store.finalTextOf(run.id);
    stopped = true;
    expect(appended).toBeGreaterThan(0);
    expect(text).toBe(lastAnswerInEvents(db, run.id));
  });

  it('a lag of three pages frees the event loop between its pages, so an interleaved timer runs between them', async () => {
    const { store, run } = finishedByOlderBuild(2 * REPAIR_PAGE_EVENTS + 10);
    let ticks = 0;
    let reading = true;
    const tick = (): void => {
      if (!reading) return;
      ticks += 1;
      setImmediate(tick);
    };
    setImmediate(tick);
    const text = await store.finalTextOf(run.id);
    reading = false;
    expect(text).toBe('first answer');
    expect(ticks).toBeGreaterThanOrEqual(2);
  });
});

describe('a writable read takes the write lock only to write a page (H7, 11.5, settled at I1 Stage C)', () => {
  it('a read with no lag answers while another connection holds an open write transaction', async () => {
    const { store, run, db } = finishedByOlderBuild(0);
    expect(await store.finalTextOf(run.id)).toBe('first answer');
    db.exec('BEGIN IMMEDIATE');
    try {
      expect(await store.finalTextOf(run.id)).toBe('first answer');
    } finally {
      db.exec('ROLLBACK');
    }
  });
});
