import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, reapMarkerDirectory } from '@momonga/foundation';
import type { HookExecution, HooksSettings } from '@momonga/protocol';
import { createUnsandboxed } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { createToolHooks, nodeShellHost, runStop, runUserPromptSubmit, runSessionStart } from '@momonga/tools';
import type { HookRunContext } from '@momonga/tools';
import { REAL_PROCESS_TEST_TIMEOUT_MS, testProcessInspector, pollUntil } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

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
  const markerDir = path.join(dir, 'markers');
  fs.mkdirSync(markerDir, { recursive: true });
  const executions: HookExecution[] = [];
  const context: HookRunContext = {
    inspector: testProcessInspector(),
    hooks,
    sandbox: createUnsandboxed({ killGraceMs: 200 }),
    sandboxPolicy: policy(),
    env: { PATH: '/usr/bin:/bin' },
    shellHost: nodeShellHost(),
    cwd: dir,
    projectDir: dir,
    markerDir,
    runId: 'run-1',
    session: { id: 's1', permissionMode: 'manual' },
    clock: { now: () => Date.now() },
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 60_000,
    started: () => undefined,
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
      permission_mode: 'manual',
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

  it('lets a deny from another hook win over a failed hook, and a failed hook win over an allow', async () => {
    const allow = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } });
    const deny = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } });
    const failing = { type: 'command' as const, command: 'exit 1' };
    const withAllow = contextFor({ PreToolUse: [{ hooks: [failing, { type: 'command', command: `echo '${allow}'` }] }] });
    expect(await createToolHooks(withAllow.context).preToolUse(call)).toMatchObject({ decision: 'ask' });
    const withDeny = contextFor({ PreToolUse: [{ hooks: [failing, { type: 'command', command: `echo '${deny}'` }] }] });
    expect(await createToolHooks(withDeny.context).preToolUse(call)).toMatchObject({ decision: 'deny' });
  });

  it('applies deny over ask over allow across hooks', async () => {
    const decide = (decision: string) => JSON.stringify({ hookSpecificOutput: { permissionDecision: decision } });
    const hooks: HooksSettings = {
      PreToolUse: [{ hooks: [{ type: 'command', command: `echo '${await decide('allow')}'` }, { type: 'command', command: `echo '${await decide('deny')}'` }, { type: 'command', command: `echo '${await decide('ask')}'` }] }],
    };
    const { context, executions } = contextFor(hooks);
    expect(await createToolHooks(context).preToolUse(call)).toMatchObject({ decision: 'deny' });
    expect(executions).toHaveLength(3);
  });

  it('turns a failed hook into an ask carrying the failure, so a deny policy never fails open', async () => {
    const { context, executions } = contextFor(settings('PreToolUse', 'echo "boom" >&2; exit 1'));
    expect(await createToolHooks(context).preToolUse(call)).toMatchObject({ decision: 'ask', reason: expect.stringContaining('boom') });
    expect(executions).toMatchObject([{ outcome: 'error', exitCode: 1, message: 'boom' }]);
  });

  it('finds its shell through the injected host and not through the platform of this machine, and asks when the shell cannot be found', async () => {
    const { context, executions } = contextFor(settings('PreToolUse', 'true'), { shellHost: { ...nodeShellHost(), platform: 'win32', isExecutable: () => false } });
    expect(await createToolHooks(context).preToolUse(call)).toMatchObject({ decision: 'ask', reason: expect.stringContaining('Git for Windows') });
    expect(executions).toMatchObject([{ outcome: 'error', message: expect.stringContaining('the hook could not start') }]);
  });

  it('turns a hook that cannot start into an ask carrying the start failure, and never throws', async () => {
    const refusing: HookRunContext['sandbox'] = {
      kind: 'none',
      spawn: () => {
        throw new Error('spawn EACCES');
      },
    };
    const { context, executions } = contextFor(settings('PreToolUse', 'true'), { sandbox: refusing });
    expect(await createToolHooks(context).preToolUse(call)).toMatchObject({ decision: 'ask', reason: expect.stringContaining('the hook could not start: spawn EACCES') });
    expect(executions).toMatchObject([{ outcome: 'error', message: 'the hook could not start: spawn EACCES' }]);
    expect(executions[0]).not.toHaveProperty('exitCode');
  });

  it('does not honour a JSON allow printed by a hook that exits with a failure code', async () => {
    const json = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
    const { context, executions } = contextFor(settings('PreToolUse', `echo '${json}'; exit 1`));
    expect(await createToolHooks(context).preToolUse(call)).toMatchObject({ decision: 'ask', reason: expect.stringContaining('the hook exited with code 1') });
    expect(executions).toMatchObject([{ outcome: 'error', exitCode: 1, message: 'the hook exited with code 1' }]);
    expect(executions[0]).not.toHaveProperty('decision');
  });

  it('reports invalid and unsupported JSON as an error and asks', async () => {
    for (const body of [
      '{"hookSpecificOutput":{"permissionDecision":"defer"}}',
      '{"hookSpecificOutput":{"updatedToolOutput":"x"}}',
      '{"hookSpecificOutput":{"updatedInput":5}}',
      '{"continue":"no"}',
      '{not json',
    ]) {
      const { context, executions } = contextFor(settings('PreToolUse', `printf '%s' '${body}'`));
      expect(await createToolHooks(context).preToolUse(call)).toMatchObject({ decision: 'ask' });
      expect(executions[0]).toMatchObject({ outcome: 'error', exitCode: 0 });
    }
  });

  it('reports a timeout as an ask and kills the process group', async () => {
    const pidFile = path.join(dir, 'pid');
    const { context, executions } = contextFor(settings('PreToolUse', `echo $$ > ${pidFile}; sleep 30`), { deadlineAt: Date.now() + 300 });
    expect(await createToolHooks(context).preToolUse(call)).toMatchObject({ decision: 'ask' });
    expect(executions[0]).toMatchObject({ outcome: 'timed_out' });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await expect((async () => process.kill(pid, 0))()).rejects.toThrow();
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

describe('updated input, halting and process markers', () => {
  it('returns an updated input with the decision', async () => {
    const json = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'ls -la' } } });
    const { context, executions } = contextFor(settings('PreToolUse', `echo '${json}'`));
    expect(await createToolHooks(context).preToolUse(call)).toEqual({ decision: 'allow', updatedInput: { command: 'ls -la' } });
    expect(executions[0]).toMatchObject({ updatedInput: { command: 'ls -la' } });
  });

  it('lets a later hook win when several update the input', async () => {
    const update = (command: string) => JSON.stringify({ hookSpecificOutput: { updatedInput: { command } } });
    const hooks: HooksSettings = { PreToolUse: [{ hooks: [{ type: 'command', command: `echo '${update('first')}'` }, { type: 'command', command: `echo '${update('second')}'` }] }] };
    const { context } = contextFor(hooks);
    expect(await createToolHooks(context).preToolUse(call)).toEqual({ updatedInput: { command: 'second' } });
  });

  it('turns continue false into a halt with the stop reason and marks the execution', async () => {
    const json = JSON.stringify({ continue: false, stopReason: 'maintenance window' });
    const { context, executions } = contextFor(settings('PreToolUse', `echo '${json}'`));
    expect(await createToolHooks(context).preToolUse(call)).toEqual({ halt: { reason: 'maintenance window' } });
    expect(executions[0]).toMatchObject({ outcome: 'success', halted: true, stopReason: 'maintenance window' });
  });

  it('halts the prompt, the session start and the stop hooks on continue false', async () => {
    const json = JSON.stringify({ continue: false, stopReason: 'halt' });
    expect(await runUserPromptSubmit(contextFor(settings('UserPromptSubmit', `echo '${json}'`)).context, 'p')).toEqual({ blocked: 'halt', context: [] });
    expect((await runSessionStart(contextFor(settings('SessionStart', `echo '${json}'`)).context, 'startup')).halt).toEqual({ reason: 'halt' });
    expect(await runStop(contextFor(settings('Stop', `echo '${json}'`)).context, false)).toEqual({ continueWith: undefined, halt: { reason: 'halt' } });
  });

  it('holds a marker file while the hook runs and removes it afterwards', async () => {
    const listing = path.join(dir, 'listing.txt');
    const { context } = contextFor(settings('PreToolUse', `ls ${path.join(dir, 'markers')} > ${listing}`));
    await createToolHooks(context).preToolUse(call);
    expect(fs.readFileSync(listing, 'utf8').trim()).toMatch(/^hook-[0-9a-f]{64}$/);
    expect(fs.readdirSync(path.join(dir, 'markers'))).toEqual([]);
  });

  it('lets the marker reaper kill a hook process whose runtime died', async () => {
    const pidFile = path.join(dir, 'orphan.pid');
    const controller = new AbortController();
    const { context } = contextFor(settings('PreToolUse', `echo $$ > ${pidFile}; exec sleep 30`), { signal: controller.signal });
    const pending = createToolHooks(context).preToolUse(call);
    await pollUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', { description: 'the pid of the hook process', boundMs: REAL_PROCESS_TEST_TIMEOUT_MS });
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    const markerDir = path.join(dir, 'markers');
    await reapMarkerDirectory({ inspector: testProcessInspector(), dir: markerDir, signal: new AbortController().signal, killGraceMs: 200, label: 'tool', onWarning: (message) => { throw new Error(message); } });
    await expect((async () => process.kill(pid, 0))()).rejects.toThrow();
    controller.abort();
    await pending;
  });
});

