import { spawnSync } from '@momonga/testkit/child-process';
import { Command } from 'commander';

const program = new Command().name('sea-fixture').version('0.0.0-fixture');

program.command('argv').action(() => {
  process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\n`);
});

program.command('ink').action(async () => {
  const { renderInk } = await import('./ink-view.ts');
  process.stdout.write(`${await renderInk()}\n`);
});

program.command('sqlite').action(async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (41), (1);');
  const row = database.prepare('SELECT SUM(v) AS total FROM t').get();
  database.close();
  process.stdout.write(`sqlite total=${String(row?.['total'])}\n`);
});

program.command('fts5-trigram').action(async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(':memory:');
  database.exec("CREATE VIRTUAL TABLE docs USING fts5(body, tokenize = 'trigram');");
  database.exec("INSERT INTO docs (body) VALUES ('the sweeper ran'), ('これはテストです'), ('short 設計');");
  const count = (query: string): string => String(database.prepare('SELECT count(*) AS hits FROM docs WHERE docs MATCH ?').get(query)?.['hits']);
  const output = `fts5 english=${count('"SWEEPER"')} japanese=${count('"テスト"')} short=${count('"設計"')}`;
  database.close();
  process.stdout.write(`${output}\n`);
});

program.command('__daemon').action(async () => {
  const { daemonBanner } = await import('./daemon.ts');
  process.stdout.write(`${daemonBanner()}\n`);
});

program.command('respawn <subcommand>').action((subcommand: string) => {
  const result = spawnSync(process.execPath, [subcommand], { encoding: 'utf8', env: { ...process.env, SEA_FIXTURE_CHILD: '1' } });
  if (result.error) throw result.error;
  process.stdout.write(`child exit=${String(result.status)} stdout=${result.stdout.trim()}\n`);
});

const firstStdinLine = (): Promise<string> =>
  new Promise((resolve, reject) => {
    let buffered = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('error', reject);
    process.stdin.on('data', (chunk: string) => {
      buffered += chunk;
      const end = buffered.indexOf('\n');
      if (end < 0) return;
      process.stdin.pause();
      resolve(buffered.slice(0, end));
    });
    process.stdin.on('end', () => resolve(buffered));
  });

const execSelf = (args: readonly string[]): void => {
  if (typeof process.execve !== 'function') {
    process.stdout.write('execve=absent\n');
    process.exit(3);
  }
  process.execve(process.execPath, [process.execPath, ...args], process.env);
};

program.command('exec-probe').action(() => {
  process.stdout.write(`before-exec pid=${String(process.pid)}\n`);
  execSelf(['exec-probe-after', String(process.pid), 'handed-on']);
});

program.command('exec-probe-after <pid> <token>').action(async (pid: string, token: string) => {
  const line = await firstStdinLine();
  process.stdout.write(`after-exec pid-same=${String(pid === String(process.pid))} token=${token} stdin=${line} argv=${JSON.stringify(process.argv.slice(2))}\n`);
});

const ALTERNATE_SCREEN_ON = '\u001b[?1049h';
const ALTERNATE_SCREEN_OFF = '\u001b[?1049l';

const ttyState = (): string => {
  const result = spawnSync('/bin/stty', ['-a'], { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' });
  const words = new Set(result.stdout.split(/\s+/));
  return `icanon=${words.has('-icanon') ? 'off' : 'on'} echo=${words.has('-echo') ? 'off' : 'on'} stty-status=${String(result.status)}`;
};

program.command('exec-tty').action(() => {
  if (!process.stdin.isTTY) {
    process.stdout.write('stdin-is-tty=false\n');
    process.exit(4);
  }
  process.stdin.setRawMode(true);
  process.stdout.write(`${ALTERNATE_SCREEN_ON}before-exec ${ttyState()}\r\n`);
  execSelf(['exec-tty-after']);
});

program.command('exec-tty-after').action(() => {
  const state = ttyState();
  process.stdout.write(`after-exec stdin-is-tty=${String(process.stdin.isTTY === true)} ${state}\r\n`);
  spawnSync('/bin/stty', ['sane'], { stdio: ['inherit', 'ignore', 'ignore'] });
  process.stdout.write(ALTERNATE_SCREEN_OFF);
});

program.command('node-version').action(() => {
  process.stdout.write(`${process.version}\n`);
});

await program.parseAsync();
