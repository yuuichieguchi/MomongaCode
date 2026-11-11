import { describe, expect, it } from 'vitest';
import { RUN_API_SCHEMAS, toPublicRunEvent } from '@momonga/protocol';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { enqueue, harness, newSession, rawDb } from './helpers.ts';
import { appendForeignRunEvent } from './compat/fixtures.ts';

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);

describe('a tool.permission.classified event written by an earlier build', () => {
  it('decodes with its alias read as the model, and passes the public schema', async () => {
    const env = harness();
    const run = await enqueue(env.store, newSession(env.store).id);
    const db = rawDb(env.dbPath);
    const seq = appendForeignRunEvent(db, run.id, 'tool.permission.classified', { callId: 'c1', subjectDigest: 'd', alias: 'local', outcome: 'ask' });
    db.close();

    const event = env.store.readRunEvents(run.id, 0, 100).find((candidate) => candidate.seq === seq);

    expect(event).toMatchObject({ type: 'tool.permission.classified', model: 'local' });
    expect(event).not.toHaveProperty('alias');
    if (event === undefined) throw new Error('the event was not read');
    expect(ajv.compile(RUN_API_SCHEMAS.PublicRunEvent)(toPublicRunEvent(event))).toBe(true);
  });
});
