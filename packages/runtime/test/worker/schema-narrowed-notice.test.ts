import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SchemaNarrowing, StreamEvent } from '@momonga/protocol';
import { makeEnv } from './harness.ts';
import { MODEL_ID, callsStep, textStep } from './scripts.ts';
import { PRIMARY_TARGET } from './fake-gateway.ts';
import type { ScriptStep } from './fake-gateway.ts';

const answeredWith = (step: ScriptStep, target: string, schemaNarrowings: SchemaNarrowing[], routing: Record<string, unknown> = {}): ScriptStep => ({
  ...step,
  events: step.events.map(
    (event): StreamEvent =>
      event.type === 'response.completed'
        ? { ...event, response: { ...event.response, momonga: { model: MODEL_ID, usageSource: 'reported', target, attempts: 1, ...routing, schemaNarrowings } as never } }
        : event,
  ),
});

const SECONDARY_TARGET = 'secondary';

const FALLBACK_FROM_PRIMARY = {
  attempts: 2,
  fallbackFrom: [PRIMARY_TARGET],
  fallbackCauses: [{ target: PRIMARY_TARGET, code: 'provider_unavailable', message: 'the upstream is unreachable' }],
};

const OPTIONS = { tool: 'ConfigureWidget', path: '/properties/options' };
const LABELS = { tool: 'ConfigureWidget', path: '/properties/labels' };

const readStep = (file: string, callId: string): ScriptStep => callsStep([{ callId, name: 'Read', args: { file_path: file } }]);

const narrowedNotices = (env: Awaited<ReturnType<typeof makeEnv>>, runId: string) =>
  env.ofType(runId, 'notice').filter((event) => event.code === 'schema_narrowed');

const seededFile = (project: string): string => {
  const file = path.join(project, 'notes.txt');
  fs.writeFileSync(file, 'hello\n');
  return file;
};

describe('a tool parameter the dialect narrowed', () => {
  it('tells the person once, naming the tool and the parameter path, when two steps carry the same narrowing', async () => {
    const env = await makeEnv();
    const file = seededFile(env.project);
    env.gateway.script.push(answeredWith(readStep(file, 'call_n_1'), PRIMARY_TARGET, [OPTIONS]), answeredWith(textStep('Done.'), PRIMARY_TARGET, [OPTIONS]));
    const run = await env.enqueue('Work');

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'model.responded')).toHaveLength(2);
    const notices = narrowedNotices(env, run.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual(expect.objectContaining({ type: 'notice', level: 'warning', code: 'schema_narrowed' }));
    expect(notices[0]?.message).toContain('ConfigureWidget');
    expect(notices[0]?.message).toContain('/properties/options');
    expect(notices[0]?.message).not.toContain('\n');
  });

  it('tells the person again for another path of the same tool', async () => {
    const env = await makeEnv();
    const file = seededFile(env.project);
    env.gateway.script.push(answeredWith(readStep(file, 'call_n_2'), PRIMARY_TARGET, [OPTIONS]), answeredWith(textStep('Done.'), PRIMARY_TARGET, [OPTIONS, LABELS]));
    const run = await env.enqueue('Work');

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'model.responded')).toHaveLength(2);
    const notices = narrowedNotices(env, run.id);
    expect(notices).toHaveLength(2);
    expect(notices[0]?.message).toContain('/properties/options');
    expect(notices[1]?.message).toContain('/properties/labels');
  });

  it('tells the person again when another target answers with the same tool and path', async () => {
    const env = await makeEnv();
    env.gateway.chainsByModel[MODEL_ID] = [PRIMARY_TARGET, SECONDARY_TARGET];
    const file = seededFile(env.project);
    env.gateway.script.push(answeredWith(readStep(file, 'call_n_3'), PRIMARY_TARGET, [OPTIONS]), answeredWith(textStep('Done.'), SECONDARY_TARGET, [OPTIONS], FALLBACK_FROM_PRIMARY));
    const run = await env.enqueue('Work');

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'model.responded')).toHaveLength(2);
    expect(narrowedNotices(env, run.id)).toHaveLength(2);
  });

  it('tells the person again in a new run', async () => {
    const env = await makeEnv();
    env.gateway.script.push(answeredWith(textStep('First.'), PRIMARY_TARGET, [OPTIONS]));
    const first = await env.enqueue('Work');
    await env.runOnce(env.worker());

    env.gateway.script.push(answeredWith(textStep('Second.'), PRIMARY_TARGET, [OPTIONS]));
    const second = await env.enqueue('More work');
    await env.runOnce(env.worker());

    expect(env.ofType(first.id, 'model.responded')).toHaveLength(1);
    expect(env.ofType(second.id, 'model.responded')).toHaveLength(1);
    expect(narrowedNotices(env, first.id)).toHaveLength(1);
    expect(narrowedNotices(env, second.id)).toHaveLength(1);
  });

  it('says nothing when the response reports no narrowing', async () => {
    const env = await makeEnv();
    env.gateway.script.push(answeredWith(textStep('Done.'), PRIMARY_TARGET, []));
    const run = await env.enqueue('Work');

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'model.responded')).toHaveLength(1);
    expect(narrowedNotices(env, run.id)).toEqual([]);
  });
});
