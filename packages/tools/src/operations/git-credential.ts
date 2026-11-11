import { randomBytes, timingSafeEqual } from 'node:crypto';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { parseOutsideJson } from '@momonga/foundation';

export type GitHostCredential = { readonly host: string; readonly username: string; readonly password: string };

export type GitCredentialChannel = {
  readonly directory: string;
  environment(env: Readonly<Record<string, string>>): Record<string, string>;
  redact(text: string): string;
  close(): Promise<void>;
};

export const GIT_CREDENTIAL_SOCKET_ENV = 'MOMONGA_GIT_CREDENTIAL_SOCKET';
export const GIT_CREDENTIAL_NONCE_ENV = 'MOMONGA_GIT_CREDENTIAL_NONCE';

const MAX_ASK_BYTES = 4096;
const REDACTED = '[redacted]';
const PROMPT = /^(Username|Password) for '([a-z][a-z0-9+.-]*):\/\/(?:[^@/']*@)?([^/']+)[^']*': $/i;

const CLIENT_SOURCE = `import net from 'node:net';
const socket = net.connect(process.env.${GIT_CREDENTIAL_SOCKET_ENV});
let answer = '';
socket.setEncoding('utf8');
socket.on('data', (chunk) => {
  answer += chunk;
});
socket.on('error', () => process.exit(1));
socket.on('end', () => {
  if (answer === '') process.exit(1);
  process.stdout.write(answer);
});
socket.end(JSON.stringify({ nonce: process.env.${GIT_CREDENTIAL_NONCE_ENV}, prompt: process.argv[2] }) + '\\n');
`;

const shellQuoted = (value: string): string => `'${value.split("'").join(`'\\''`)}'`;

const sameText = (left: string, right: string): boolean => {
  const first = Buffer.from(left, 'utf8');
  const second = Buffer.from(right, 'utf8');
  return first.length === second.length && timingSafeEqual(first, second);
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

const configAppended = (env: Readonly<Record<string, string>>, entries: ReadonlyArray<readonly [string, string]>): Record<string, string> => {
  const given = Number(env['GIT_CONFIG_COUNT'] ?? '0');
  const start = Number.isInteger(given) && given > 0 ? given : 0;
  return {
    GIT_CONFIG_COUNT: String(start + entries.length),
    ...Object.fromEntries(entries.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${start + index}`, key], [`GIT_CONFIG_VALUE_${start + index}`, value]])),
  };
};

export const openGitCredentialChannel = async (credentials: readonly GitHostCredential[], options: { root: string }): Promise<GitCredentialChannel> => {
  const directory = await fsp.mkdtemp(path.join(options.root, 'mmc-'));
  await fsp.chmod(directory, 0o700);
  const socketPath = path.join(directory, 's');
  const clientPath = path.join(directory, 'askpass.mjs');
  const askpassPath = path.join(directory, 'askpass');
  const nonce = randomBytes(32).toString('hex');
  const answered = new Set<string>();
  const sockets = new Set<net.Socket>();

  const answerOf = (ask: Ask): string | undefined => {
    if (!sameText(ask.nonce, nonce)) return undefined;
    const match = PROMPT.exec(ask.prompt);
    if (match === null) return undefined;
    const kind = (match[1] as string).toLowerCase();
    const host = match[3] as string;
    const credential = credentials.find((candidate) => candidate.host === host);
    if (credential === undefined) return undefined;
    const key = `${kind} ${host}`;
    if (answered.has(key)) return undefined;
    answered.add(key);
    return kind === 'username' ? credential.username : credential.password;
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

  const remove = (): Promise<void> => fsp.rm(directory, { recursive: true, force: true });

  try {
    await fsp.writeFile(clientPath, CLIENT_SOURCE, { mode: 0o600 });
    await fsp.writeFile(askpassPath, `#!/bin/sh\nexec ${shellQuoted(process.execPath)} ${shellQuoted(clientPath)} "$1"\n`, { mode: 0o700 });
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
      ...env,
      GIT_ASKPASS: askpassPath,
      GIT_TERMINAL_PROMPT: '0',
      [GIT_CREDENTIAL_SOCKET_ENV]: socketPath,
      [GIT_CREDENTIAL_NONCE_ENV]: nonce,
      ...configAppended(env, [['credential.helper', '']]),
    }),
    redact: (text) => credentials.reduce((clean, credential) => clean.split(credential.password).join(REDACTED), text),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await remove();
    },
  };
};
