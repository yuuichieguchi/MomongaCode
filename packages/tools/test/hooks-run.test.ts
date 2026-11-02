import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import type { HookExecution, HooksSettings } from '@momonga/protocol';
import { createUnsandboxed } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { createToolHooks, runStop, runUserPromptSubmit, runSessionStart } from '@momonga/tools';
import type { HookRunContext } from '@momonga/tools';

let dir = '';

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-hooks-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const policy = (): SandboxPolicy => ({
  writableRoots: [dir],
  writeDenied: [],
  writeDeniedLiterals: [],
  readDenied: [],
  network: 'deny',
  fileRules: EMPTY_FILE_RULES,
  protectedSet: EMPTY_PROTECTED_SET,
});

const settings = (event: keyof HooksSettings, command: string, matcher?: string): HooksSettings => ({
  [event]: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command }] }],
});

const contextFor = (hooks: HooksSettings, overrides: Partial<HookRunContext> = {}) => {
  const executions: HookExecution[] = [];
  const context: HookRunContext = {
    hooks,
    sandbox: createUnsandboxed({ killGraceMs: 200 }),
    sandboxPolicy: policy(),
    env: { PATH: '/usr/bin:/bin' },
    cwd: dir,
    projectDir: dir,
    session: { id: 's1', permissionMode: 'default' },
    clock: { now: () => Date.now() },
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 60_000,
    report: (execution) => executions.push(execution),
    ...overrides,
  };
  return { context, executions };
};

const call = { callId: 'c1', toolName: 'Bash', input: { command: 'ls' } };

