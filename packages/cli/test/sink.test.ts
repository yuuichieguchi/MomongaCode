import { describe, expect, it } from 'vitest';
import { PRECONDITION_FAILED_CODE } from '@momonga/protocol';
import type { PublicRunEvent } from '@momonga/protocol';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import { createFrameSink, describeEnd, resultOf } from '../src/run/headless.ts';
import type { OutputFormat } from '../src/run/headless.ts';
import type { CliPorts } from '../src/ports.ts';
import { terminalPorts, terminalSink } from '../src/terminal-writer.ts';
import { runView } from './fake-backend.ts';

let sequence = 0;

const frame = (event: Record<string, unknown>): RunEventFrame => {
  sequence += 1;
  return { id: sequence, event: String(event['type']), data: { id: sequence, runId: 'run-1', sessionId: 'session-1', seq: sequence, step: 1, createdAt: 1, ...event } as PublicRunEvent };
};

const delta = (itemId: string, text: string): RunEventFrame => frame({ type: 'agent.message.delta', attempt: 0, itemId, text });

const sinkFor = (format: OutputFormat, verbose = false, throughWriter = false) => {
  const out: string[] = [];
  const err: string[] = [];
  const raw = { stdout: { write: (text: string) => void out.push(text) }, stderr: { write: (text: string) => void err.push(text) } };
  const ports = throughWriter ? terminalPorts(raw as unknown as CliPorts) : raw;
  return { out, err, sink: createFrameSink(ports, format, verbose) };
};

