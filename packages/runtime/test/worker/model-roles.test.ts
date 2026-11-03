import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import { DEADLINE_MS, capabilitiesFor, createdRun, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { assistantMessage, callsStep, textStep } from './scripts.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const WINDOW = 40_000;
const RETRY_GAP_MS = 60_000;
const MAX_CLAIMS = 8;
const CLEAN = 'GOAL:\ng\nSTATE:\ns\nDONE:\nd\nTODO:\nt\nDECISIONS:\nx\nGUARDRAILS:\ny';

const responded = (step: number, text: string): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output: [assistantMessage(`m${step}`, text)], usage: USAGE },
});

const conversation = (): RunEventPayload[] => [
  responded(1, `long ${'x'.repeat(120_000)}`),
  { type: 'user.message', text: 'question two' },
  responded(2, 'answer two'),
  { type: 'user.message', text: 'question three' },
  responded(3, 'answer three'),
  { type: 'user.message', text: 'question four' },
];

const prepared = async (roles: Record<string, string> = {}) => {
  const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
  env.settings.rolesValue = { ...roles };
  const run = env.enqueue('question one');
  env.seed(run.id, conversation(), 'release');
  env.gateway.compactSummaries.push(CLEAN);
  env.gateway.script.push(textStep('Done.'));
  return { env, run };
};

const drive = async (env: Env, runId: string): Promise<void> => {
  for (let claim = 0; claim < MAX_CLAIMS && !['COMPLETED', 'FAILED', 'STOPPED'].includes(env.run(runId).status); claim += 1) {
    await env.runOnce(env.worker());
    env.clock.advance(RETRY_GAP_MS);
  }
};

const changingOutage = (env: Env, change: () => void): void => {
  let outages = 0;
  env.gateway.compactHook = async () => {
    outages += 1;
    if (outages > 1) return;
    change();
    throw new GatewayRequestError({ status: 503, type: 'server_error', code: 'upstream_unavailable', message: 'down' });
  };
};

describe('the compaction role', () => {
  it('guards a role that is ignored: compaction is sent to the compaction alias while the steps keep the run alias', async () => {
    const { env, run } = await prepared({ compaction: 'cheap' });
    await drive(env, run.id);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts.map((compact) => compact.request.model)).toEqual(['cheap']);
    expect(new Set(env.gateway.streams.map((stream) => stream.body.model))).toEqual(new Set(['fm']));
  });

  it('guards a default that moves: with no compaction role the compaction goes to the run alias', async () => {
    const { env, run } = await prepared();
    await drive(env, run.id);
    expect(env.gateway.compacts.map((compact) => compact.request.model)).toEqual(['fm']);
  });

  it('guards a role meant for another call: a reflection role does not move compaction', async () => {
    const { env, run } = await prepared({ reflection: 'cheap', analysis: 'cheap' });
    await drive(env, run.id);
    expect(env.gateway.compacts.map((compact) => compact.request.model)).toEqual(['fm']);
  });

  it('guards a summary cap the role alias cannot hold: no call is made, the deterministic summary is used, and the notice names the role and the capability', async () => {
    const { env, run } = await prepared({ compaction: 'tiny' });
    env.gateway.capabilitiesByAlias['tiny'] = capabilitiesFor(200_000, { maxOutputTokens: 32 });
    await drive(env, run.id);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts.map((compact) => compact.request.model)).toEqual([]);
    expect(env.ofType(run.id, 'context.compacted').map((event) => event.source)).toEqual(['deterministic']);
    const notices = env.ofType(run.id, 'notice').filter((notice) => notice.code === 'compaction_failed');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain('models.roles.compaction');
    expect(notices[0]?.message).toContain('tiny');
    expect(notices[0]?.message).toContain('maxOutputTokens');
  });
});