describe('PreToolUse hook processes', () => {
  it('delivers the Claude Code input shape on stdin and the project directory in the environment', async () => {
    const out = path.join(dir, 'stdin.json');
    const { context } = contextFor(settings('PreToolUse', `cat > ${out}; echo "$MOMONGA_PROJECT_DIR" > ${out}.env`, 'Bash'));
    await createToolHooks(context).preToolUse(call);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual({
      session_id: 's1',
      cwd: dir,
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'c1',
    });
    expect(fs.readFileSync(`${out}.env`, 'utf8').trim()).toBe(dir);
  });

  it('runs only with the environment it was given', async () => {
    const out = path.join(dir, 'env.txt');
    const { context } = contextFor(settings('PreToolUse', `printf %s "\${SECRET_API_KEY-unset}" > ${out}`), { env: { PATH: '/usr/bin:/bin' } });
    await createToolHooks(context).preToolUse(call);
    expect(fs.readFileSync(out, 'utf8')).toBe('unset');
  });

  it('treats exit 2 as a deny carrying stderr and records a blocked execution', async () => {
    const { context, executions } = contextFor(settings('PreToolUse', 'echo "not allowed" >&2; exit 2'));
    expect(await createToolHooks(context).preToolUse(call)).toEqual({ decision: 'deny', reason: 'not allowed' });
    expect(executions).toMatchObject([{ hookEvent: 'PreToolUse', outcome: 'blocked', exitCode: 2, decision: 'deny', message: 'not allowed', callId: 'c1' }]);
  });

  it('does not let a JSON allow override an exit 2 block', async () => {
    const json = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
    const { context } = contextFor(settings('PreToolUse', `echo '${json}'; echo nope >&2; exit 2`));
    expect(await createToolHooks(context).preToolUse(call)).toMatchObject({ decision: 'deny' });
  });

  it('reads a JSON decision from stdout', async () => {
    const json = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'check' } });
    const { context, executions } = contextFor(settings('PreToolUse', `echo '${json}'`));
    expect(await createToolHooks(context).preToolUse(call)).toEqual({ decision: 'ask', reason: 'check' });
    expect(executions[0]).toMatchObject({ outcome: 'success', exitCode: 0, decision: 'ask' });
  });

  it('applies deny over ask over allow across hooks', async () => {
    const decide = (decision: string) => JSON.stringify({ hookSpecificOutput: { permissionDecision: decision } });
    const hooks: HooksSettings = {
      PreToolUse: [{ hooks: [{ type: 'command', command: `echo '${decide('allow')}'` }, { type: 'command', command: `echo '${decide('deny')}'` }, { type: 'command', command: `echo '${decide('ask')}'` }] }],
    };
    const { context, executions } = contextFor(hooks);
    expect(await createToolHooks(context).preToolUse(call)).toMatchObject({ decision: 'deny' });
    expect(executions).toHaveLength(3);
  });

  it('keeps a non-blocking failure visible and does not decide', async () => {
    const { context, executions } = contextFor(settings('PreToolUse', 'echo "boom" >&2; exit 1'));
    expect(await createToolHooks(context).preToolUse(call)).toBeUndefined();
    expect(executions).toMatchObject([{ outcome: 'error', exitCode: 1, message: 'boom' }]);
  });

  it('reports invalid and unsupported JSON as an error without deciding', async () => {
    for (const body of ['{"hookSpecificOutput":{"permissionDecision":"defer"}}', '{"hookSpecificOutput":{"updatedInput":{}}}', '{"continue":false}', '{not json']) {
      const { context, executions } = contextFor(settings('PreToolUse', `printf '%s' '${body}'`));
      expect(await createToolHooks(context).preToolUse(call)).toBeUndefined();
      expect(executions[0]).toMatchObject({ outcome: 'error', exitCode: 0 });
    }
  });

  it('reports a timeout without deciding and kills the process group', async () => {
    const pidFile = path.join(dir, 'pid');
    const { context, executions } = contextFor(settings('PreToolUse', `echo $$ > ${pidFile}; sleep 30`), { deadlineAt: Date.now() + 300 });
    expect(await createToolHooks(context).preToolUse(call)).toBeUndefined();
    expect(executions[0]).toMatchObject({ outcome: 'timed_out' });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('reports cancellation without spawning when the signal is already aborted', async () => {
    const marker = path.join(dir, 'ran');
    const controller = new AbortController();
    controller.abort();
    const { context, executions } = contextFor(settings('PreToolUse', `touch ${marker}`), { signal: controller.signal });
    expect(await createToolHooks(context).preToolUse(call)).toBeUndefined();
    expect(executions[0]).toMatchObject({ outcome: 'cancelled' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('cancels a running hook when the signal aborts', async () => {
    const controller = new AbortController();
    const { context, executions } = contextFor(settings('PreToolUse', 'sleep 30'), { signal: controller.signal });
    const pending = createToolHooks(context).preToolUse(call);
    controller.abort();
    await pending;
    expect(executions[0]).toMatchObject({ outcome: 'cancelled' });
  });

  it('honours the matcher', async () => {
    const marker = path.join(dir, 'ran');
    const { context, executions } = contextFor(settings('PreToolUse', `touch ${marker}`, 'Write|Edit'));
    const hooks = createToolHooks(context);
    expect(hooks.matchesPreToolUse('Bash')).toBe(false);
    expect(hooks.matchesPreToolUse('Edit')).toBe(true);
    await hooks.preToolUse(call);
    expect(executions).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('runs identical commands once', async () => {
    const hooks: HooksSettings = { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }, { matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }] };
    const { context, executions } = contextFor(hooks);
    await createToolHooks(context).preToolUse(call);
    expect(executions).toHaveLength(1);
  });
});

describe('PostToolUse hook processes', () => {
  it('returns stderr of an exit 2 hook, a block reason and additional context as feedback', async () => {
    const json = JSON.stringify({ decision: 'block', reason: 'tests fail', hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'see log' } });
    const { context } = contextFor({
      PostToolUse: [{ hooks: [{ type: 'command', command: `echo '${json}'` }, { type: 'command', command: 'echo from-stderr >&2; exit 2' }] }],
    });
    const feedback = await createToolHooks(context).postToolUse({ ...call, output: 'ok' });
    expect(feedback).toBe('tests fail\nsee log\nfrom-stderr');
  });

  it('returns nothing when no hook has feedback', async () => {
    const { context } = contextFor(settings('PostToolUse', 'true'));
    expect(await createToolHooks(context).postToolUse({ ...call, output: 'ok' })).toBeUndefined();
  });
});

describe('prompt, start and stop hooks', () => {
  it('blocks a prompt on exit 2 and on a block decision', async () => {
    const exit2 = contextFor(settings('UserPromptSubmit', 'echo "no secrets" >&2; exit 2'));
    expect(await runUserPromptSubmit(exit2.context, 'p')).toEqual({ blocked: 'no secrets', context: [] });
    const json = JSON.stringify({ decision: 'block', reason: 'policy' });
    const decided = contextFor(settings('UserPromptSubmit', `echo '${json}'`));
    expect(await runUserPromptSubmit(decided.context, 'p')).toEqual({ blocked: 'policy', context: [] });
  });

  it('adds plain stdout and additionalContext of a prompt hook as context', async () => {
    const { context } = contextFor(settings('UserPromptSubmit', 'echo "today is monday"'));
    expect(await runUserPromptSubmit(context, 'p')).toEqual({ blocked: undefined, context: ['today is monday'] });
  });

  it('passes the prompt to the hook', async () => {
    const out = path.join(dir, 'prompt.json');
    const { context } = contextFor(settings('UserPromptSubmit', `cat > ${out}`));
    await runUserPromptSubmit(context, 'hello');
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toMatchObject({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
  });

  it('collects session start context and passes the source', async () => {
    const { context, executions } = contextFor(settings('SessionStart', 'echo ctx', 'startup'));
    expect(await runSessionStart(context, 'startup')).toEqual(['ctx']);
    expect(executions).toHaveLength(1);
    const other = contextFor(settings('SessionStart', 'echo ctx', 'resume'));
    expect(await runSessionStart(other.context, 'startup')).toEqual([]);
  });

  it('keeps the agent going on a Stop block and reports stop_hook_active', async () => {
    const out = path.join(dir, 'stop.json');
    const { context } = contextFor(settings('Stop', `cat > ${out}; echo "run the tests" >&2; exit 2`));
    expect(await runStop(context, true)).toEqual({ continueWith: 'run the tests' });
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toMatchObject({ hook_event_name: 'Stop', stop_hook_active: true });
  });

  it('lets the agent stop when no Stop hook objects', async () => {
    const { context } = contextFor(settings('Stop', 'true'));
    expect(await runStop(context, false)).toEqual({ continueWith: undefined });
  });

  it('treats exit 2 of a SessionStart hook as a visible non-blocking error', async () => {
    const { context, executions } = contextFor(settings('SessionStart', 'echo bad >&2; exit 2'));
    expect(await runSessionStart(context, 'startup')).toEqual([]);
    expect(executions[0]).toMatchObject({ outcome: 'error', exitCode: 2, message: 'bad' });
  });
});