describe('text format', () => {
  it('keeps the assistant text until the run has ended, each item on its own line, and writes none of it while the run goes on', () => {
    const { sink, out } = sinkFor('text');
    for (const event of [delta('a', 'Looking'), delta('a', ' around.'), delta('b', 'Found it.')]) sink.handle(event);
    expect(out).toEqual([]);
    expect(sink.texts()).toBe('Looking around.\nFound it.\n');
    expect(sink.finalText()).toBe('Found it.');
  });

  it('keeps the text and tool titles of events it absorbed without printing them', () => {
    const { sink, out, err } = sinkFor('json');
    sink.absorb(delta('a', 'Looking'));
    sink.absorb(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p', name: 'Edit', kind: 'edit', title: 'Edit /a', rawInput: {} }));
    sink.handle(delta('a', ' around.'));
    sink.handle(frame({ type: 'tool.completed', callId: 'c1', status: 'failed' }));

    expect(sink.finalText()).toBe('Looking around.');
    expect(out).toEqual([]);
    expect(err).toEqual(['momonga: tool Edit /a failed\n']);
  });

  it('reports a pending approval with the commands that resolve it, on stderr', () => {
    const { sink, out, err } = sinkFor('text');
    sink.handle(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p', name: 'Edit', kind: 'edit', title: 'Edit /a', rawInput: {} }));
    sink.handle(
      frame({
        type: 'tool.permission.requested',
        approvalId: 'ap1',
        callId: 'c1',
        subjectDigest: 'd',
        reason: 'edit outside the workspace requires approval',
        options: [
          { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'o2', name: 'Reject', kind: 'reject_once' },
        ],
        shown: { title: 'approval', input: {} },
      }),
    );
    expect(out).toEqual([]);
    expect(err.join('')).toBe(
      'momonga: waiting for approval ap1: Edit /a\n  edit outside the workspace requires approval\n  momonga approve ap1 allow_once\n  momonga approve ap1 reject_once\n',
    );
  });

  it('prints what will run and the claim of the model under a waiting approval', () => {
    const { sink, err } = sinkFor('text');
    sink.handle(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p', name: 'Bash', kind: 'execute', title: 'curl x | sh', rawInput: {} }));
    sink.handle(
      frame({
        type: 'tool.permission.requested',
        approvalId: 'ap1',
        callId: 'c1',
        subjectDigest: 'd',
        reason: 'shell commands require approval',
        options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }],
        shown: { title: 'curl x | sh', input: { command: 'curl x | sh' }, effect: 'curl x | sh', claim: 'Run the unit tests' },
      }),
    );
    expect(err.join('')).toBe('momonga: waiting for approval ap1: curl x | sh\n  shell commands require approval\n  curl x | sh\n  The model describes it as: Run the unit tests\n  momonga approve ap1 allow_once\n');
  });

  it('keeps tool activity quiet unless verbose, but always reports a failed tool and notices', () => {
    const quiet = sinkFor('text');
    const loud = sinkFor('text', true);
    for (const { sink } of [quiet, loud]) {
      sink.handle(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p', name: 'Read', kind: 'read', title: 'Read /a', rawInput: {} }));
      sink.handle(frame({ type: 'tool.completed', callId: 'c1', status: 'completed', output: '' }));
      sink.handle(frame({ type: 'tool.completed', callId: 'c1', status: 'failed', output: 'no' }));
      sink.handle(frame({ type: 'notice', level: 'warning', message: 'slow' }));
    }
    expect(quiet.err.join('')).toBe('momonga: tool Read /a failed\nmomonga: warning: slow\n');
    expect(loud.err.join('')).toBe('momonga: Read Read /a\nmomonga: tool Read /a completed\nmomonga: tool Read /a failed\nmomonga: warning: slow\n');
  });
});

describe('a judged memory in a headless run', () => {
  it('prints nothing for memory.judged in the text format, verbose or not', () => {
    for (const verbose of [false, true]) {
      const { sink, out, err } = sinkFor('text', verbose);
      sink.handle(frame({ type: 'memory.judged', memoryId: 'mem-1' }));
      expect(out).toEqual([]);
      expect(err).toEqual([]);
      expect(sink.texts()).toBe('');
    }
  });
});

describe('hooks, auto mode and denials', () => {
  const call = (callId: string, title: string) => frame({ type: 'tool.call', callId, providerCallId: 'p', name: 'Write', kind: 'edit', title, rawInput: {} });

  it('prints every hook run with its outcome, and the message of a blocking one', () => {
    const { sink, err } = sinkFor('text');
    sink.handle(frame({ type: 'hook.completed', hookEvent: 'PreToolUse', command: 'check.sh', outcome: 'blocked', exitCode: 2, decision: 'deny', message: 'writes are frozen', callId: 'c1', durationMs: 3 }));
    sink.handle(frame({ type: 'hook.completed', hookEvent: 'SessionStart', command: 'warm.sh', outcome: 'success', exitCode: 0, durationMs: 3 }));
    expect(err).toEqual([
      'momonga: hook PreToolUse blocked (exit 2, decision deny): check.sh\n  writes are frozen\n',
      'momonga: hook SessionStart succeeded (exit 0): warm.sh\n',
    ]);
  });

  it('prints the classifier verdict under the title of the call, or the reason it could not decide', () => {
    const { sink, err } = sinkFor('text');
    sink.handle(call('c1', 'Write /a'));
    sink.handle(frame({ type: 'tool.permission.classified', callId: 'c1', model: 'guard', outcome: 'ask', verdict: 'unsafe', confidence: 'high', rationale: 'writes outside the workspace' }));
    sink.handle(frame({ type: 'tool.permission.classified', callId: 'c1', model: 'guard', outcome: 'ask', failure: 'the classifier reply is not JSON' }));
    expect(err).toEqual([
      'momonga: auto mode asks you about Write /a; classifier guard judged Write /a unsafe with high confidence: writes outside the workspace\n',
      'momonga: auto mode could not classify Write /a, so it asks you: the classifier reply is not JSON\n',
    ]);
  });

  it('names the source of a denial instead of calling the tool merely failed', () => {
    const { sink, err } = sinkFor('text');
    sink.handle(call('c1', 'Write /a'));
    sink.handle(frame({ type: 'tool.completed', callId: 'c1', status: 'failed', output: 'Permission denied: no', denial: { source: 'sandbox', reason: '/a is outside the writable roots' } }));
    expect(err).toEqual(['momonga: tool Write /a denied by the sandbox: /a is outside the writable roots\n']);
  });

  it('states that a hook blocked the prompt or stopped the run', () => {
    expect(describeEnd(runView({ status: 'FAILED', error: { code: 'user_prompt_blocked', message: 'no prompts today' } }))).toBe(
      'momonga: run run-1 FAILED (a UserPromptSubmit hook blocked the prompt: no prompts today)',
    );
    expect(describeEnd(runView({ status: 'FAILED', error: { code: 'hook_stopped', message: 'PostToolUse hook halted' } }))).toBe(
      'momonga: run run-1 FAILED (a hook stopped the run: PostToolUse hook halted)',
    );
  });
});

describe('text a person did not write', () => {
  const HOSTILE = 'x\u001b]0;pwn\u0007\u009b2J‮y';
  const ESCAPED = 'x\\u001b]0;pwn\\u0007\\u009b2J\\u202ey';
  const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/u;

  it('stays as recorded in the JSON formats', () => {
    const { sink, out } = sinkFor('stream-json');
    const hostile = delta('a', HOSTILE);
    sink.handle(hostile);
    expect(out).toEqual([`${JSON.stringify(hostile.data)}\n`]);
    expect(sink.finalText()).toBe(HOSTILE);
  });

  it('is escaped in the notes on stderr: a notice, a tool title, an approval title, an approval reason and a hook message', () => {
    const { sink, err } = sinkFor('text', false, true);
    sink.handle(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p', name: 'Bash', kind: 'execute', title: HOSTILE, rawInput: {} }));
    sink.handle(frame({ type: 'tool.completed', callId: 'c1', status: 'failed', output: 'no' }));
    sink.handle(frame({ type: 'notice', level: 'warning', message: HOSTILE }));
    sink.handle(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: HOSTILE, options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }], shown: { title: 'approval', input: {} } }));
    sink.handle(frame({ type: 'hook.completed', hookEvent: 'PreToolUse', command: 'check.sh', outcome: 'blocked', exitCode: 2, decision: 'deny', message: HOSTILE, callId: 'c1', durationMs: 3 }));
    expect(err.join('')).not.toMatch(UNSAFE);
    expect(err.join('').split(ESCAPED).length - 1).toBe(5);
  });

  it('is escaped in the reason a run ended with', () => {
    const written: string[] = [];
    terminalSink(() => ({ write: (text) => void written.push(text) })).write(`${describeEnd(runView({ status: 'FAILED', error: { code: 'model_error', message: HOSTILE } }))}\n`);
    expect(written.join('')).not.toMatch(UNSAFE);
    expect(written.join('')).toContain(ESCAPED);
  });
});

