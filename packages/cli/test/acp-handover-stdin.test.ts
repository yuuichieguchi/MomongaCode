import { Readable } from 'node:stream';
import type { AnyMessage } from '@agentclientprotocol/sdk';
import { MAX_JSON_DEPTH, ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it, vi } from 'vitest';
import { carriedStream } from '../src/acp/carried-input.ts';
import { serveAcp } from '../src/acp/serve.ts';
import type { HandoverHost } from '../src/handover/host.ts';
import type { MoveSurface } from '../src/handover/mover.ts';
import { HANDOVER_FORMAT, encodeRecord, parseRecord } from '../src/handover/record.ts';
import type { AcpRecord } from '../src/handover/record.ts';
import { acpInputOf } from '../src/node-ports.ts';
import type { AcpInput, CliPorts } from '../src/ports.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type ScriptedInput = AcpInput & { arrive(text: string): void; end(): void };

const scriptedInput = (): ScriptedInput => {
  const chunks: Uint8Array[] = [];
  let ended = false;
  let waiting: ((kind: 'bytes' | 'end') => void) | undefined;
  const wake = (kind: 'bytes' | 'end'): void => {
    const resolve = waiting;
    waiting = undefined;
    resolve?.(kind);
  };
  return {
    take: () => chunks.shift(),
    pause: () => undefined,
    resume: () => undefined,
    arrival: () => {
      if (chunks.length > 0) return Promise.resolve('bytes');
      if (ended) return Promise.resolve('end');
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    arrive: (text) => {
      chunks.push(encoder.encode(text));
      wake('bytes');
    },
    end: () => {
      ended = true;
      wake('end');
    },
  };
};

type RecordedOutput = { stream: WritableStream<Uint8Array>; messages(): AnyMessage[]; until(predicate: (message: AnyMessage) => boolean): Promise<AnyMessage> };

const recordedOutput = (): RecordedOutput => {
  let text = '';
  const listeners = new Set<() => void>();
  const messages = (): AnyMessage[] =>
    text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as AnyMessage);
  return {
    stream: new WritableStream<Uint8Array>({
      write: (chunk) => {
        text += decoder.decode(chunk);
        for (const listener of [...listeners]) listener();
      },
    }),
    messages,
    until: (predicate) =>
      new Promise((resolve) => {
        const check = (): void => {
          const found = messages().find(predicate);
          if (found === undefined) return;
          listeners.delete(check);
          resolve(found);
        };
        listeners.add(check);
        check();
      }),
  };
};

const answers = (id: number | string) => (message: AnyMessage): boolean => !('method' in message) && 'id' in message && message.id === id;

const line = (message: unknown): string => `${JSON.stringify(message)}\n`;

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } };
const SET_MODE = (id: number) => ({ jsonrpc: '2.0', id, method: 'session/set_mode', params: { sessionId: 'no-such-session', modeId: 'plan' } });

type Served = { input: ScriptedInput; output: RecordedOutput; surface(): MoveSurface; interrupt: AbortController; done: Promise<number>; removed: string[] };

const serve = (home: string, started: HandoverHost['started']): Served => {
  const input = scriptedInput();
  const output = recordedOutput();
  const removed: string[] = [];
  let attached: MoveSurface | undefined;
  const handover: HandoverHost = {
    args: ['acp'],
    started,
    mover: {
      attach: (surface) => {
        attached = surface;
        return () => undefined;
      },
      learned: async () => undefined,
      check: async () => undefined,
      refuse: () => undefined,
    },
    removeRecord: (file) => void removed.push(file),
  };
  const ports = { acpStdio: () => ({ input, output: output.stream }), version: '1.0.0', clock: { now: () => 41 }, stderr: { write: () => undefined }, handover } as unknown as CliPorts;
  const interrupt = new AbortController();
  return {
    input,
    output,
    interrupt,
    removed,
    surface: () => {
      if (attached === undefined) throw new Error('no surface is attached to the mover');
      return attached;
    },
    done: serveAcp(ports, momongaPaths(home, process.platform, process.env), interrupt.signal),
  };
};

const acpRecordOf = (surface: MoveSurface): AcpRecord => {
  const record = surface.snapshot('2.0.0');
  if (record.kind !== 'acp') throw new Error(`expected an ACP record, got ${record.kind}`);
  return record;
};

