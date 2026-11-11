export const GIT_CREDENTIAL_SOCKET_ENV = 'MOMONGA_GIT_CREDENTIAL_SOCKET';
export const GIT_CREDENTIAL_NONCE_ENV = 'MOMONGA_GIT_CREDENTIAL_NONCE';

export const ASKPASS_CLIENT_SOURCE = `import net from 'node:net';
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
