import net from 'node:net';
import type { ExecutableHelper } from '@momonga/foundation';

export const GIT_CREDENTIAL_SOCKET_ENV = 'MOMONGA_GIT_CREDENTIAL_SOCKET';
export const GIT_CREDENTIAL_NONCE_ENV = 'MOMONGA_GIT_CREDENTIAL_NONCE';
export const GIT_ASKPASS_HELPER = 'git-askpass';

const FAILED = 1;
const ANSWERED = 0;

const answerOf = (socketPath: string, ask: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let answer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      answer += chunk;
    });
    socket.once('error', reject);
    socket.once('end', () => resolve(answer));
    socket.end(ask);
  });

export const gitAskpass: ExecutableHelper = async (host) => {
  const refuse = (reason: string): number => {
    host.stderr.write(`momonga: ${reason}\n`);
    return FAILED;
  };
  const socketPath = host.env[GIT_CREDENTIAL_SOCKET_ENV];
  const nonce = host.env[GIT_CREDENTIAL_NONCE_ENV];
  const prompt = host.args[0];
  if (socketPath === undefined) return refuse(`the Git credential helper was started without ${GIT_CREDENTIAL_SOCKET_ENV}`);
  if (nonce === undefined) return refuse(`the Git credential helper was started without ${GIT_CREDENTIAL_NONCE_ENV}`);
  if (prompt === undefined) return refuse('the Git credential helper was started without the prompt of git');
  const answer = await answerOf(socketPath, `${JSON.stringify({ nonce, prompt })}\n`);
  if (answer === '') return refuse(`no credential is held for the prompt ${prompt}`);
  host.stdout.write(answer);
  return ANSWERED;
};