describe('the standard input of an ACP connection across a handover', () => {
  it('carries the bytes no message was made of in the record, and the new process answers the request they begin', async (context) => {
    const home = withTempDir(context, { asHome: true });
    await ensureMomongaDirs(momongaPaths(home, process.platform, process.env));
    const request = line(SET_MODE(2));
    const old = serve(home, undefined);
    old.input.arrive(`${line(INITIALIZE)}${request.slice(0, 20)}`);
    await old.output.until(answers(1));

    const surface = old.surface();
    await vi.waitFor(() => expect(surface.quiet('live')).toBe(true));
    await surface.suspend();
    old.input.arrive(`${request.slice(20)}${line(SET_MODE(3))}`);
    const record = acpRecordOf(surface);

    expect(Buffer.from(record.input, 'base64').toString('utf8')).toBe(`${request}${line(SET_MODE(3))}`);
    expect(old.output.messages().filter((message) => answers(2)(message) || answers(3)(message))).toEqual([]);
    old.interrupt.abort();
    await old.done;

    const encoded = encodeRecord(record, { writer: 4242, reader: 4242, namespace: 'single' });
    if (encoded.kind !== 'fits') throw new Error('the record did not fit');
    const next = serve(home, { file: '/h/run/handover/acp-41.json', parsed: parseRecord(encoded.text), terminal: undefined });
    const second = await next.output.until(answers(2));
    const third = await next.output.until(answers(3));

    expect(second).toMatchObject({ id: 2, error: { code: expect.any(Number) } });
    expect(third).toMatchObject({ id: 3, error: { code: expect.any(Number) } });
    expect(next.output.messages().filter((message) => !('id' in message) || (message.id !== 2 && message.id !== 3))).toEqual([]);
    expect(next.removed).toEqual(['/h/run/handover/acp-41.json']);
    next.input.end();
    expect(await next.done).toBe(0);
  });

  it('delivers no message while the connection is held for the handover, and goes on when the handover did not happen', async (context) => {
    const home = withTempDir(context, { asHome: true });
    await ensureMomongaDirs(momongaPaths(home, process.platform, process.env));
    const served = serve(home, undefined);
    served.input.arrive(line(INITIALIZE));
    await served.output.until(answers(1));

    await served.surface().suspend();
    served.input.arrive(line(SET_MODE(2)));
    expect(Buffer.from(acpRecordOf(served.surface()).input, 'base64').toString('utf8')).toBe(line(SET_MODE(2)));
    served.surface().resume();

    expect(await served.output.until(answers(2))).toMatchObject({ id: 2 });
    expect(acpRecordOf(served.surface()).input).toBe('');
    served.input.end();
    await served.done;
  });

  it('refuses a record of an ACP connection that names no carried input', () => {
    const text = JSON.stringify({ format: HANDOVER_FORMAT, fromVersion: '1.0.0', toVersion: '2.0.0', session: 'acp-41', lastSeq: {}, kind: 'acp', initialize: {}, sessions: [] });

    expect(parseRecord(text)).toEqual({ kind: 'refused', reason: 'the record field input is missing or malformed' });
  });
});

describe('the message stream over the standard input', () => {
  const open = (input: AcpInput, output: WritableStream<Uint8Array>) => carriedStream({ input, output }, new Uint8Array());

  it('is not idle from the moment it hands over a request until the answer of that request is written', async () => {
    const input = scriptedInput();
    const output = recordedOutput();
    const carried = open(input, output.stream);
    const idled: boolean[] = [];
    carried.onIdle(() => idled.push(carried.idle()));
    const reader = carried.stream.readable.getReader();
    const writer = carried.stream.writable.getWriter();
    input.arrive(line(SET_MODE(7)));

    expect(carried.idle()).toBe(true);
    expect((await reader.read()).value).toEqual(SET_MODE(7));
    expect(carried.idle()).toBe(false);
    await writer.write({ jsonrpc: '2.0', id: 7, result: {} });

    expect(carried.idle()).toBe(true);
    expect(idled).toEqual([true]);
    expect(output.messages()).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }]);
  });

  it('makes one message of a line however its bytes arrive, and holds the bytes of a line that has not ended', async () => {
    const input = scriptedInput();
    const carried = open(input, recordedOutput().stream);
    const reader = carried.stream.readable.getReader();
    const cancel = { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'a session' } };
    const text = line(cancel);
    const reading = reader.read();
    input.arrive(text.slice(0, 5));
    input.arrive(text.slice(5, 30));
    await Promise.resolve();

    expect(decoder.decode(carried.pending())).toBe(text.slice(0, 30));
    input.arrive(`${text.slice(30)}{"jsonrpc"`);

    expect((await reading).value).toEqual(cancel);
    expect(decoder.decode(carried.pending())).toBe('{"jsonrpc"');
  });

  it('answers a line that is not JSON with a parse error and reads on', async () => {
    const input = scriptedInput();
    const output = recordedOutput();
    const carried = open(input, output.stream);
    const reader = carried.stream.readable.getReader();
    input.arrive(`not json\n\n${line(SET_MODE(8))}`);

    expect((await reader.read()).value).toEqual(SET_MODE(8));
    expect(output.messages()).toEqual([{ jsonrpc: '2.0', id: null, error: expect.objectContaining({ code: -32700 }) }]);
  });

  it('refuses a line nested deeper than the one JSON depth bound with the reason of that bound, and reads on', async () => {
    const input = scriptedInput();
    const output = recordedOutput();
    const carried = open(input, output.stream);
    const reader = carried.stream.readable.getReader();
    input.arrive(`${'['.repeat(MAX_JSON_DEPTH + 2)}${']'.repeat(MAX_JSON_DEPTH + 2)}\n${line(SET_MODE(9))}`);

    expect((await reader.read()).value).toEqual(SET_MODE(9));
    expect(output.messages()).toEqual([{ jsonrpc: '2.0', id: null, error: expect.objectContaining({ code: -32700, message: expect.stringContaining(`JSON depth exceeds the limit of ${MAX_JSON_DEPTH}`) }) }]);
  });

  it('gives the last line that has no line end when the input ends, then ends', async () => {
    const input = scriptedInput();
    const carried = open(input, recordedOutput().stream);
    const reader = carried.stream.readable.getReader();
    input.arrive(JSON.stringify(SET_MODE(9)));
    input.end();

    expect((await reader.read()).value).toEqual(SET_MODE(9));
    expect((await reader.read()).done).toBe(true);
  });
});

describe('the standard input of the process as the input of an ACP connection', () => {
  it('gives the bytes it has taken from the descriptor at once, and says when more arrived or the input ended', async () => {
    const stdin = new Readable({ read: () => undefined });
    const input = acpInputOf(stdin);

    expect(input.take()).toBeUndefined();
    const arriving = input.arrival();
    stdin.push(Buffer.from('abc'));
    expect(await arriving).toBe('bytes');
    stdin.push(Buffer.from('def'));
    expect(decoder.decode(input.take())).toBe('abcdef');
    expect(input.take()).toBeUndefined();
    stdin.push(null);
    expect(await input.arrival()).toBe('end');
    expect(await input.arrival()).toBe('end');
  });
});
