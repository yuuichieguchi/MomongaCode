import type { KeeperConnection, KeeperHost, KeeperRun } from '../../src/platform/windows-keeper.ts';

export type FakeKeeper = {
  readonly args: readonly string[];
  readonly mode: string;
  readonly job: string;
  readonly written: string[];
  readonly exited: Promise<number | undefined>;
  onRequest: (line: string) => void;
  say(text: string): void;
  hangUp(): void;
  exit(code: number): void;
  closedByClient(): boolean;
};

export type FakeKeeperHost = {
  host: KeeperHost;
  keepers: FakeKeeper[];
  listened: string[];
  start(executable: string, args: readonly string[]): KeeperRun;
};

export const settle = async (): Promise<void> => {
  for (let round = 0; round < 50; round += 1) await Promise.resolve();
};

type Slot = { accept: ((connection: KeeperConnection) => void) | undefined; waiting: KeeperConnection | undefined };

export const fakeKeeperHost = (script: (keeper: FakeKeeper, index: number) => void = () => undefined): FakeKeeperHost => {
  const keepers: FakeKeeper[] = [];
  const listened: string[] = [];
  let slot: Slot | undefined;
  let serial = 0;

  const start = (_executable: string, args: readonly string[]): KeeperRun => {
    const data: Array<(chunk: Uint8Array) => void> = [];
    const closed: Array<() => void> = [];
    const written: string[] = [];
    const unread: string[] = [];
    let clientClosed = false;
    let ended = false;
    let exit: (code: number | undefined) => void = () => undefined;
    const end = (): void => {
      if (ended) return;
      ended = true;
      for (const listener of closed) listener();
    };
    const keeper: FakeKeeper = {
      args,
      mode: args[0] ?? '',
      job: args[2] ?? '',
      written,
      exited: new Promise((resolve) => (exit = resolve)),
      onRequest: () => undefined,
      say: (text) => {
        if (data.length === 0) unread.push(text);
        for (const listener of data) listener(new TextEncoder().encode(text));
      },
      hangUp: end,
      exit: (code) => exit(code),
      closedByClient: () => clientClosed,
    };
    const connection: KeeperConnection = {
      write: (text) => {
        written.push(text);
        keeper.onRequest(text.trimEnd());
      },
      close: () => {
        clientClosed = true;
        end();
      },
      onData: (listener) => {
        data.push(listener);
        for (const text of unread.splice(0)) listener(new TextEncoder().encode(text));
      },
      onClosed: (listener) => {
        if (ended) listener();
        else closed.push(listener);
      },
    };
    keepers.push(keeper);
    const mine = slot;
    queueMicrotask(() => {
      if (mine === undefined) return;
      if (mine.accept === undefined) mine.waiting = connection;
      else mine.accept(connection);
      queueMicrotask(() => script(keeper, keepers.length - 1));
    });
    return { exited: keeper.exited };
  };

  return {
    keepers,
    listened,
    start,
    host: {
      executable: async () => 'C:\\cache\\momonga-keeper.exe',
      commandInterpreter: () => 'C:\\Windows\\System32\\cmd.exe',
      listen: (pipe) => {
        listened.push(pipe);
        const own: Slot = { accept: undefined, waiting: undefined };
        slot = own;
        return {
          accept: (signal) =>
            new Promise((resolve, reject) => {
              if (own.waiting !== undefined) resolve(own.waiting);
              else own.accept = resolve;
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
          close: () => undefined,
        };
      },
      start,
      random: { hex: (bytes) => (serial += 1).toString(16).padStart(2, '0').repeat(bytes) },
    },
  };
};

export const answeringMembers =
  (pids: () => readonly number[]) =>
  (keeper: FakeKeeper): void => {
    keeper.onRequest = (line) => {
      const [word, id] = line.split(' ');
      if (word === 'members') keeper.say(`members ${id}${pids().map((pid) => ` ${pid}`).join('')}\n`);
    };
  };
