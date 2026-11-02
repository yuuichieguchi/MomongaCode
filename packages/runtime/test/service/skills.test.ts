import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SkillsPort } from '@momonga/runtime';
import { SkillActivationError } from '@momonga/skills';
import { expectError, startService } from './helpers.ts';
import type { ServiceEnv } from './helpers.ts';

const writeSkill = (root: string, name: string, description: string, body = `${name} body`): string => {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
  return directory;
};

const projectSkills = (env: ServiceEnv): string => path.join(env.layout.project, '.agents', 'skills');

const skillEvents = (env: ServiceEnv, runId: string) => env.store.readRunEvents(runId, 0, 100).filter((event) => event.type === 'skill.activated');

describe('GET /v1/sessions/:id/skills', () => {
  it('lists the skills of the session with their scope and location', async () => {
    const env = await startService();
    const pdf = writeSkill(projectSkills(env), 'pdf', 'Extract PDF text');
    const zip = writeSkill(path.join(env.layout.home, '.agents', 'skills'), 'zip', 'Pack files');
    const session = await env.createSession();

    const response = await env.http('GET', `/v1/sessions/${session.id}/skills`);

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      skills: [
        { name: 'pdf', description: 'Extract PDF text', scope: 'project', location: path.join(pdf, 'SKILL.md') },
        { name: 'zip', description: 'Pack files', scope: 'user', location: path.join(zip, 'SKILL.md') },
      ],
      warnings: [],
    });
  });

  it('returns an empty list when the session has no skills', async () => {
    const env = await startService();
    const session = await env.createSession();
    expect((await env.http('GET', `/v1/sessions/${session.id}/skills`)).json).toEqual({ skills: [], warnings: [] });
  });

  it('answers the warnings of the scan, including the untrusted folder', async () => {
    const env = await startService({ skillsTrusted: () => false });
    writeSkill(projectSkills(env), 'pdf', 'Extract PDF text');
    writeSkill(path.join(env.layout.home, '.agents', 'skills'), 'zip', 'Pack files');
    const session = await env.createSession();

    const { json } = await env.http('GET', `/v1/sessions/${session.id}/skills`);

    expect(json.skills.map((skill: { name: string }) => skill.name)).toEqual(['zip']);
    expect(json.warnings).toEqual([`Project skills in ${projectSkills(env)} were skipped because the folder is not trusted`]);
  });

  it('reads the files on every request so that a new skill shows up', async () => {
    const env = await startService();
    const session = await env.createSession();
    expect((await env.http('GET', `/v1/sessions/${session.id}/skills`)).json.skills).toEqual([]);
    writeSkill(projectSkills(env), 'late', 'Added later');
    expect((await env.http('GET', `/v1/sessions/${session.id}/skills`)).json.skills.map((skill: { name: string }) => skill.name)).toEqual(['late']);
  });

  it('answers 404 for an unknown session and 405 for other methods', async () => {
    const env = await startService();
    expectError(await env.http('GET', '/v1/sessions/nope/skills'), 404, 'not_found');
    const session = await env.createSession();
    expectError(await env.http('POST', `/v1/sessions/${session.id}/skills`, { body: {} }), 405, 'method_not_allowed');
  });
});

