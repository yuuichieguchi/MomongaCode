import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { groupTerminationBoundMs } from '../../src/process-group.ts';
import {
  KEEPER_EXIT_CODES,
  KEEPER_LINE_LIMIT,
  KeeperLostError,
  KeeperProtocolError,
  attachKept,
  confirmByAttach,
  createKeeperLineDecoder,
  keeperAttachArguments,
  keeperExitName,
  keeperJobName,
  keeperLaunchArguments,
  keeperPipeName,
  launchKept,
  parseKeeperLine,
  stopKeptGroup,
} from '../../src/platform/windows-keeper.ts';
import type { KeeperConnection, KeeperHost, KeeperRun } from '../../src/platform/windows-keeper.ts';

const turn = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const live = (): AbortSignal => new AbortController().signal;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

type FakePipe = {
  connection: KeeperConnection;
  written: string[];
  say(text: string): void;
  hangUp(): void;
  closedByClient(): boolean;
};

const fakePipe = (): FakePipe => {
  const data: Array<(chunk: Uint8Array) => void> = [];
  const closed: Array<() => void> = [];
  const written: string[] = [];
  let clientClosed = false;
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    for (const listener of closed) listener();
  };
  return {
    written,
    say: (text) => {
      for (const listener of data) listener(encode(text));
    },
    hangUp: end,
    closedByClient: () => clientClosed,
    connection: {
      write: (text) => void written.push(text),
      close: () => {
        clientClosed = true;
        end();
      },
      onData: (listener) => void data.push(listener),
      onClosed: (listener) => void closed.push(listener),
    },
  };
};

type FakeKeeper = {
  host: KeeperHost;
  pipe: FakePipe;
  starts: Array<{ executable: string; args: readonly string[] }>;
  listened: string[];
  listenerClosed(): boolean;
  connect(): void;
  exit(code: number): void;
  start(executable: string, args: readonly string[]): KeeperRun;
};

