import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HooksSettings } from '@momonga/protocol';
import { createUnsandboxed } from '@momonga/sandbox';
import { STOP_HOOK_FEEDBACK_PREFIX } from '../../src/worker/hook-step.ts';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const hooks = (event: keyof HooksSettings, command: string, matcher?: string): HooksSettings => ({
  [event]: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command }] }],
});

const workerWithProcesses = (env: Awaited<ReturnType<typeof makeEnv>>) => env.worker('worker-1', { tools: { sandbox: createUnsandboxed({ killGraceMs: 200 }) } });

describe('worker hooks', () => {
  it('fails the run with a typed code when a UserPromptSubmit hook blocks the prompt, without calling the model', async () => {
    const env = await makeEnv();
    env.settings.hooksValue = hooks('UserPromptSubmit', 'echo "no secrets in prompts" >&2; exit 2');
    const run = env.enqueue('here is my password');
    await env.runOnce(workerWithProcesses(env));
    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'user_prompt_blocked', message: 'no secrets in prompts' } });
    expect(env.gateway.streams).toHaveLength(0);
    expect(env.ofType(run.id, 'hook.completed')).toMatchObject([{ hookEvent: 'UserPromptSubmit', outcome: 'blocked', exitCode: 2 }]);
  });

  it('adds UserPromptSubmit and SessionStart context to what the model sees, once', async () => {
    const env = await makeEnv();
    env.settings.hooksValue = {
      ...hooks('UserPromptSubmit', 'echo "prompt-context"'),
      ...hooks('SessionStart', 'echo "session-context"', 'startup'),
    };
    env.gateway.script.push(textStep('Hi.'));
    const run = env.enqueue('hello');
    await env.runOnce(workerWithProcesses(env));
    expect(env.run(run.id).status).toBe('COMPLETED');
    const sent = JSON.stringify(env.gateway.streams[0]?.body.input);
    expect(sent).toContain('prompt-context');
    expect(sent).toContain('session-context');
    expect(env.ofType(run.id, 'hook.completed').map((event) => event.hookEvent)).toEqual(['SessionStart', 'UserPromptSubmit']);
  });

  it('keeps the agent running while a Stop hook objects and stops after the continuation cap', async () => {
    const env = await makeEnv();
    env.settings.hooksValue = hooks('Stop', 'echo "keep going" >&2; exit 2');
    for (let attempt = 0; attempt < 9; attempt += 1) env.gateway.script.push(textStep(`answer ${attempt}`));
    const run = env.enqueue('hello');
    await env.runOnce(workerWithProcesses(env));
    expect(env.run(run.id).status).toBe('COMPLETED');
    const feedback = env.ofType(run.id, 'user.message').filter((event) => event.text.startsWith(STOP_HOOK_FEEDBACK_PREFIX));
    expect(feedback).toHaveLength(8);
    expect(env.gateway.streams).toHaveLength(9);
    expect(env.ofType(run.id, 'notice').some((notice) => notice.message.includes('8 times'))).toBe(true);
  });

  it('lets a run complete when the Stop hook does not object', async () => {
    const env = await makeEnv();
    env.settings.hooksValue = hooks('Stop', 'true');
    env.gateway.script.push(textStep('done'));
    const run = env.enqueue('hello');
    await env.runOnce(workerWithProcesses(env));
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'hook.completed')).toMatchObject([{ hookEvent: 'Stop', outcome: 'success' }]);
  });

  it('blocks a tool call with a PreToolUse hook, records the hook execution and a structured denial', async () => {
    const env = await makeEnv();
    const target = path.join(env.project, 'out.txt');
    env.settings.hooksValue = hooks('PreToolUse', 'echo "writes are frozen" >&2; exit 2', 'Write');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }]), textStep('Blocked.'));
    const run = env.enqueue('write it');
    await env.runOnce(workerWithProcesses(env));
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.existsSync(target)).toBe(false);
    expect(env.ofType(run.id, 'hook.completed')).toMatchObject([{ hookEvent: 'PreToolUse', outcome: 'blocked', decision: 'deny' }]);
    expect(env.ofType(run.id, 'tool.completed')).toMatchObject([{ status: 'failed', denial: { source: 'hook', reason: 'writes are frozen' } }]);
  });

  it('records a timed out PreToolUse hook as non-blocking and runs the write', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const target = path.join(env.project, 'out.txt');
    env.settings.hooksValue = { PreToolUse: [{ hooks: [{ type: 'command', command: 'sleep 30', timeout: 1 }] }] };
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }]), textStep('Written.'));
    const run = env.enqueue('write it');
    await env.runOnce(workerWithProcesses(env));
    expect(env.ofType(run.id, 'hook.completed')).toMatchObject([{ outcome: 'timed_out' }]);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });
});
