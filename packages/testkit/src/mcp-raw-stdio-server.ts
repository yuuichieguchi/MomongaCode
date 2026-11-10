import { spawn } from './child-process.ts';
import fs from 'node:fs';
import readline from 'node:readline';

type RawRequest = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> };

const LATE_WRITER = `
const [leader, count, bytes] = process.argv.slice(1).map(Number);
const leaderGone = () => { try { process.kill(leader, 0); return false; } catch { return true; } };
const writeAll = () => {
  let text = '';
  for (let index = 0; index < count; index += 1) {
    text += JSON.stringify({ jsonrpc: '2.0', method: 'notifications/late', params: { index, payload: 'y'.repeat(bytes) } }) + '\\n';
  }
  process.stdout.write(text, () => process.exit(0));
};
const timer = setInterval(() => { if (leaderGone()) { clearInterval(timer); writeAll(); } }, 5);
`;

const ESCAPED_GRANDCHILD = [
  'use POSIX;',
  'use Errno qw(EPIPE);',
  'POSIX::setsid();',
  '$SIG{PIPE} = "IGNORE";',
  '$SIG{USR1} = sub {',
  '  my $out = defined(POSIX::write(1, qq({"jsonrpc":"2.0","method":"notifications/escaped","params":{}}\\n), 64)) ? "ok" : ($! == EPIPE ? "EPIPE" : "error");',
  '  my $err = defined(POSIX::write(2, "escaped-stderr\\n", 15)) ? "ok" : ($! == EPIPE ? "EPIPE" : "error");',
  '  open(my $ack, ">>", "$ARGV[0].ack"); print $ack "stdout=$out stderr=$err\\n"; close($ack);',
  '};',
  'open(my $ready, ">", "$ARGV[0].tmp"); print $ready $$; close($ready); rename("$ARGV[0].tmp", $ARGV[0]);',
  'sleep 1 while 1;',
].join(' ');

const modes = new Set(process.argv.slice(2));

const writeLine = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const respond = (id: number | string, result: unknown): void => writeLine(JSON.stringify({ jsonrpc: '2.0', id, result }));

const respondAfterStderr = (id: number | string, chunk: string): void => {
  process.stderr.write(chunk, () => respond(id, { written: Buffer.byteLength(chunk) }));
};

const handle = (request: RawRequest): void => {
  if (request.id === undefined) {
    if (request.method === 'notify_back') writeLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/echo', params: request.params ?? {} }));
    return;
  }
  const params = request.params ?? {};
  switch (request.method) {
    case 'echo':
      respond(request.id, params);
      return;
    case 'env':
      respond(request.id, { env: { ...process.env } });
      return;
    case 'cwd':
      respond(request.id, { cwd: process.cwd() });
      return;
    case 'pid':
      respond(request.id, { pid: process.pid });
      return;
    case 'stderr':
      respondAfterStderr(request.id, String(params['text']));
      return;
    case 'big':
      respond(request.id, { payload: 'x'.repeat(Number(params['bytes'])) });
      return;
    case 'oversized':
      process.stdout.write('{"jsonrpc":"2.0","method":"notifications/huge","params":{"payload":"');
      process.stdout.write('x'.repeat(Number(params['bytes'])));
      return;
    case 'blank_lines':
      process.stdout.write('\n\r\n\n');
      respond(request.id, { afterBlank: true });
      return;
    case 'late_write': {
      spawn(process.execPath, ['-e', LATE_WRITER, String(process.pid), String(params['count']), String(params['bytes'])], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      process.exit(0);
    }
    case 'escape_grandchild': {
      const readyFile = String(params['readyFile']);
      spawn('perl', ['-e', ESCAPED_GRANDCHILD, readyFile], { stdio: ['ignore', 'inherit', 'inherit'] });
      const timer = setInterval(() => {
        if (fs.existsSync(readyFile)) {
          clearInterval(timer);
          process.exit(0);
        }
      }, 5);
      return;
    }
    case 'garbage':
      writeLine('this is not json');
      respond(request.id, { afterGarbage: true });
      return;
    case 'exit':
      process.exit(Number(params['code']));
    case 'kill_self':
      process.kill(process.pid, String(params['signal']) as NodeJS.Signals);
      return;
    case 'spawn_grandchild': {
      const grandchild = spawn('sleep', ['600'], { stdio: 'ignore' });
      respond(request.id, { pid: grandchild.pid });
      return;
    }
    default:
      writeLine(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } }));
  }
};

const runServer = (): void => {
  if (modes.has('--ignore-term')) process.on('SIGTERM', () => undefined);
  const keepAlive = modes.has('--linger') || modes.has('--ignore-term') ? setInterval(() => undefined, 1000) : undefined;
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (line.trim() !== '') handle(JSON.parse(line) as RawRequest);
  });
  lines.on('close', () => {
    if (keepAlive === undefined) process.exit(0);
  });
};

if (import.meta.main) runServer();