const fakeKeeper = (): FakeKeeper => {
  const pipe = fakePipe();
  const starts: Array<{ executable: string; args: readonly string[] }> = [];
  const listened: string[] = [];
  let accept: ((connection: KeeperConnection) => void) | undefined;
  let exited: ((code: number) => void) | undefined;
  let closed = false;
  let serial = 0;
  const start = (executable: string, args: readonly string[]): KeeperRun => {
    starts.push({ executable, args });
    return { exited: new Promise((resolve) => (exited = resolve)) };
  };
  return {
    pipe,
    starts,
    listened,
    listenerClosed: () => closed,
    connect: () => accept?.(pipe.connection),
    exit: (code) => exited?.(code),
    start,
    host: {
      executable: async () => 'C:\\cache\\momonga-keeper.exe',
      listen: async (name) => {
        listened.push(name);
        return {
          accept: (signal) =>
            new Promise((resolve, reject) => {
              accept = resolve;
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
          close: () => {
            closed = true;
          },
        };
      },
      start,
      random: { hex: (bytes) => `${String((serial += 1)).padStart(2, '0')}`.repeat(bytes) },
    },
  };
};

const startedGroup = async (keeper: FakeKeeper = fakeKeeper()) => {
  const pending = launchKept(keeper.host, { command: { file: 'cmd.exe', args: ['/c', 'echo a b'] }, onOwnerLoss: 'terminate', marker: undefined, start: keeper.start, signal: live() });
  await turn();
  keeper.connect();
  await turn();
  keeper.pipe.say('started 4242\n');
  const launch = await pending;
  if (launch.kind !== 'started') throw new Error('the fake keeper did not start');
  return { keeper, launch, group: launch.group };
};

describe('the keeper protocol: names, arguments and exit codes', () => {
  it('names the job Local\\momonga-<128 random bits> and the pipe \\\\.\\pipe\\momonga-keeper-<128 random bits>', () => {
    const random = { hex: (bytes: number) => 'ab'.repeat(bytes) };
    expect(keeperJobName(random)).toBe(`Local\\momonga-${'ab'.repeat(16)}`);
    expect(keeperPipeName(random)).toBe(`\\\\.\\pipe\\momonga-keeper-${'ab'.repeat(16)}`);
  });

  it('puts every word of its own before -- in a form that needs no quoting, the marker path as hex of its UTF-8', () => {
    const args = keeperLaunchArguments({ pipe: '\\\\.\\pipe\\momonga-keeper-00', job: 'Local\\momonga-11', onOwnerLoss: 'persist', marker: 'C:\\Users\\a b\\m é', command: { file: 'C:\\Program Files\\x.exe', args: ['a b', '"q"'] } });
    expect(args).toEqual(['launch', '\\\\.\\pipe\\momonga-keeper-00', 'Local\\momonga-11', 'persist', Buffer.from('C:\\Users\\a b\\m é', 'utf8').toString('hex'), '--', 'C:\\Program Files\\x.exe', 'a b', '"q"']);
    expect(args.slice(0, 6).every((word) => /^[A-Za-z0-9\\.-]+$/.test(word))).toBe(true);
    expect(keeperLaunchArguments({ pipe: 'p', job: 'j', onOwnerLoss: 'terminate', marker: undefined, command: { file: 'x', args: [] } })).toEqual(['launch', 'p', 'j', 'terminate', '-', '--', 'x']);
    expect(keeperAttachArguments({ pipe: 'p', job: 'j' })).toEqual(['attach', 'p', 'j']);
  });

  it('names its exit codes, each distinct and outside the codes a command is likely to return', () => {
    const codes = Object.values(KEEPER_EXIT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(Object.keys(KEEPER_EXIT_CODES)).toEqual(['usage', 'pipe-unavailable', 'name-taken', 'containment-unavailable', 'marker-unavailable', 'launch-failed', 'job-absent', 'owner-lost', 'terminated']);
    expect(codes.every((code) => code > 0x4d4b0000 && code < 0x4d4b0100)).toBe(true);
    expect(keeperExitName(KEEPER_EXIT_CODES['name-taken'])).toBe('name-taken');
    expect(keeperExitName(KEEPER_EXIT_CODES['containment-unavailable'])).toBe('containment-unavailable');
    expect(keeperExitName(1)).toBeUndefined();
  });
});

describe('the keeper protocol: lines', () => {
  it('parses every line the keeper sends', () => {
    expect(parseKeeperLine('started 4242')).toEqual({ kind: 'started', pid: 4242 });
    expect(parseKeeperLine('attached')).toEqual({ kind: 'attached' });
    expect(parseKeeperLine('failed name-taken 183')).toEqual({ kind: 'failed', reason: 'name-taken', systemError: 183 });
    expect(parseKeeperLine('failed containment-unavailable 5')).toEqual({ kind: 'failed', reason: 'containment-unavailable', systemError: 5 });
    expect(parseKeeperLine('exit 3221225786')).toEqual({ kind: 'exit', code: 3221225786 });
    expect(parseKeeperLine('members 7 10 20 30')).toEqual({ kind: 'members', id: 7, pids: [10, 20, 30] });
    expect(parseKeeperLine('members 8')).toEqual({ kind: 'members', id: 8, pids: [] });
    expect(parseKeeperLine('empty')).toEqual({ kind: 'empty' });
  });

  it.each(['', 'hello', 'started', 'started x', 'started 1 2', 'failed unknown-reason 1', 'failed name-taken', 'members', 'members x', 'members 1 -2', 'members 1 2.5', 'empty now', 'exit', 'attached 1', 'started 4294967296'])(
    'refuses the line %j',
    (line) => {
      expect(() => parseKeeperLine(line)).toThrow(KeeperProtocolError);
    },
  );

  it('joins chunks cut anywhere, also inside a line, and accepts \\r\\n', () => {
    const lines: string[] = [];
    const feed = createKeeperLineDecoder((line) => void lines.push(line));
    feed(encode('star'));
    feed(encode('ted 1\nmem'));
    expect(lines).toEqual(['started 1']);
    feed(encode('bers 1 2\r\nempty\n'));
    expect(lines).toEqual(['started 1', 'members 1 2', 'empty']);
  });

  it('refuses a line longer than the limit instead of holding it', () => {
    const feed = createKeeperLineDecoder(() => undefined);
    expect(() => feed(encode('m'.repeat(KEEPER_LINE_LIMIT + 1)))).toThrow(KeeperProtocolError);
  });
});

describe('launching through the keeper', () => {
  it('listens on a fresh pipe before it starts the keeper, passes the names, and returns the group of the started command', async () => {
    const { keeper, launch } = await startedGroup();
    expect(keeper.listened).toEqual([`\\\\.\\pipe\\momonga-keeper-${'02'.repeat(16)}`]);
    expect(keeper.starts).toEqual([
      { executable: 'C:\\cache\\momonga-keeper.exe', args: ['launch', `\\\\.\\pipe\\momonga-keeper-${'02'.repeat(16)}`, `Local\\momonga-${'01'.repeat(16)}`, 'terminate', '-', '--', 'cmd.exe', '/c', 'echo a b'] },
    ]);
    expect(launch.commandPid).toBe(4242);
    expect(launch.group.job).toBe(`Local\\momonga-${'01'.repeat(16)}`);
    expect(keeper.listenerClosed()).toBe(true);
  });

  it('reports a refusal by its reason and never calls the command contained', async () => {
    const keeper = fakeKeeper();
    const pending = launchKept(keeper.host, { command: { file: 'x', args: [] }, onOwnerLoss: 'terminate', marker: undefined, start: keeper.start, signal: live() });
    await turn();
    keeper.connect();
    await turn();
    keeper.pipe.say('failed containment-unavailable 5\n');
    expect(await pending).toMatchObject({ kind: 'refused', reason: 'containment-unavailable', systemError: 5 });
  });

  it('fails with the exit code name when the keeper ends before it connects', async () => {
    const keeper = fakeKeeper();
    const pending = launchKept(keeper.host, { command: { file: 'x', args: [] }, onOwnerLoss: 'terminate', marker: undefined, start: keeper.start, signal: live() });
    const outcome = pending.catch((error: unknown) => error);
    await turn();
    keeper.exit(KEEPER_EXIT_CODES['pipe-unavailable']);
    const error = await outcome;
    expect(error).toBeInstanceOf(KeeperLostError);
    expect((error as KeeperLostError).message).toContain('pipe-unavailable');
    expect(keeper.listenerClosed()).toBe(true);
  });

  it('fails when the pipe closes before the first word', async () => {
    const keeper = fakeKeeper();
    const outcome = launchKept(keeper.host, { command: { file: 'x', args: [] }, onOwnerLoss: 'terminate', marker: undefined, start: keeper.start, signal: live() }).catch((error: unknown) => error);
    await turn();
    keeper.connect();
    await turn();
    keeper.pipe.hangUp();
    expect(await outcome).toBeInstanceOf(KeeperLostError);
  });

  it("ends with the asker's reason when the asker stops waiting for a keeper that never connects, and closes the listener", async () => {
    const keeper = fakeKeeper();
    const asker = new AbortController();
    const outcome = launchKept(keeper.host, { command: { file: 'x', args: [] }, onOwnerLoss: 'terminate', marker: undefined, start: keeper.start, signal: asker.signal }).catch((error: unknown) => error);
    await turn();
    const reason = new Error('the asker left');
    asker.abort(reason);
    expect(await outcome).toBe(reason);
    expect(keeper.listenerClosed()).toBe(true);
  });

  it("closes the pipe, which is the owner's loss to the keeper, when the asker stops waiting for the first word", async () => {
    const keeper = fakeKeeper();
    const asker = new AbortController();
    const outcome = launchKept(keeper.host, { command: { file: 'x', args: [] }, onOwnerLoss: 'terminate', marker: undefined, start: keeper.start, signal: asker.signal }).catch((error: unknown) => error);
    await turn();
    keeper.connect();
    await turn();
    const reason = new Error('the asker left');
    asker.abort(reason);
    expect(await outcome).toBe(reason);
    expect(keeper.pipe.closedByClient()).toBe(true);
  });
});

describe('a kept group over its pipe', () => {
  it('asks for the members with a numbered request and gives the answer with the same number', async () => {
    const { keeper, group } = await startedGroup();
    const first = group.members(live());
    const second = group.members(live());
    expect(keeper.pipe.written).toEqual(['members 1\n', 'members 2\n']);
    keeper.pipe.say('members 2 9\nmembers 1 4242 77\n');
    expect(await first).toEqual({ kind: 'members', pids: [4242, 77] });
    expect(await second).toEqual({ kind: 'members', pids: [9] });
  });

  it('answers closed, not an exception, when the pipe closes under a question or was closed before it', async () => {
    const { keeper, group } = await startedGroup();
    const asked = group.members(live());
    keeper.pipe.hangUp();
    expect(await asked).toEqual({ kind: 'closed' });
    expect(await group.members(live())).toEqual({ kind: 'closed' });
    expect(await group.ended(live())).toBe('closed');
    expect(await group.commandExit(live())).toEqual({ kind: 'closed' });
  });

  it('remembers the empty event and the exit code of the command, whenever they are asked for', async () => {
    const { keeper, group } = await startedGroup();
    const waiting = group.commandExit(live());
    keeper.pipe.say('exit 3\nempty\n');
    keeper.pipe.hangUp();
    expect(await waiting).toEqual({ kind: 'exit', code: 3 });
    expect(await group.commandExit(live())).toEqual({ kind: 'exit', code: 3 });
    expect(await group.ended(live())).toBe('empty');
  });

  it("leaves a wait with the asker's reason when the asker's signal aborts", async () => {
    const { group } = await startedGroup();
    const asker = new AbortController();
    const outcome = group.members(asker.signal).catch((error: unknown) => error);
    const reason = new Error('stop asking');
    asker.abort(reason);
    expect(await outcome).toBe(reason);
  });

  it('writes terminate once and release closes the pipe', async () => {
    const { keeper, group } = await startedGroup();
    group.terminate();
    expect(keeper.pipe.written).toEqual(['terminate\n']);
    group.release();
    expect(keeper.pipe.closedByClient()).toBe(true);
  });

  it('closes the pipe and fails every wait when the keeper sends a line outside the protocol', async () => {
    const { keeper, group } = await startedGroup();
    const asked = group.members(live()).catch((error: unknown) => error);
    keeper.pipe.say('nonsense\n');
    expect(await asked).toBeInstanceOf(KeeperProtocolError);
    expect(keeper.pipe.closedByClient()).toBe(true);
  });
});

describe('attaching to a recorded job by its name', () => {
  it('starts the same keeper in attach mode and returns the group when the name opens', async () => {
    const keeper = fakeKeeper();
    const pending = attachKept(keeper.host, 'Local\\momonga-aa', live());
    await turn();
    expect(keeper.starts[0]?.args).toEqual(['attach', `\\\\.\\pipe\\momonga-keeper-${'01'.repeat(16)}`, 'Local\\momonga-aa']);
    keeper.connect();
    await turn();
    keeper.pipe.say('attached\n');
    const attached = await pending;
    expect(attached.kind).toBe('attached');
    if (attached.kind === 'attached') expect(attached.group.job).toBe('Local\\momonga-aa');
  });

  it('answers absent when the name does not open: the job no longer exists', async () => {
    const keeper = fakeKeeper();
    const pending = attachKept(keeper.host, 'Local\\momonga-aa', live());
    await turn();
    keeper.connect();
    await turn();
    keeper.pipe.say('failed job-absent 2\n');
    expect(await pending).toEqual({ kind: 'absent' });
  });

  it('confirms by name: absent when the name does not open, present when it opens, and lets the attached keeper go', async () => {
    const absent = fakeKeeper();
    const first = confirmByAttach(absent.host)('Local\\momonga-aa', live());
    await turn();
    absent.connect();
    await turn();
    absent.pipe.say('failed job-absent 2\n');
    expect(await first).toBe('absent');
    const present = fakeKeeper();
    const second = confirmByAttach(present.host)('Local\\momonga-aa', live());
    await turn();
    present.connect();
    await turn();
    present.pipe.say('attached\n');
    expect(await second).toBe('present');
    expect(present.pipe.closedByClient()).toBe(true);
  });
});

describe('T-JO-4: stopping a kept group on a fake keeper and a fake pipe', () => {
  const GRACE_MS = 3000;
  const timers = () => createFakeTimers(createFakeClock(0));
  const never = async (): Promise<'absent' | 'present'> => {
    throw new Error('the name was confirmed although the pipe answered');
  };

  it('gone: the keeper lists no member, so nothing is terminated', async () => {
    const { keeper, group } = await startedGroup();
    const stopping = stopKeptGroup(group, { graceMs: GRACE_MS, timing: timers(), signal: live(), confirm: never });
    await turn();
    keeper.pipe.say('members 1\n');
    expect(await stopping).toBe('gone');
    expect(keeper.pipe.written).toEqual(['members 1\n']);
  });

  it('terminated: members are listed, one terminate is sent, and the empty event ends the wait with no poll', async () => {
    const { keeper, group } = await startedGroup();
    const timing = timers();
    const stopping = stopKeptGroup(group, { graceMs: GRACE_MS, timing, signal: live(), confirm: never });
    await turn();
    keeper.pipe.say('members 1 4242 4300\n');
    await turn();
    expect(keeper.pipe.written).toEqual(['members 1\n', 'terminate\n']);
    keeper.pipe.say('empty\n');
    expect(await stopping).toBe('terminated');
    expect(keeper.pipe.written).toEqual(['members 1\n', 'terminate\n']);
    expect(timing.now()).toBe(0);
    expect(timing.pending()).toEqual([]);
  });

  it('a closed pipe is read by the name: gone when the name no longer opens, unconfirmed while it still opens', async () => {
    const outcomes: string[] = [];
    for (const named of ['absent', 'present'] as const) {
      const { keeper, group } = await startedGroup();
      const asked: string[] = [];
      const stopping = stopKeptGroup(group, {
        graceMs: GRACE_MS,
        timing: timers(),
        signal: live(),
        confirm: async (job) => {
          asked.push(job);
          return named;
        },
      });
      await turn();
      keeper.pipe.say('members 1 4242\n');
      await turn();
      keeper.pipe.hangUp();
      outcomes.push(await stopping);
      expect(asked).toEqual([group.job]);
    }
    expect(outcomes).toEqual(['gone', 'unconfirmed']);
  });

  it('a pipe that is already closed at the first question is read by the name too', async () => {
    const { keeper, group } = await startedGroup();
    keeper.pipe.hangUp();
    expect(await stopKeptGroup(group, { graceMs: GRACE_MS, timing: timers(), signal: live(), confirm: async () => 'absent' })).toBe('gone');
    expect(keeper.pipe.written).toEqual([]);
  });

  it('unconfirmed within 2g + 2p: a pipe that never answers the members question', async () => {
    const { keeper, group } = await startedGroup();
    const timing = timers();
    let outcome: string | undefined;
    void stopKeptGroup(group, { graceMs: GRACE_MS, timing, signal: live(), confirm: never }).then((value) => (outcome = value));
    await turn();
    timing.advance(GRACE_MS - 1);
    await turn();
    expect(outcome).toBeUndefined();
    timing.advance(1);
    await turn();
    expect(outcome).toBe('unconfirmed');
    expect(timing.now()).toBeLessThanOrEqual(groupTerminationBoundMs(GRACE_MS));
    expect(keeper.pipe.written).toEqual(['members 1\n']);
    expect(timing.pending()).toEqual([]);
  });

  it('unconfirmed within 2g + 2p: members answered, then no empty event ever arrives', async () => {
    const { keeper, group } = await startedGroup();
    const timing = timers();
    let outcome: string | undefined;
    void stopKeptGroup(group, { graceMs: GRACE_MS, timing, signal: live(), confirm: never }).then((value) => (outcome = value));
    await turn();
    timing.advance(GRACE_MS - 1);
    keeper.pipe.say('members 1 4242\n');
    await turn();
    timing.advance(GRACE_MS - 1);
    await turn();
    expect(outcome).toBeUndefined();
    timing.advance(1);
    await turn();
    expect(outcome).toBe('unconfirmed');
    expect(timing.now()).toBeLessThanOrEqual(groupTerminationBoundMs(GRACE_MS));
    expect(timing.pending()).toEqual([]);
  });

  it('unconfirmed: a confirmation by name that never answers is bounded by the same phase', async () => {
    const { keeper, group } = await startedGroup();
    const timing = timers();
    let outcome: string | undefined;
    void stopKeptGroup(group, { graceMs: GRACE_MS, timing, signal: live(), confirm: () => new Promise(() => undefined) }).then((value) => (outcome = value));
    await turn();
    keeper.pipe.hangUp();
    await turn();
    timing.advance(GRACE_MS);
    await turn();
    expect(outcome).toBe('unconfirmed');
  });

  it("unconfirmed at once when the asker's signal aborts, with no timer left", async () => {
    const { group } = await startedGroup();
    const timing = timers();
    const asker = new AbortController();
    const stopping = stopKeptGroup(group, { graceMs: GRACE_MS, timing, signal: asker.signal, confirm: never });
    await turn();
    asker.abort(new Error('the asker left'));
    expect(await stopping).toBe('unconfirmed');
    expect(timing.now()).toBe(0);
    expect(timing.pending()).toEqual([]);
  });

  it('a grace of 0 ms asks once and does not wait', async () => {
    const { group } = await startedGroup();
    const timing = timers();
    let outcome: string | undefined;
    void stopKeptGroup(group, { graceMs: 0, timing, signal: live(), confirm: never }).then((value) => (outcome = value));
    await turn();
    timing.advance(1);
    await turn();
    expect(outcome).toBe('unconfirmed');
  });
});
