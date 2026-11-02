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

program.command('node-version').action(() => {
  process.stdout.write(`${process.version}\n`);
});

await program.parseAsync();