describe('POST /v1/sessions/:id/runs with a skill', () => {
  it('records the wrapped skill right after the user message', async () => {
    const env = await startService();
    const pdf = writeSkill(projectSkills(env), 'pdf', 'Extract PDF text', 'Extract the text first.');
    const session = await env.createSession();

    const run = await env.createRun(session.id, { input: 'please', skill: 'pdf' });

    expect(env.store.readRunEvents(run.id, 0, 100).map((event) => event.type)).toEqual(['user.message', 'skill.activated']);
    const [activated] = skillEvents(env, run.id);
    expect(activated).toMatchObject({ name: 'pdf' });
    expect(activated?.type === 'skill.activated' ? activated.content : '').toContain('<skill_content name="pdf">\nExtract the text first.');
    expect(activated?.type === 'skill.activated' ? activated.content : '').toContain(`Skill directory: ${pdf}`);
  });

  it('keeps the skill content out of the public event stream', async () => {
    const env = await startService();
    writeSkill(projectSkills(env), 'pdf', 'Extract PDF text', 'Secret instructions.');
    const session = await env.createSession();
    const run = await env.createRun(session.id, { input: 'please', skill: 'pdf' });
    const lastSeq = (await env.getRun(run.id)).lastSeq as number;

    const stream = await env.stream(`/v1/runs/${run.id}/events`);
    const frames = await stream.until((event) => event.seq === lastSeq);

    const activated = frames.find((event) => event.type === 'skill.activated');
    expect(activated).toMatchObject({ name: 'pdf' });
    expect(Object.keys(activated ?? {}).sort()).toEqual(['createdAt', 'id', 'name', 'runId', 'seq', 'sessionId', 'step', 'type']);
    expect(JSON.stringify(frames)).not.toContain('Secret instructions.');
  });

  it('rejects an unknown skill with 422 unknown_skill listing the available ones and stores no run', async () => {
    const env = await startService();
    writeSkill(projectSkills(env), 'pdf', 'Extract PDF text');
    const session = await env.createSession();

    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'x', skill: 'nope' } });

    expectError(response, 422, 'unknown_skill');
    expect(response.json.error).toMatchObject({ param: 'skill', message: 'unknown skill "nope"; available skills: pdf' });
    expect(env.store.listRuns(session.id)).toEqual([]);
  });

  it('rejects a project skill of an untrusted folder as unknown', async () => {
    const env = await startService({ skillsTrusted: () => false });
    writeSkill(projectSkills(env), 'pdf', 'Extract PDF text');
    const session = await env.createSession();
    expectError(await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'x', skill: 'pdf' } }), 422, 'unknown_skill');
  });

  it('answers 422 skill_unavailable when the skill cannot be activated and stores no run', async () => {
    const failing: SkillsPort = {
      load: async () => ({
        skills: [],
        warnings: [],
        readDirectories: [],
        catalog: undefined,
        activate: async () => {
          throw new SkillActivationError('the SKILL.md of skill "pdf" no longer exists');
        },
        activationTool: () => undefined,
      }),
    };
    const env = await startService({ skills: failing });
    const session = await env.createSession();

    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'x', skill: 'pdf' } });

    expectError(response, 422, 'skill_unavailable');
    expect(response.json.error).toMatchObject({ param: 'skill', message: 'the SKILL.md of skill "pdf" no longer exists' });
    expect(env.store.listRuns(session.id)).toEqual([]);
  });

  it('rejects an empty skill name', async () => {
    const env = await startService();
    const session = await env.createSession();
    expectError(await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'x', skill: '' } }), 400, 'invalid_request');
  });

  it('replays an idempotent request without reading the skill again', async () => {
    const env = await startService();
    const directory = writeSkill(projectSkills(env), 'pdf', 'Extract PDF text');
    const session = await env.createSession();
    const headers = { 'idempotency-key': 'key-1' };
    const first = await env.createRun(session.id, { input: 'x', skill: 'pdf' }, headers);

    fs.rmSync(directory, { recursive: true });
    const replay = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'x', skill: 'pdf' }, headers });

    expect(replay.status).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json.run.id).toBe(first.id);
    expect(skillEvents(env, first.id)).toHaveLength(1);
  });

  it('treats the same key with another skill as a different request', async () => {
    const env = await startService();
    writeSkill(projectSkills(env), 'pdf', 'Extract PDF text');
    writeSkill(projectSkills(env), 'zip', 'Pack files');
    const session = await env.createSession();
    const headers = { 'idempotency-key': 'key-2' };
    await env.createRun(session.id, { input: 'x', skill: 'pdf' }, headers);
    expectError(await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'x', skill: 'zip' }, headers }), 422, 'idempotency_key_reused');
  });

  it('records no skill activation for a plain run', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id, { input: 'plain' });
    expect(skillEvents(env, run.id)).toEqual([]);
  });
});