describe('json formats', () => {
  it('prints nothing while the run goes on for json, so stdout holds only the result', () => {
    const { sink, out } = sinkFor('json');
    sink.handle(delta('a', 'text'));
    expect(out).toEqual([]);
    expect(sink.finalText()).toBe('text');
  });

  it('prints every event as one JSON line for stream-json', () => {
    const { sink, out } = sinkFor('stream-json');
    const first = delta('a', 'x');
    sink.handle(first);
    expect(out).toEqual([`${JSON.stringify(first.data)}\n`]);
  });
});

describe('results', () => {
  it('describes a successful run', () => {
    expect(resultOf(runView(), 'done')).toEqual({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      session_id: 'session-1',
      run_id: 'run-1',
      status: 'COMPLETED',
      num_turns: 1,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
  });

  it('keeps the line breaks of a precondition failure, which the product composes line by line, and escapes control characters on every line', () => {
    const message = 'the target "fm" has no probe record\nno record for the fm binary\nremedy: run momonga gateway probe fm\u001b]0;pwn\u0007';
    const shown = describeEnd(runView({ status: 'FAILED', error: { code: PRECONDITION_FAILED_CODE, message } }));
    expect(shown).toBe(
      'momonga: run run-1 FAILED (precondition_failed: the target "fm" has no probe record\nno record for the fm binary\nremedy: run momonga gateway probe fm\\u001b]0;pwn\\u0007)',
    );
  });

  it('describes failures with their error and stop reason', () => {
    const failed = runView({ status: 'FAILED', error: { code: 'provider_unavailable', message: 'run `sudo fm license`' } });
    expect(resultOf(failed, '')).toMatchObject({ subtype: 'error', is_error: true, error: { code: 'provider_unavailable' } });
    expect(describeEnd(failed)).toBe('momonga: run run-1 FAILED (provider_unavailable: run `sudo fm license`)');
    expect(describeEnd(runView({ status: 'STOPPED', stopReason: 'max_steps' }))).toBe('momonga: run run-1 STOPPED (max_steps)');
    expect(describeEnd(runView({ status: 'CANCELLED' }))).toBe('momonga: run run-1 CANCELLED');
  });
});

describe('runs a tool call waits on', () => {
  const childFrame = (event: Record<string, unknown>): RunEventFrame => {
    const made = frame(event);
    return { ...made, data: { ...made.data, runId: 'child-1' } as PublicRunEvent };
  };

  it('says what a call waits for', () => {
    const { sink, err } = sinkFor('text');
    sink.handle(frame({ type: 'tool.waiting', callId: 'c1', awaits: { kind: 'run', runId: 'child-1', sessionId: 's2', agent: 'reviewer' } }));
    sink.handle(frame({ type: 'tool.waiting', callId: 'c2', awaits: { kind: 'job', jobId: 'bash_1' } }));
    expect(err).toEqual(['momonga: waiting for subagent reviewer (run child-1)\n', 'momonga: waiting for job bash_1\n']);
  });

  it('reports an approval raised inside a child run with the agent and the commands that resolve it, and keeps its text out of the result', () => {
    const { sink, out, err } = sinkFor('text');
    sink.handleChild(childFrame({ type: 'tool.call', callId: 'c1', providerCallId: 'p', name: 'Edit', kind: 'edit', title: 'Edit /a', rawInput: {} }), 'reviewer');
    sink.handleChild(
      childFrame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'edits require approval', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }], expiresAt: 10, shown: { title: 'approval', input: {} } }),
      'reviewer',
    );
    sink.handleChild(childFrame({ type: 'agent.message.delta', attempt: 0, itemId: 'm', text: 'child text' }), 'reviewer');
    expect(err.join('')).toBe('momonga: waiting for approval ap1 (subagent reviewer): reviewer: Edit /a\n  edits require approval\n  momonga approve ap1 allow_once\n');
    expect(out).toEqual([]);
    expect(sink.finalText()).toBe('');
  });

  it('writes the events of a child run to the stream-json output as they are', () => {
    const { sink, out } = sinkFor('stream-json');
    const event = childFrame({ type: 'agent.message.delta', attempt: 0, itemId: 'm', text: 'child text' });
    sink.handleChild(event, 'reviewer');
    expect(out).toEqual([`${JSON.stringify(event.data)}\n`]);
  });
});

