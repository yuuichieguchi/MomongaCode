import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEADLINE_MS, capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { MODEL_ID, callsStep, textStep } from './scripts.ts';

const ROOT_MODEL = MODEL_ID;
const CHILD_MODEL = 'child-model';
const GRANDCHILD_MODEL = 'grandchild-model';
const SWITCHED_MODEL = 'switched-model';
const NAMED = 'guard';
const HOLD_MS = 3_600_000;
const MAX_CLAIMS = 6;

const SAFE = JSON.stringify({ verdict: 'safe', confidence: 'high', rationale: 'writes a file the user asked for' });
const UNSAFE = JSON.stringify({ verdict: 'unsafe', confidence: 'high', rationale: 'not asked for' });

type Designation = 'absent' | 'named';

const setup = async (designation: Designation) => {
  const env = await makeEnv({ mode: 'auto' });
  env.gateway.listed = [ROOT_MODEL, CHILD_MODEL, GRANDCHILD_MODEL, SWITCHED_MODEL];
  if (designation === 'named') {
    env.settings.classifierModel = NAMED;
    env.gateway.capabilitiesByModel[NAMED] = capabilitiesFor(env.gateway.capabilitiesValue.contextWindow, { structuredOutput: 'json_schema' });
  }
  return env;
};

const writeStep = (env: Env, callId: string, file: string) => callsStep([{ callId, name: 'Write', args: { file_path: path.join(env.project, file), content: 'x' } }]);

const classifierModels = (env: Env): (string | undefined)[] => env.gateway.streams.filter((stream) => stream.role === 'classifier').map((stream) => stream.body.model);

const classifiedModels = (env: Env, runId: string): unknown[] => env.ofType(runId, 'tool.permission.classified').map((event) => event.model);

const drive = async (env: Env, runId: string): Promise<void> => {
  for (let claim = 0; claim < MAX_CLAIMS && !['COMPLETED', 'FAILED', 'STOPPED', 'WAITING_HUMAN'].includes(env.run(runId).status); claim += 1) {
    await env.runOnce(env.worker());
  }
};

const startedRoot = async (env: Env, pinnedModel: string) => {
  const created = await env.store.createRunAndEnqueue(env.session.id, { input: 'Write the files', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {} });
  if (created.kind !== 'created') throw new Error(`the root run was not created: ${created.kind}`);
  const claim = await env.seed(created.run.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: { model: pinnedModel, roles: {} }, mode: 'auto' }], 'hold');
  return { run: created.run, claim };
};

const childOf = async (env: Env, parentRunId: string, callId: string, model: string) => {
  const child = await env.store.createChildRun({ parentRunId, parentCallId: callId, input: `Write as ${model}`, pins: {}, model });
  if (child.kind !== 'created') throw new Error(`the child run was not created: ${child.kind}`);
  return child.run;
};

const release = async (env: Env, claim: Awaited<ReturnType<Env['seed']>>): Promise<void> => {
  const released = await env.store.releaseLease(claim, { availableAt: env.clock.now() + HOLD_MS });
  if (released.kind !== 'ok') throw new Error(`the held run could not be released: ${released.kind}`);
};

const expected = (designation: Designation, rootModel: string): string => (designation === 'named' ? NAMED : rootModel);

