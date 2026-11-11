import { timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { assertUnixSocketPathFits, createRedactor, helperCommandLine, parseOutsideJson } from '@momonga/foundation';
import type { FileSystem, HelperSelf, Random } from '@momonga/foundation';
import { appendGitConfig } from '../read-only-call.ts';
import { GIT_ASKPASS_HELPER, GIT_CREDENTIAL_NONCE_ENV, GIT_CREDENTIAL_SOCKET_ENV } from './askpass-client.ts';

export type GitOriginCredential = { readonly origin: string; readonly username: string; readonly password: string };

export type GitCredentialChannel = {
  readonly directory: string;
  environment(env: Readonly<Record<string, string>>): Record<string, string>;
  redact(text: string): string;
  close(): Promise<void>;
};

const MAX_ASK_BYTES = 4096;
const NONCE_BYTES = 32;
const ASKPASS_MODE = 0o700;
const PROMPT = /^(Username|Password) for '([a-z][a-z0-9+.-]*):\/\/(?:[^@/']*@)?([^/']+)([^']*)': $/i;

const shellQuoted = (value: string): string => `'${value.split("'").join(`'\\''`)}'`;

const sameText = (left: string, right: string): boolean => {
  const first = Buffer.from(left, 'utf8');
  const second = Buffer.from(right, 'utf8');
  return first.length === second.length && timingSafeEqual(first, second);
};

type Asked = { kind: 'username' | 'password'; origin: string; path: string };

const askedOf = (prompt: string): Asked | undefined => {
  const match = PROMPT.exec(prompt);
  if (match === null) return undefined;
  const [, kind, scheme, authority, rest] = match;
  if (kind === undefined || scheme === undefined || authority === undefined || rest === undefined) return undefined;
  if (!URL.canParse(`${scheme}://${authority}`)) return undefined;
  return { kind: kind.toLowerCase() === 'username' ? 'username' : 'password', origin: new URL(`${scheme}://${authority}`).origin, path: rest };
};

type Ask = { nonce: string; prompt: string };

const parseAsk = (line: string): Ask | undefined => {
  let value: unknown;
  try {
    value = parseOutsideJson(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { nonce, prompt } = value as Record<string, unknown>;
  return typeof nonce === 'string' && typeof prompt === 'string' ? { nonce, prompt } : undefined;
};

export type GitCredentialChannelOptions = { root: string; random: Pick<Random, 'hex'>; files: Pick<FileSystem, 'mkdtemp' | 'mkdirPrivate' | 'open' | 'rm'>; helper: HelperSelf };

const writeNew = async (files: Pick<FileSystem, 'open'>, file: string, text: string, mode: number): Promise<void> => {
  const handle = await files.open(file, 'wx', mode);
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
};

export const openGitCredentialChannel = async (credentials: readonly GitOriginCredential[], { root, random, files, helper }: GitCredentialChannelOptions): Promise<GitCredentialChannel> => {
  const directory = await files.mkdtemp(path.join(root, 'mmc-'));
  await files.mkdirPrivate(directory);
  const socketPath = path.join(directory, 's');
  const askpassPath = path.join(directory, 'askpass');
  const nonce = random.hex(NONCE_BYTES);
  const answered = new Set<string>();
  const sockets = new Set<net.Socket>();

  const redactor = createRedactor({ credentials: credentials.map((credential) => credential.password) });
  const askpassProgram = helperCommandLine(helper, GIT_ASKPASS_HELPER, []).map(shellQuoted).join(' ');

  const answerOf = (ask: Ask): string | undefined => {
    if (!sameText(ask.nonce, nonce)) return undefined;
    const asked = askedOf(ask.prompt);
    if (asked === undefined) return undefined;
    const credential = credentials.find((candidate) => candidate.origin === asked.origin);
    if (credential === undefined) return undefined;
    const key = `${asked.kind} ${asked.origin}${asked.path}`;
    if (answered.has(key)) return undefined;
    answered.add(key);
    return asked.kind === 'username' ? credential.username : credential.password;
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    let received = '';
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (received.length > MAX_ASK_BYTES) {
        socket.destroy();
        return;
      }
      const end = received.indexOf('\n');
      if (end < 0) return;
      const ask = parseAsk(received.slice(0, end));
      const answer = ask === undefined ? undefined : answerOf(ask);
      socket.end(answer === undefined ? '' : `${answer}\n`);
    });
  });

  const remove = (): Promise<void> => files.rm(directory, { recursive: true });

  try {
    await assertUnixSocketPathFits(socketPath);
    await writeNew(files, askpassPath, `#!/bin/sh\nexec ${askpassProgram} "$1"\n`, ASKPASS_MODE);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    await remove();
    throw error;
  }

  return {
    directory,
    environment: (env) => ({
      ...appendGitConfig(env, [
        ['credential.helper', ''],
        ['credential.useHttpPath', 'true'],
      ]),
      GIT_ASKPASS: askpassPath,
      GIT_TERMINAL_PROMPT: '0',
      [GIT_CREDENTIAL_SOCKET_ENV]: socketPath,
      [GIT_CREDENTIAL_NONCE_ENV]: nonce,
    }),
    redact: (text) => redactor.whole(text),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await remove();
    },
  };
};
