import { spawn } from 'node:child_process';
import net from 'node:net';
import { readFileBytesSync } from '../node-file-system.ts';
import type { Random } from '../random.ts';
import { systemRandom } from '../system-random.ts';
import { checkedWindowsKeeper } from './windows-keeper-asset.ts';
import type { KeeperConnection, KeeperHost, KeeperListener, KeeperRun } from './windows-keeper.ts';

const connectionOf = (socket: net.Socket): KeeperConnection => {
  const closed: Array<() => void> = [];
  let ended = false;
  socket.on('error', () => undefined);
  socket.on('close', () => {
    ended = true;
    for (const listener of closed) listener();
  });
  return {
    write: (text) => {
      if (!ended) socket.write(text);
    },
    close: () => socket.destroy(),
    onData: (listener) => {
      socket.on('data', (chunk: Buffer) => listener(chunk));
    },
    onClosed: (listener) => {
      if (ended) listener();
      else closed.push(listener);
    },
  };
};

export const listenForKeeper = (pipe: string): KeeperListener => {
  const server = net.createServer({ pauseOnConnect: false });
  server.maxConnections = 1;
  let failure: Error | undefined;
  let arrived: KeeperConnection | undefined;
  let waiting: { accepted(connection: KeeperConnection): void; refused(reason: unknown): void } | undefined;
  server.once('error', (error) => {
    failure = error;
    waiting?.refused(error);
  });
  server.once('connection', (socket) => {
    arrived = connectionOf(socket);
    waiting?.accepted(arrived);
  });
  server.listen(pipe);
  return {
    accept: (asker) =>
      new Promise<KeeperConnection>((accepted, refused) => {
        if (failure !== undefined) {
          refused(failure);
          return;
        }
        if (arrived !== undefined) {
          accepted(arrived);
          return;
        }
        if (asker.aborted) {
          refused(asker.reason);
          return;
        }
        const leave = (): void => refused(asker.reason);
        asker.addEventListener('abort', leave, { once: true });
        waiting = {
          accepted: (connection) => {
            asker.removeEventListener('abort', leave);
            accepted(connection);
          },
          refused: (reason) => {
            asker.removeEventListener('abort', leave);
            refused(reason);
          },
        };
      }),
    close: () => {
      server.close();
    },
  };
};

export type KeeperSpawnEnv = Readonly<Record<string, string | undefined>>;

export const startDetachedKeeper =
  (env: KeeperSpawnEnv) =>
  (executable: string, args: readonly string[]): KeeperRun => {
    const child = spawn(executable, [...args], { env: { ...env }, detached: true, windowsHide: true, stdio: 'ignore' });
    return {
      exited: new Promise<number | undefined>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? undefined));
      }),
    };
  };

export type NodeKeeperHostOptions = {
  executable(): Promise<string>;
  random: Pick<Random, 'hex'>;
  env: KeeperSpawnEnv;
};

const commandInterpreterIn = (env: KeeperSpawnEnv): string => {
  const systemRoot = env['SystemRoot'];
  if (systemRoot === undefined || systemRoot === '') throw new Error('SystemRoot is not set in the environment, so the Windows command interpreter that runs command scripts cannot be found');
  return `${systemRoot.replace(/\\+$/, '')}\\System32\\cmd.exe`;
};

export const createNodeKeeperHost = ({ executable, random, env }: NodeKeeperHostOptions): KeeperHost => ({
  executable,
  commandInterpreter: () => commandInterpreterIn(env),
  listen: listenForKeeper,
  start: startDetachedKeeper(env),
  random,
});

export type KeeperPreparation = () => Promise<() => string>;

let providedKeeper: KeeperPreparation | undefined;
let preparedKeeper: Promise<() => string> | undefined;

export const provideWindowsKeeper = (prepare: KeeperPreparation): void => {
  providedKeeper = prepare;
  preparedKeeper = undefined;
};

const preparedWindowsKeeper = (): Promise<() => string> => {
  if (preparedKeeper !== undefined) return preparedKeeper;
  if (providedKeeper === undefined) return Promise.reject(new Error('no keeper executable was provided to this process, so no command can be started or found in a Job Object'));
  const preparing = providedKeeper();
  preparedKeeper = preparing;
  preparing.then(undefined, () => {
    if (preparedKeeper === preparing) preparedKeeper = undefined;
  });
  return preparing;
};

export const hostKeeperHost = (): KeeperHost =>
  createNodeKeeperHost({
    executable: async () => (await preparedWindowsKeeper())(),
    random: systemRandom,
    env: process.env,
  });

export const hostCheckedWindowsKeeper = (file: string, sha256: string): (() => string) => checkedWindowsKeeper(file, sha256, readFileBytesSync);
