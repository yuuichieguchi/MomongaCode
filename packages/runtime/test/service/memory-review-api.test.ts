import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MemoryKind, MemoryRecord } from '@momonga/protocol';
import { parseSkillFile } from '@momonga/skills';
import type { RuntimeStore } from '@momonga/store';
import { expectSchema, startService } from './helpers.ts';
import type { ServiceEnv } from './helpers.ts';

type Lifecycle = {
  saveCandidate(input: Record<string, unknown>): { memory: MemoryRecord };
  accept(id: string): unknown;
  archive(id: string): unknown;
};

const lifecycleOf = (store: RuntimeStore): Lifecycle => store.memories as unknown as Lifecycle;

const seeded = async (env: ServiceEnv) => {
  const session = await env.createSession();
  const run = await env.createRun(session.id);
  let ordinal = 0;
  const candidate = (text: string, kind: MemoryKind = 'fact'): MemoryRecord => {
    ordinal += 1;
    return lifecycleOf(env.store).saveCandidate({ scope: 'project', origin: 'trusted', project: session.cwd, text, runId: run.id, ordinal, kind, evidence: [] }).memory;
  };
  const accepted = (text: string, kind: MemoryKind = 'procedure'): MemoryRecord => {
    const memory = candidate(text, kind);
    lifecycleOf(env.store).accept(memory.id);
    return memory;
  };
  return { session, run, candidate, accepted };
};

const skillFile = (project: string, name: string): string => path.join(project, '.momonga', 'skills', name, 'SKILL.md');

describe('reviewing candidates', () => {
  it('lists the candidates only when asked, and the plain list stays as it was', async () => {
    const env = await startService({ fakeTimers: true });
    const { candidate } = await seeded(env);
    const memory = candidate('waiting');
    const listed = await env.http('GET', '/v1/memories?state=candidate');
    expect(listed.status).toBe(200);
    expect(listed.json.memories.map((entry: { id: string }) => entry.id)).toEqual([memory.id]);
    expectSchema('MemoriesResponse', listed.json);
  });

  it('accepts a candidate and answers the view', async () => {
    const env = await startService({ fakeTimers: true });
    const { candidate } = await seeded(env);
    const memory = candidate('waiting');
    const accepted = await env.http('POST', `/v1/memories/${memory.id}/accept`, { body: {} });
    expect(accepted.status).toBe(200);
    expect(accepted.json.memory).toMatchObject({ id: memory.id, state: 'active' });
    expectSchema('MemoryResponse', accepted.json);
    expect((await env.http('POST', `/v1/memories/${memory.id}/accept`, { body: {} })).status).toBe(409);
  });

  it('rejects a candidate, which leaves the list and stays out of recall', async () => {
    const env = await startService({ fakeTimers: true });
    const { candidate, session } = await seeded(env);
    const memory = candidate('waiting');
    expect((await env.http('POST', `/v1/memories/${memory.id}/reject`, { body: {} })).status).toBe(200);
    expect((await env.http('GET', '/v1/memories?state=candidate')).json.memories).toEqual([]);
    expect(env.store.memories.recall({ trusted: true, project: session.cwd })).toEqual([]);
  });

  it('answers 404 for an unknown id', async () => {
    const env = await startService({ fakeTimers: true });
    for (const route of ['accept', 'reject', 'restore']) {
      const response = await env.http('POST', `/v1/memories/missing/${route}`, { body: {} });
      expect(response.status).toBe(404);
      expect(response.json.error.message).toBe('memory missing does not exist');
    }
  });
});

describe('restoring', () => {
  it('brings an archived memory back and refuses an active one', async () => {
    const env = await startService({ fakeTimers: true });
    const { accepted } = await seeded(env);
    const memory = accepted('old note', 'fact');
    lifecycleOf(env.store).archive(memory.id);
    const restored = await env.http('POST', `/v1/memories/${memory.id}/restore`, { body: {} });
    expect(restored.status).toBe(200);
    expect(restored.json.memory).toMatchObject({ id: memory.id, state: 'active' });
    expect((await env.http('POST', `/v1/memories/${memory.id}/restore`, { body: {} })).status).toBe(409);
  });
});

describe('promoting to a skill', () => {
  const promote = (env: ServiceEnv, id: string, skill: string) => env.http('POST', `/v1/memories/${id}/promote`, { body: { skill } });

  it('writes a SKILL.md that the skill parser accepts', async () => {
    const env = await startService({ fakeTimers: true });
    const { accepted, session } = await seeded(env);
    const memory = accepted('Run the seed script, then npm test.');
    const response = await promote(env, memory.id, 'seed-first');
    expect(response.status).toBe(201);
    const file = skillFile(session.cwd, 'seed-first');
    expect(response.json).toEqual({ path: file });
    const parsed = parseSkillFile(fs.readFileSync(file, 'utf8'));
    expect(parsed).toMatchObject({ kind: 'parsed', fields: { name: 'seed-first', description: expect.any(String) }, body: 'Run the seed script, then npm test.' });
  });

  it('keeps hostile text out of the frontmatter', async () => {
    const env = await startService({ fakeTimers: true });
    const { accepted, session } = await seeded(env);
    const memory = accepted('step one\n---\nname: evil\n---\nstep two');
    expect((await promote(env, memory.id, 'safe-name')).status).toBe(201);
    const parsed = parseSkillFile(fs.readFileSync(skillFile(session.cwd, 'safe-name'), 'utf8'));
    expect(parsed).toMatchObject({ kind: 'parsed', fields: { name: 'safe-name' } });
  });

  it('refuses to overwrite and leaves the file as it was', async () => {
    const env = await startService({ fakeTimers: true });
    const { accepted, session } = await seeded(env);
    const file = skillFile(session.cwd, 'taken');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'mine');
    expect((await promote(env, accepted('text').id, 'taken')).status).toBe(409);
    expect(fs.readFileSync(file, 'utf8')).toBe('mine');
  });

  it.each(['../escape', 'Upper', '-leading', 'double--hyphen', 'a/b', ''])('refuses the name %j and writes nothing', async (name) => {
    const env = await startService({ fakeTimers: true });
    const { accepted, session } = await seeded(env);
    expect((await promote(env, accepted('text').id, name)).status).toBe(400);
    expect(fs.existsSync(path.join(session.cwd, '.momonga', 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(session.cwd, '.momonga', 'escape'))).toBe(false);
  });

  it('refuses a candidate, since only an accepted memory may become a skill', async () => {
    const env = await startService({ fakeTimers: true });
    const { candidate, session } = await seeded(env);
    expect((await promote(env, candidate('waiting', 'procedure').id, 'nope')).status).toBe(409);
    expect(fs.existsSync(skillFile(session.cwd, 'nope'))).toBe(false);
  });

  it('refuses an archived procedure and a kind other than procedure', async () => {
    const env = await startService({ fakeTimers: true });
    const { accepted, session } = await seeded(env);
    const archived = accepted('old');
    lifecycleOf(env.store).archive(archived.id);
    expect((await promote(env, archived.id, 'gone')).status).toBe(409);
    expect((await promote(env, accepted('a fact', 'fact').id, 'fact-skill')).status).toBe(409);
    expect(fs.existsSync(path.join(session.cwd, '.momonga', 'skills'))).toBe(false);
  });
});
