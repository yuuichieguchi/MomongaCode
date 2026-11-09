import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { STOP_HOOK_FEEDBACK_PREFIX } from '@momonga/protocol';
import type { HooksSettings } from '@momonga/protocol';
import { createUnsandboxed } from '@momonga/sandbox';
import { makeEnv } from './harness.ts';
import { assistantMessage, callsStep, textStep } from './scripts.ts';
import { fixedSandboxBindings } from '@momonga/runtime';

const hooks = (event: keyof HooksSettings, command: string, matcher?: string): HooksSettings => ({
  [event]: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command }] }],
});

const workerWithProcesses = (env: Awaited<ReturnType<typeof makeEnv>>) => env.worker('worker-1', { tools: { sandboxes: fixedSandboxBindings(createUnsandboxed({ killGraceMs: 200 })) } });

describe('worker hooks', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
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

  it('does not run the Stop hook again for a response whose Stop hook was journaled before a crash', async () => {
    const env = await makeEnv();
    const counter = path.join(env.project, 'stop-runs.txt');
    env.settings.hooksValue = hooks('Stop', `echo run >> ${counter}`);
    const run = env.enqueue('hello');
    await env.seed(
      run.id,
      [
        { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [assistantMessage('msg_1', 'done')], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } },
        { type: 'hook.completed', hookEvent: 'Stop', command: `echo run >> ${counter}`, outcome: 'success', exitCode: 0, durationMs: 3 },
      ],
      'crash',
    );

    await env.runOnce(workerWithProcesses(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.existsSync(counter)).toBe(false);
    expect(env.ofType(run.id, 'hook.completed')).toHaveLength(1);
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

  it('turns a timed out PreToolUse hook into an approval request, so a deny policy never fails open', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const target = path.join(env.project, 'out.txt');
    env.settings.hooksValue = { PreToolUse: [{ hooks: [{ type: 'command', command: 'sleep 30', timeout: 1 }] }] };
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }]), textStep('Written.'));
    const run = env.enqueue('write it');
    await env.runOnce(workerWithProcesses(env));
    expect(env.ofType(run.id, 'hook.completed')).toMatchObject([{ outcome: 'timed_out' }]);
    expect(fs.existsSync(target)).toBe(false);
    await env.resolveApproval(run.id, 'allow_once');
    await env.runOnce(workerWithProcesses(env));
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });

  const haltJson = JSON.stringify({ continue: false, stopReason: 'maintenance window' });

  it('fails the run with hook_stopped when a PreToolUse hook says continue false, and the tool never runs', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const target = path.join(env.project, 'out.txt');
    env.settings.hooksValue = hooks('PreToolUse', `echo '${haltJson}'`, 'Write');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }]));
    const run = env.enqueue('write it');
    await env.runOnce(workerWithProcesses(env));
    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'hook_stopped', message: 'maintenance window' } });
    expect(fs.existsSync(target)).toBe(false);
    expect(env.ofType(run.id, 'hook.completed')).toMatchObject([{ halted: true, stopReason: 'maintenance window' }]);
    expect(env.ofType(run.id, 'tool.completed')).toHaveLength(1);
  });

  it('applies a PreToolUse updatedInput to what the tool receives', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const original = path.join(env.project, 'original.txt');
    const rewritten = path.join(env.project, 'rewritten.txt');
    const json = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { file_path: rewritten, content: 'y' } } });
    env.settings.hooksValue = hooks('PreToolUse', `echo '${json}'`, 'Write');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: original, content: 'x' } }]), textStep('done'));
    const run = env.enqueue('write it');
    await env.runOnce(workerWithProcesses(env));
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.readFileSync(rewritten, 'utf8')).toBe('y');
  });

  it('fails the run with hook_stopped when a SessionStart hook says continue false, before any model call', async () => {
    const env = await makeEnv();
    env.settings.hooksValue = hooks('SessionStart', `echo '${haltJson}'`, 'startup');
    const run = env.enqueue('hello');
    await env.runOnce(workerWithProcesses(env));
    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'hook_stopped' } });
    expect(env.gateway.streams).toHaveLength(0);
  });

  it('completes the run with a notice when a Stop hook says continue false', async () => {
    const env = await makeEnv();
    env.settings.hooksValue = hooks('Stop', `echo '${haltJson}'`);
    env.gateway.script.push(textStep('done'));
    const run = env.enqueue('hello');
    await env.runOnce(workerWithProcesses(env));
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'notice').some((notice) => notice.message.includes('maintenance window'))).toBe(true);
  });

  it('runs a PreToolUse hook once for a write that needs approval', async () => {
    const env = await makeEnv();
    const target = path.join(env.project, 'out.txt');
    const counter = path.join(env.project, 'hook-runs.txt');
    env.settings.hooksValue = hooks('PreToolUse', `echo run >> ${counter}`, 'Write');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }]), textStep('written'));
    const run = env.enqueue('write it');
    await env.runOnce(workerWithProcesses(env));
    await env.resolveApproval(run.id, 'allow_once');
    await env.runOnce(workerWithProcesses(env));
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
    expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
