import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import type { HooksSettings, RunEvent } from '@momonga/protocol';
import { createUnsandboxed } from '@momonga/sandbox';
import { fixedSandboxBindings } from '@momonga/runtime';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type Env = Awaited<ReturnType<typeof makeEnv>>;

const ENVELOPE_KEYS = ['id', 'runId', 'sessionId', 'seq', 'step', 'leaseToken', 'createdAt'];

const payloadOf = (event: RunEvent): Record<string, unknown> => {
  const own = event.type === 'context.compacting' ? ENVELOPE_KEYS.filter((key) => key !== 'step') : ENVELOPE_KEYS;
  return Object.fromEntries(Object.entries(event).filter(([key]) => !own.includes(key)));
};

const hooks = (event: keyof HooksSettings, command: string, matcher?: string): HooksSettings => ({
  [event]: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command }] }],
});

const workerWithProcesses = (env: Env) => env.worker('worker-1', { tools: { sandboxes: fixedSandboxBindings(createUnsandboxed({ killGraceMs: 200 })) } });

const hookEventsOf = (env: Env, runId: string): Record<string, unknown>[] =>
  env
    .events(runId)
    .filter((event) => event.type === 'hook.started' || event.type === 'hook.completed')
    .map((event) => (event.type === 'hook.completed' ? { type: event.type, hookEvent: event.hookEvent, command: event.command, ...(event.callId === undefined ? {} : { callId: event.callId }) } : payloadOf(event)));

const verdict = JSON.stringify({ verdict: 'safe', confidence: 'high', rationale: 'writes a file the user asked for' });

const autoSetup = async (classifier: string | null = 'guard') => {
  const env = await makeEnv({ mode: 'auto' });
  env.settings.classifierModel = classifier ?? undefined;
  if (classifier !== null) env.gateway.capabilitiesByModel[classifier] = capabilitiesFor(env.gateway.capabilitiesValue.contextWindow, { structuredOutput: 'json_schema' });
  const write = callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'x' } }]);
  return { env, write };
};

describe('tool.permission.classifying: the event that backs the wait for the auto-mode classifier (design-screens 6.1.1)', () => {
  it('is written with the call id and the subject digest before the classifier is asked, and tool.permission.classified ends it', async () => {
    const { env, write } = await autoSetup();
    env.gateway.script.push(write, textStep(verdict), textStep('Written.'));
    const run = await env.enqueue('Write out.txt');
    const writtenAtTheCall: number[] = [];
    const stream = env.gateway.stream;
    env.gateway.stream = (body, options) => {
      if (options.role === 'classifier') writtenAtTheCall.push(env.ofType(run.id, 'tool.permission.classifying').length);
      return stream(body, options);
    };

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const [classified] = env.ofType(run.id, 'tool.permission.classified');
    if (classified === undefined) throw new Error('the call was not classified');
    const classifying = env.ofType(run.id, 'tool.permission.classifying');
    expect(classifying.map(payloadOf)).toEqual([{ type: 'tool.permission.classifying', callId: classified.callId, subjectDigest: classified.subjectDigest }]);
    expect(writtenAtTheCall).toEqual([1]);
    expect(classifying[0]?.seq).toBeLessThan(classified.seq);
  });

  it('is not written when no classifier is asked', async () => {
    const { env, write } = await autoSetup(null);
    env.gateway.script.push(write);
    const run = await env.enqueue('Write out.txt');

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'tool.permission.classified')).toHaveLength(1);
    expect(env.ofType(run.id, 'tool.permission.classifying')).toEqual([]);
  });
});

describe('hook.started: the event that backs the wait for a hook (design-screens 6.1.1)', () => {
  it('is written before each lifecycle hook command with the hook event and the command, and hook.completed ends it', async () => {
    const env = await makeEnv();
    env.settings.hooksValue = { ...hooks('UserPromptSubmit', 'echo "prompt-context"'), ...hooks('SessionStart', 'echo "session-context"', 'startup'), ...hooks('Stop', 'true') };
    env.gateway.script.push(textStep('Hi.'));
    const run = await env.enqueue('hello');

    await env.runOnce(workerWithProcesses(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(hookEventsOf(env, run.id)).toEqual([
      { type: 'hook.started', event: 'SessionStart', command: 'echo "session-context"' },
      { type: 'hook.completed', hookEvent: 'SessionStart', command: 'echo "session-context"' },
      { type: 'hook.started', event: 'UserPromptSubmit', command: 'echo "prompt-context"' },
      { type: 'hook.completed', hookEvent: 'UserPromptSubmit', command: 'echo "prompt-context"' },
      { type: 'hook.started', event: 'Stop', command: 'true' },
      { type: 'hook.completed', hookEvent: 'Stop', command: 'true' },
    ]);
  });

  it('is in the journal while the hook command runs', async () => {
    const env = await makeEnv();
    const marker = path.join(env.project, 'hook-ran.txt');
    env.settings.hooksValue = hooks('UserPromptSubmit', `echo ran > ${marker}`);
    env.gateway.script.push(textStep('Hi.'));
    const run = await env.enqueue('hello');
    const startedAtTheModelCall: number[] = [];
    const stream = env.gateway.stream;
    env.gateway.stream = (body, options) => {
      startedAtTheModelCall.push(env.ofType(run.id, 'hook.started').length);
      return stream(body, options);
    };

    await env.runOnce(workerWithProcesses(env));

    const [started] = env.ofType(run.id, 'hook.started');
    const [completed] = env.ofType(run.id, 'hook.completed');
    if (started === undefined || completed === undefined) throw new Error('the hook was not recorded');
    expect(started.seq).toBeLessThan(completed.seq);
    expect(started.createdAt).toBeLessThanOrEqual(completed.createdAt);
    expect(startedAtTheModelCall).toEqual([1]);
  });

  it('carries the call id for the hooks of a tool call', async () => {
    const env = await makeEnv();
    const target = path.join(env.project, 'out.txt');
    env.settings.hooksValue = { ...hooks('PreToolUse', 'echo "writes are frozen" >&2; exit 2', 'Write') };
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }]), textStep('Blocked.'));
    const run = await env.enqueue('write it');

    await env.runOnce(workerWithProcesses(env));

    const [completed] = env.ofType(run.id, 'hook.completed');
    if (completed?.callId === undefined) throw new Error('the PreToolUse hook was not recorded with its call');
    expect(hookEventsOf(env, run.id)).toEqual([
      { type: 'hook.started', event: 'PreToolUse', command: 'echo "writes are frozen" >&2; exit 2', callId: completed.callId },
      { type: 'hook.completed', hookEvent: 'PreToolUse', command: 'echo "writes are frozen" >&2; exit 2', callId: completed.callId },
    ]);
  });

  it('is not written for a run without hooks', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Hi.'));
    const run = await env.enqueue('hello');

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'hook.started')).toEqual([]);
  });
});
