import { spawn } from 'node:child_process';
import net from 'node:net';
import type { Random } from '../random.ts';
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

export const listenForKeeper = (pipe: string, signal: AbortSignal): Promise<KeeperListener> =>
  new Promise<KeeperListener>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const server = net.createServer({ pauseOnConnect: false });
    server.maxConnections = 1;
    const stop = (): void => {
      server.close();
      reject(signal.reason);
    };
    signal.addEventListener('abort', stop, { once: true });
    server.once('error', (error) => {
      signal.removeEventListener('abort', stop);
      reject(error);
    });
    server.listen(pipe, () => {
      signal.removeEventListener('abort', stop);
      resolve({
        accept: (asker) =>
          new Promise<KeeperConnection>((accepted, refused) => {
            if (asker.aborted) {
              refused(asker.reason);
              return;
            }
            const leave = (): void => refused(asker.reason);
            asker.addEventListener('abort', leave, { once: true });
            server.once('connection', (socket) => {
              asker.removeEventListener('abort', leave);
              accepted(connectionOf(socket));
            });
          }),
        close: () => {
          server.close();
        },
      });
    });
  });

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
  executable(signal: AbortSignal): Promise<string>;
  random: Pick<Random, 'hex'>;
  env: KeeperSpawnEnv;
};

export const createNodeKeeperHost = ({ executable, random, env }: NodeKeeperHostOptions): KeeperHost => ({
  executable,
  listen: listenForKeeper,
  start: startDetachedKeeper(env),
  random,
});