describe('PostToolUse hook processes', () => {
  it('returns stderr of an exit 2 hook, a block reason and additional context as feedback', async () => {
    const json = JSON.stringify({ decision: 'block', reason: 'tests fail', hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'see log' } });
    const { context } = contextFor({
      PostToolUse: [{ hooks: [{ type: 'command', command: `echo '${json}'` }, { type: 'command', command: 'echo from-stderr >&2; exit 2' }] }],
    });
    const feedback = await createToolHooks(context).postToolUse({ ...call, output: 'ok' });
    expect(feedback).toEqual({ feedback: 'tests fail\nsee log\nfrom-stderr' });
  });

  it('returns a note for a hook that cannot start, for one that exits with a failure code and for one that times out', async () => {
    const refusing: HookRunContext['sandbox'] = {
      kind: 'none',
      spawn: () => {
        throw new Error('spawn EACCES');
      },
    };
    const unstarted = contextFor(settings('PostToolUse', 'true'), { sandbox: refusing });
    expect(await createToolHooks(unstarted.context).postToolUse({ ...call, output: 'ok' })).toEqual({
      feedback: 'the PostToolUse hook true failed (the hook could not start: spawn EACCES), so what it checks was not checked',
    });
    const failing = contextFor(settings('PostToolUse', 'echo lint-crashed >&2; exit 3'));
    expect(await createToolHooks(failing.context).postToolUse({ ...call, output: 'ok' })).toEqual({
      feedback: 'the PostToolUse hook echo lint-crashed >&2; exit 3 failed (lint-crashed), so what it checks was not checked',
    });
    const slow = contextFor(settings('PostToolUse', 'sleep 30'), { deadlineAt: Date.now() + 300 });
    expect(await createToolHooks(slow.context).postToolUse({ ...call, output: 'ok' })).toMatchObject({ feedback: expect.stringContaining('the PostToolUse hook sleep 30 failed (the hook exceeded its') });
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
    expect((await runSessionStart(context, 'startup')).context).toEqual(['ctx']);
    expect(executions).toHaveLength(1);
    const other = contextFor(settings('SessionStart', 'echo ctx', 'resume'));
    expect((await runSessionStart(other.context, 'startup')).context).toEqual([]);
  });

  it('keeps the agent going on a Stop block and reports stop_hook_active', async () => {
    const out = path.join(dir, 'stop.json');
    const { context } = contextFor(settings('Stop', `cat > ${out}; echo "run the tests" >&2; exit 2`));
    expect(await runStop(context, true)).toEqual({ continueWith: 'run the tests', halt: undefined });
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toMatchObject({ hook_event_name: 'Stop', stop_hook_active: true });
  });

  it('lets the agent stop when no Stop hook objects', async () => {
    const { context } = contextFor(settings('Stop', 'true'));
    expect(await runStop(context, false)).toEqual({ continueWith: undefined, halt: undefined });
  });

  it('treats exit 2 of a SessionStart hook as a visible non-blocking error', async () => {
    const { context, executions } = contextFor(settings('SessionStart', 'echo bad >&2; exit 2'));
    expect((await runSessionStart(context, 'startup')).context).toEqual([]);
    expect(executions[0]).toMatchObject({ outcome: 'error', exitCode: 2, message: 'bad' });
  });
});

