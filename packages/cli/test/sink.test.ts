import { describe, expect, it } from 'vitest';
import type { PublicRunEvent } from '@momonga/protocol';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import { createFrameSink, describeEnd, resultOf } from '../src/run/headless.ts';
import type { OutputFormat } from '../src/run/headless.ts';
import { runView } from './fake-backend.ts';

let sequence = 0;

const frame = (event: Record<string, unknown>): RunEventFrame => {
  sequence += 1;
  return { id: sequence, event: String(event['type']), data: { id: sequence, runId: 'run-1', sessionId: 'session-1', seq: sequence, step: 1, createdAt: 1, ...event } as PublicRunEvent };
};

const delta = (itemId: string, text: string): RunEventFrame => frame({ type: 'agent.message.delta', attempt: 0, itemId, text });

const sinkFor = (format: OutputFormat, verbose = false) => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: createFrameSink({ stdout: { write: (text) => void out.push(text) }, stderr: { write: (text) => void err.push(text) } }, format, verbose) };
};

describe('text format', () => {
  it('streams the assistant text to stdout and separates items with a newline', () => {
    const { sink, out } = sinkFor('text');
    for (const event of [delta('a', 'Looking'), delta('a', ' around.'), delta('b', 'Found it.')]) sink.handle(event);
    expect(out.join('')).toBe('Looking around.\nFound it.');
    expect(sink.finalText()).toBe('Found it.');
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
        options: [
          { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'o2', name: 'Reject', kind: 'reject_once' },
        ],
      }),
    );
    expect(out).toEqual([]);
    expect(err.join('')).toBe('momonga: waiting for approval ap1: Edit /a\n  momonga approve ap1 allow_once\n  momonga approve ap1 reject_once\n');
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
      childFrame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', options: [{ optionId: 'o1', name: 'Allow once', kind: 'allow_once' }], expiresAt: 10 }),
      'reviewer',
    );
    sink.handleChild(childFrame({ type: 'agent.message.delta', attempt: 0, itemId: 'm', text: 'child text' }), 'reviewer');
    expect(err.join('')).toBe('momonga: waiting for approval ap1 (subagent reviewer): reviewer: Edit /a\n  momonga approve ap1 allow_once\n');
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