describe.each<Designation>(['absent', 'named'])('the model that judges a tool call in auto, with autoMode.classifier %s', (designation) => {
  it('judges a call of the root run with the model the root run pinned', async () => {
    const env = await setup(designation);
    env.gateway.script.push(writeStep(env, 'call_w_1', 'out.txt'), textStep(SAFE), textStep('Written.'));
    const run = await env.enqueue('Write out.txt');
    await drive(env, run.id);
    expect(classifierModels(env)).toEqual([expected(designation, ROOT_MODEL)]);
    expect(classifiedModels(env, run.id)).toEqual([expected(designation, ROOT_MODEL)]);
    expect(env.ofType(run.id, 'tool.permission.classified')).toMatchObject([{ outcome: 'allow' }]);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.readFileSync(path.join(env.project, 'out.txt'), 'utf8')).toBe('x');
  });

  it('judges a call of a child on another model with the model the root run pinned, also after the session model was switched', async () => {
    const env = await setup(designation);
    const root = await startedRoot(env, ROOT_MODEL);
    env.store.setModel(env.session.id, SWITCHED_MODEL);
    const child = await childOf(env, root.run.id, 'call_child', CHILD_MODEL);
    await release(env, root.claim);
    env.gateway.script.push(writeStep(env, 'call_w_1', 'child.txt'), textStep(SAFE), textStep('Written.'));
    await drive(env, child.id);
    expect(env.store.getSession(child.sessionId)?.model).toBe(CHILD_MODEL);
    expect(classifierModels(env)).toEqual([expected(designation, ROOT_MODEL)]);
    expect(classifiedModels(env, child.id)).toEqual([expected(designation, ROOT_MODEL)]);
    expect(env.run(child.id).status).toBe('COMPLETED');
  });

  it('judges a call of a grandchild whose parent runs on another model than the root with the model the root run pinned', async () => {
    const env = await setup(designation);
    const root = await startedRoot(env, ROOT_MODEL);
    env.store.setModel(env.session.id, SWITCHED_MODEL);
    const child = await childOf(env, root.run.id, 'call_child', CHILD_MODEL);
    await release(env, root.claim);
    const childClaim = await env.seed(child.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: { model: CHILD_MODEL, roles: {} }, mode: 'auto' }], 'hold');
    const grandchild = await childOf(env, child.id, 'call_grandchild', GRANDCHILD_MODEL);
    await release(env, childClaim);
    env.gateway.script.push(writeStep(env, 'call_w_1', 'grandchild.txt'), textStep(SAFE), textStep('Written.'));
    await drive(env, grandchild.id);
    expect(env.store.getSession(grandchild.sessionId)?.model).toBe(GRANDCHILD_MODEL);
    expect(classifierModels(env)).toEqual([expected(designation, ROOT_MODEL)]);
    expect(classifiedModels(env, grandchild.id)).toEqual([expected(designation, ROOT_MODEL)]);
    expect(env.run(grandchild.id).status).toBe('COMPLETED');
  });

  it('keeps the judge of a working run when the session model is switched, and the next run is judged by the new model', async () => {
    const env = await setup(designation);
    env.gateway.script.push(writeStep(env, 'call_w_1', 'first.txt'), textStep(UNSAFE));
    const first = await env.enqueue('Write first.txt and second.txt');
    await drive(env, first.id);
    expect(env.run(first.id).status).toBe('WAITING_HUMAN');
    env.store.setModel(env.session.id, SWITCHED_MODEL);
    await env.resolveApproval(first.id, 'allow_once');
    env.gateway.script.push(writeStep(env, 'call_w_2', 'second.txt'), textStep(SAFE), textStep('Written both.'));
    await drive(env, first.id);
    expect(env.run(first.id).status).toBe('COMPLETED');
    expect(classifiedModels(env, first.id)).toEqual([expected(designation, ROOT_MODEL), expected(designation, ROOT_MODEL)]);

    env.gateway.script.push(writeStep(env, 'call_w_3', 'third.txt'), textStep(SAFE), textStep('Written.'));
    const next = await env.enqueue('Write third.txt');
    await drive(env, next.id);
    expect(env.run(next.id).status).toBe('COMPLETED');
    expect(classifiedModels(env, next.id)).toEqual([expected(designation, SWITCHED_MODEL)]);
    expect(classifierModels(env)).toEqual([expected(designation, ROOT_MODEL), expected(designation, ROOT_MODEL), expected(designation, SWITCHED_MODEL)]);
  });
});

describe('a designated classifier model that the gateway does not list', () => {
  it('asks the person with the sentence that names the configured classifier, without a classifier request', async () => {
    const env = await setup('named');
    env.gateway.unlisted.add(NAMED);
    env.gateway.script.push(writeStep(env, 'call_w_1', 'out.txt'));
    const run = await env.enqueue('Write out.txt');
    await drive(env, run.id);
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    const [classified] = env.ofType(run.id, 'tool.permission.classified');
    expect(classified).toMatchObject({ outcome: 'ask', failure: `the auto mode classifier model "${NAMED}" is not known to the gateway` });
    expect(classifierModels(env)).toEqual([]);
    expect(env.ofType(run.id, 'tool.permission.requested')).toHaveLength(1);
  });

  it('asks the person with the sentence that names the model of the root run when no classifier is configured', async () => {
    const env = await setup('absent');
    const gone = 'gone-model';
    const root = await startedRoot(env, gone);
    const child = await childOf(env, root.run.id, 'call_child', CHILD_MODEL);
    await release(env, root.claim);
    env.gateway.script.push(writeStep(env, 'call_w_1', 'child.txt'));
    await drive(env, child.id);
    expect(env.run(child.id).status).toBe('WAITING_HUMAN');
    const [classified] = env.ofType(child.id, 'tool.permission.classified');
    expect(classified).toMatchObject({ outcome: 'ask', failure: `the auto mode classifier model "${gone}" is not known to the gateway` });
    expect(classifierModels(env)).toEqual([]);
  });
});