describe('the start of each hook command is announced (design-screens 6.1.1, hook.started)', () => {
  it('calls started with the hook event, the command and the call id before the command runs, once per command', async () => {
    const out = path.join(dir, 'ran.txt');
    const first = `test -e ${out} || echo first-saw-nothing >> ${out}.order`;
    const hooks: HooksSettings = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: first }, { type: 'command', command: 'true' }] }] };
    const seen: { start: unknown; reported: number }[] = [];
    const { context, executions } = contextFor(hooks, { started: (start) => void seen.push({ start, reported: executions.length }) });

    await createToolHooks(context).preToolUse(call);

    expect(seen).toEqual([
      { start: { event: 'PreToolUse', command: first, callId: 'c1' }, reported: 0 },
      { start: { event: 'PreToolUse', command: 'true', callId: 'c1' }, reported: 0 },
    ]);
    expect(executions).toHaveLength(2);
  });

  it('announces a lifecycle hook without a call id', async () => {
    const seen: unknown[] = [];
    const { context } = contextFor(settings('Stop', 'true'), { started: (start) => void seen.push(start) });

    await runStop(context, false);

    expect(seen).toEqual([{ event: 'Stop', command: 'true' }]);
  });

  it('announces nothing when no command matches', async () => {
    const seen: unknown[] = [];
    const { context } = contextFor(settings('PreToolUse', 'true', 'Write'), { started: (start) => void seen.push(start) });

    await createToolHooks(context).preToolUse(call);

    expect(seen).toEqual([]);
  });
});
