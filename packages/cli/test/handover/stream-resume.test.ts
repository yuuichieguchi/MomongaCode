import { momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import type { PublicRunEvent } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import type { RunEventFrame, RuntimeClient } from '../../src/client/runtime-client.ts';
import type { MoveSurface } from '../../src/handover/mover.ts';
import { HANDOVER_FORMAT } from '../../src/handover/record.ts';
import type { CliPorts } from '../../src/ports.ts';
import { watchRun } from '../../src/run/headless.ts';
import type { OutputFormat } from '../../src/run/headless.ts';
import { virtualClock } from '../fake-supervisor.ts';
import { runView } from '../fake-backend.ts';

const frame = (seq: number, event: Record<string, unknown>): RunEventFrame => ({ id: seq, event: String(event['type']), data: { runId: 'run-1', sessionId: 'session-1', step: 1, createdAt: 1, id: seq, seq, ...event } as PublicRunEvent });

const delta = (seq: number, itemId: string, text: string): RunEventFrame => frame(seq, { type: 'agent.message.delta', attempt: 0, itemId, text });

const FRAMES = [frame(1, { type: 'user.message', text: 'go' }), delta(2, 'm1', 'one\n'), delta(3, 'm1', 'two\n'), delta(4, 'm1', 'three\n'), delta(5, 'm2', 'four\n')];

const setup = (context: Parameters<typeof withTempDir>[0], frames: readonly RunEventFrame[], gate?: Promise<void>) => {
  const paths = momongaPaths(withTempDir(context, { asHome: true }), process.platform, process.env);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const client = {
    cancel: async () => ({ status: 202, run: runView({ status: 'CANCELLED' }) }),
    streamEvents: async function* () {
      for (const each of frames) yield each;
      if (gate !== undefined) await gate;
    },
    getRun: async () => runView({ status: 'COMPLETED', sessionId: 'session-1' }),
    childRuns: async () => [],
  } as unknown as RuntimeClient;
  const ports = { version: '1.2.3', clock: virtualClock(), random: () => 0.5, stdout: { write: (text: string) => void stdout.push(text) }, stderr: { write: (text: string) => void stderr.push(text) } } as unknown as CliPorts;
  return { paths, client, ports, stdout, stderr };
};

const watch = (s: ReturnType<typeof setup>, format: OutputFormat, after: number | undefined) =>
  watchRun(s.ports, s.paths, { client: s.client, runId: 'run-1', format, verbose: false, interrupt: new AbortController().signal, ...(after === undefined ? {} : { after }) });

describe('a stream client continues after the last event it wrote (16.7, red test 19)', () => {
  it('writes no line twice in the text format', async (context) => {
    const s = setup(context, FRAMES);
    expect(await watch(s, 'text', 3)).toBe(0);
    expect(s.stdout.join('')).toBe('three\nfour\n');
  });

  it('writes the same text as a client that never moved', async (context) => {
    const whole = setup(context, FRAMES);
    await watch(whole, 'text', undefined);
    const moved = setup(context, FRAMES);
    await watch(moved, 'text', 3);
    expect(`one\ntwo\n${moved.stdout.join('')}`).toBe(whole.stdout.join(''));
  });

  it('builds the json result from the events, not from the memory of the old process', async (context) => {
    const whole = setup(context, FRAMES);
    await watch(whole, 'json', undefined);
    const moved = setup(context, FRAMES);
    await watch(moved, 'json', 4);
    expect(moved.stdout).toEqual(whole.stdout);
    expect(JSON.parse(moved.stdout.join('')) as { result: string }).toMatchObject({ result: 'four\n' });
  });
});

describe('the quiet point and the record of a stream client (16.5, 16.7, O4)', () => {
  it('does not move while an approval is open, moves after it, and records the run, the format and the last event written', async (context) => {
    const gate = Promise.withResolvers<void>();
    const s = setup(
      context,
      [
        ...FRAMES.slice(0, 2),
        frame(3, { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash ls', rawInput: {} }),
        frame(4, { type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'commands require approval', options: [] }),
        frame(5, { type: 'tool.permission.resolved', approvalId: 'ap1', callId: 'c1', optionId: 'o1', decision: 'allow' }),
      ],
      gate.promise,
    );
    const surfaces: MoveSurface[] = [];
    const quietAtCheck: boolean[] = [];
    const mover = {
      attach: (surface: MoveSurface) => {
        surfaces.push(surface);
        return () => undefined;
      },
      check: async () => {
        const surface = surfaces[0];
        if (surface !== undefined) quietAtCheck.push(surface.quiet());
      },
    };
    const watching = watchRun(s.ports, s.paths, { client: s.client, runId: 'run-1', format: 'stream-json', verbose: true, interrupt: new AbortController().signal, move: { mover, kind: 'headless', recordFile: (session) => `/run/handover/${session}.json` } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(quietAtCheck).toEqual([true, true, true, false, true]);
    const surface = surfaces[0];
    expect(surface?.recordFile()).toBe('/run/handover/session-1.json');
    expect(surface?.terminal()).toBeUndefined();
    expect(surface?.snapshot('1.2.4')).toEqual({ format: HANDOVER_FORMAT, fromVersion: '1.2.3', toVersion: '1.2.4', session: 'session-1', lastSeq: { 'run-1': 5 }, kind: 'headless', runId: 'run-1', output: 'stream-json', verbose: true });
    surface?.say('Restarting into momonga v1.2.4. Your session and unsent input are kept.');
    expect(s.stderr.at(-1)).toBe('momonga: Restarting into momonga v1.2.4. Your session and unsent input are kept.\n');
    gate.resolve();
    expect(await watching).toBe(0);
  });
});