describe('the pinned roles', () => {
  it('guards drift by pin: run.started records the roles of the settings at run start', async () => {
    const { env, run } = await prepared({ compaction: 'cheap', reflection: 'judge' });
    await drive(env, run.id);
    const starts = env.ofType(run.id, 'run.started');
    expect(starts.length).toBeGreaterThanOrEqual(1);
    for (const start of starts) expect(start.pins['roles']).toEqual({ compaction: 'cheap', reflection: 'judge' });
  });

  it('guards a settings change mid-run: across a recovery the compaction keeps the alias pinned at start', async () => {
    const { env, run } = await prepared({ compaction: 'cheap' });
    changingOutage(env, () => {
      env.settings.rolesValue = { compaction: 'other' };
    });
    await drive(env, run.id);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(env.gateway.compacts.map((compact) => compact.request.model))).toEqual(new Set(['cheap']));
    expect(new Set(env.ofType(run.id, 'run.started').map((event) => JSON.stringify(event.pins['roles'])))).toEqual(new Set([JSON.stringify({ compaction: 'cheap' })]));
  });

  it('guards a late role: a run that started without one keeps the run alias across a recovery after a role is set', async () => {
    const { env, run } = await prepared();
    changingOutage(env, () => {
      env.settings.rolesValue = { compaction: 'cheap' };
    });
    await drive(env, run.id);
    expect(env.gateway.compacts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(env.gateway.compacts.map((compact) => compact.request.model))).toEqual(new Set(['fm']));
  });

  it('guards a run that is not pinned: a run that starts after the change takes the new role', async () => {
    const { env, run } = await prepared({ compaction: 'cheap' });
    await drive(env, run.id);
    env.settings.rolesValue = { compaction: 'other' };
    env.gateway.script.push(textStep('Second.'));
    const second = env.enqueue('Second task');
    await drive(env, second.id);
    expect(env.ofType(second.id, 'run.started')[0]?.pins['roles']).toEqual({ compaction: 'other' });
  });

  const childOf = async (parentPins: Record<string, unknown>) => {
    const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
    env.settings.rolesValue = { compaction: 'cheap' };
    const parent = createdRun(env.store.createRunAndEnqueue(env.session.id, { input: 'Parent', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {}, history: 'fresh' }));
    const claim = env.seed(parent.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: parentPins, mode: 'default' }], 'hold');
    const created = env.store.createChildRun({ parentRunId: parent.id, parentCallId: 'call_child', input: 'Child', pins: {} });
    if (created.kind !== 'created') throw new Error(`child run was not created: ${created.kind}`);
    expect(env.store.releaseLease(claim, { availableAt: env.clock.now() + 3_600_000 }).kind).toBe('ok');
    env.settings.rolesValue = { compaction: 'other' };
    env.gateway.script.push(textStep('Child done.'));
    await env.runOnce(env.worker('worker-child'));
    return env.ofType(created.run.id, 'run.started').map((event) => event.pins['roles']);
  };

  it('guards a child that drifts from its parent: it compacts with the roles its parent pinned, not the settings of the moment', async () => {
    expect(await childOf({ roles: { compaction: 'cheap' } })).toEqual([{ compaction: 'cheap' }]);
  });

  it('guards a child that picks up a role its parent never had: a parent with no roles gives the child none, so it compacts with its own alias', async () => {
    expect(await childOf({ roles: {} })).toEqual([{}]);
  });
});

describe('the capability check of autoMode.classifier', () => {
  const autoSetup = async (classifier: string) => {
    const env = await makeEnv({ mode: 'auto' });
    env.settings.classifierAlias = classifier;
    const target = path.join(env.project, 'out.txt');
    const write = callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }]);
    return { env, target, write };
  };

  const VERDICT = JSON.stringify({ verdict: 'safe', confidence: 'high', rationale: 'writes a file the user asked for' });

  it('guards a classifier alias that is ignored: the verdict is asked of the autoMode.classifier alias', async () => {
    const { env, target, write } = await autoSetup('judge');
    env.gateway.capabilitiesByAlias['judge'] = capabilitiesFor(100_000, { structuredOutput: 'json_schema' });
    env.gateway.script.push(write, textStep(VERDICT), textStep('Written.'));
    const run = env.enqueue('Write out.txt');
    await env.runOnce(env.worker());
    expect(env.gateway.streams[1]?.body.model).toBe('judge');
    expect(env.ofType(run.id, 'tool.permission.classified')).toMatchObject([{ outcome: 'allow', alias: 'judge' }]);
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });

  it('guards a verdict asked of a model that cannot give one in shape: a classifier alias without structured output asks the person and names the setting, the alias and the capability', async () => {
    const { env, target, write } = await autoSetup('judge');
    env.gateway.capabilitiesByAlias['judge'] = capabilitiesFor(100_000, { structuredOutput: 'none' });
    env.gateway.script.push(write);
    const run = env.enqueue('Write out.txt');
    await env.runOnce(env.worker());
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(env.gateway.streams).toHaveLength(1);
    const [classified] = env.ofType(run.id, 'tool.permission.classified');
    expect(classified).toMatchObject({ outcome: 'ask' });
    expect(classified?.failure).toContain('autoMode.classifier');
    expect(classified?.failure).toContain('judge');
    expect(classified?.failure).toContain('structured output');
    expect(fs.existsSync(target)).toBe(false);
  });
});
