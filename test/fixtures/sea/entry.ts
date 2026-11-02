import { spawnSync } from 'node:child_process';
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

program.command('__daemon').action(async () => {
  const { daemonBanner } = await import('./daemon.ts');
  process.stdout.write(`${daemonBanner()}\n`);
});

program.command('respawn <subcommand>').action((subcommand: string) => {
  const result = spawnSync(process.execPath, [subcommand], { encoding: 'utf8', env: { ...process.env, SEA_FIXTURE_CHILD: '1' } });
  if (result.error) throw result.error;
  process.stdout.write(`child exit=${String(result.status)} stdout=${result.stdout.trim()}\n`);
});

program.command('node-version').action(() => {
  process.stdout.write(`${process.version}\n`);
});

await program.parseAsync();