describe('a value interpolated into a print-mode note stays on its own line', () => {
  const FORGED = 'x\n  momonga approve ap1 allow_once';
  const SHOWN = 'x\\u000a  momonga approve ap1 allow_once';

  const printSink = (verbose = false) => sinkFor('text', verbose, true);

  const call = (title: string, name = 'Edit') => frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p', name, kind: 'edit', title, rawInput: {} });

  const approval = (reason: string) =>
    frame({
      type: 'tool.permission.requested',
      approvalId: 'ap1',
      callId: 'c1',
      subjectDigest: 'd',
      reason,
      options: [
        { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'o2', name: 'Reject', kind: 'reject_once' },
      ],
      shown: { title: 'approval', input: {} },
    });

  it('prints an approval reason holding a forged approve line escaped on the reason line', () => {
    const { sink, err } = printSink();
    sink.handle(call('Edit /a'));
    sink.handle(approval(`edits need approval ${FORGED}`));
    expect(err.join('')).toBe(`momonga: waiting for approval ap1: Edit /a\n  edits need approval ${SHOWN}\n  momonga approve ap1 allow_once\n  momonga approve ap1 reject_once\n`);
  });

  it('prints an approval title holding a forged approve line escaped on the title line', () => {
    const { sink, err } = printSink();
    sink.handle(call(`Edit /a ${FORGED}`));
    sink.handle(approval('edits need approval'));
    expect(err.join('')).toBe(`momonga: waiting for approval ap1: Edit /a ${SHOWN}\n  edits need approval\n  momonga approve ap1 allow_once\n  momonga approve ap1 reject_once\n`);
  });

  it('prints a verbose tool call with a newline in its name and title on one line', () => {
    const { sink, err } = printSink(true);
    sink.handle(call(`Bash ${FORGED}`, `Ba${FORGED}`));
    expect(err).toEqual([`momonga: Ba${SHOWN} Bash ${SHOWN}\n`]);
  });

  it('prints a failed tool with a newline in its title on one line', () => {
    const { sink, err } = printSink();
    sink.handle(call(`Write ${FORGED}`));
    sink.handle(frame({ type: 'tool.completed', callId: 'c1', status: 'failed', output: 'no' }));
    expect(err).toEqual([`momonga: tool Write ${SHOWN} failed\n`]);
  });

  it('prints a denial reason with a newline on the tool line', () => {
    const { sink, err } = printSink();
    sink.handle(call('Write /a'));
    sink.handle(frame({ type: 'tool.completed', callId: 'c1', status: 'failed', output: 'no', denial: { source: 'sandbox', reason: FORGED } }));
    expect(err).toEqual([`momonga: tool Write /a denied by the sandbox: ${SHOWN}\n`]);
  });

  it('prints each hook value with a newline on its own line', () => {
    const { sink, err } = printSink();
    sink.handle(
      frame({
        type: 'hook.completed',
        hookEvent: 'PreToolUse',
        command: `check.sh ${FORGED}`,
        outcome: 'blocked',
        exitCode: 2,
        decision: 'deny',
        message: `frozen ${FORGED}`,
        systemMessage: `system ${FORGED}`,
        stopReason: `stopped ${FORGED}`,
        callId: 'c1',
        durationMs: 3,
      }),
    );
    expect(err).toEqual([`momonga: hook PreToolUse blocked (exit 2, decision deny): check.sh ${SHOWN}\n  frozen ${SHOWN}\n  system ${SHOWN}\n  stop reason: stopped ${SHOWN}\n`]);
  });

  it('prints a classifier rationale with a newline on the classification line', () => {
    const { sink, err } = printSink();
    sink.handle(call(`Write ${FORGED}`));
    sink.handle(frame({ type: 'tool.permission.classified', callId: 'c1', model: 'guard', outcome: 'ask', verdict: 'unsafe', confidence: 'high', rationale: FORGED }));
    expect(err).toEqual([`momonga: auto mode asks you about Write ${SHOWN}; classifier guard judged Write ${SHOWN} unsafe with high confidence: ${SHOWN}\n`]);
  });

  it('prints a classifier failure with a newline on the classification line', () => {
    const { sink, err } = printSink();
    sink.handle(call('Write /a'));
    sink.handle(frame({ type: 'tool.permission.classified', callId: 'c1', model: 'guard', outcome: 'ask', failure: FORGED }));
    expect(err).toEqual([`momonga: auto mode could not classify Write /a, so it asks you: ${SHOWN}\n`]);
  });

  it('prints a waited subagent name with a newline on the waiting line', () => {
    const { sink, err } = printSink();
    sink.handle(frame({ type: 'tool.waiting', callId: 'c1', awaits: { kind: 'run', runId: 'child-1', sessionId: 's2', agent: `reviewer ${FORGED}` } }));
    expect(err).toEqual([`momonga: waiting for subagent reviewer ${SHOWN} (run child-1)\n`]);
  });

  it('prints a waited job id with a newline on the waiting line', () => {
    const { sink, err } = printSink();
    sink.handle(frame({ type: 'tool.waiting', callId: 'c1', awaits: { kind: 'job', jobId: `bash_1 ${FORGED}` } }));
    expect(err).toEqual([`momonga: waiting for job bash_1 ${SHOWN}\n`]);
  });

  it('prints elicitation values with a newline each on their own line', () => {
    const { sink, err } = printSink();
    sink.handle(call(`Fetch ${FORGED}`));
    sink.handle(
      frame({
        type: 'tool.elicitation.requested',
        inputId: 'in1',
        callId: 'c1',
        server: `docs ${FORGED}`,
        requests: [{ key: 'r1', mode: 'url', message: `sign in ${FORGED}`, url: `https://example.com/ ${FORGED}` }],
      }),
    );
    expect(err.join('')).toBe(
      [
        `momonga: waiting for input in1  MCP server docs ${SHOWN} asks for input (Fetch ${SHOWN})`,
        `  [r1] sign in ${SHOWN}`,
        `    URL: https://example.com/ ${SHOWN}`,
        '  accept:  momonga elicit in1 --accept   (opens the URL in your browser)',
        '  decline: momonga elicit in1 --decline',
        '  cancel:  momonga elicit in1 --cancel',
        '',
      ].join('\n'),
    );
  });

  it('prints an MCP server name with a newline on the authorization line', () => {
    const { sink, err } = printSink();
    sink.handle(frame({ type: 'mcp.authorization.required', server: `docs ${FORGED}` }));
    expect(err).toEqual([`momonga: MCP server docs ${SHOWN} needs authorization; run: momonga mcp login docs ${SHOWN}\n`]);
  });

  it('adds the command line remedy to a stored fallback notice from its structured cause', () => {
    const { sink, err } = printSink();
    sink.handle(frame({ type: 'notice', level: 'warning', code: 'fallback_target', message: 'The model call was answered by the fallback model secondary. Did not fall back to metered: billing from plan to metered is not allowed.', fallback: { target: 'secondary', causes: [{ target: 'metered', name: 'metered', code: null, message: 'billing refused', reason: 'billing_change_refused', fromBilling: 'plan', toBilling: 'metered' }] } }));
    expect(err).toEqual(['momonga: warning: The model call was answered by the fallback model secondary. Did not fall back to metered: billing from plan to metered is not allowed. Run momonga models billing allow plan metered.\n']);
  });

  it('prints a notice message with a newline on the notice line', () => {
    const { sink, err } = printSink();
    sink.handle(frame({ type: 'notice', level: 'warning', message: FORGED }));
    expect(err).toEqual([`momonga: warning: ${SHOWN}\n`]);
  });

  it('describes the end of a run with a newline in its error message on one line', () => {
    expect(describeEnd(runView({ status: 'FAILED', error: { code: 'model_error', message: FORGED } }))).toBe(`momonga: run run-1 FAILED (model_error: ${SHOWN})`);
  });
});
