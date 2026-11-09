import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import type { Claim } from '@momonga/store';
import { LEASE_MS, START_MS, enqueue, harness, makeStoreDir, mustClaim, newSession, registerCleanup } from './helpers.ts';

const STORE_ENTRY = pathToFileURL(path.resolve(import.meta.dirname, '../src/index.ts')).href;

const CHILD_SCRIPT = `
import { dirname } from 'node:path';
import fs from 'node:fs';
import { createInterface } from 'node:readline';
const { openRuntimeStore } = await import(process.argv[2]);
let now = Number(process.argv[4]);
const store = openRuntimeStore({ path: process.argv[3], home: dirname(process.argv[3]), clock: { now: () => now }, leaseMs: ${LEASE_MS}, maxAttempts: 5, maxTotalAttempts: 1000 });
const lines = createInterface({ input: process.stdin });
process.stdout.write('ready\\n');
for await (const line of lines) {
  const [command, argument] = line.split(' ');
  if (command === 'clock') {
    now = Number(argument);
    process.stdout.write('ok\\n');
  } else if (command === 'claim') {
    process.stdout.write(JSON.stringify(store.claim(argument)) + '\\n');
  } else if (command === 'race') {
    const [worker, barrier] = argument.split('|');
    process.stdout.write('armed\\n');
    while (!fs.existsSync(barrier)) {}
    process.stdout.write(JSON.stringify(store.claim(worker)) + '\\n');
  } else if (command === 'quit') {
    break;
  }
}
store.close();
`;

type Child = { send(line: string): Promise<string>; read(): Promise<string> };

const startChild = async (dbPath: string): Promise<Child> => {
  const scriptDir = makeStoreDir();
  const script = path.join(scriptDir, 'child.mjs');
  fs.writeFileSync(script, CHILD_SCRIPT);
  const process_: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [script, STORE_ENTRY, dbPath, String(START_MS)],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  registerCleanup(() => {
    if (process_.exitCode === null) process_.kill('SIGKILL');
  });
  let stderr = '';
  process_.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const iterator = createInterface({ input: process_.stdout })[Symbol.asyncIterator]();
  const nextLine = async (): Promise<string> => {
    const next = await iterator.next();
    if (next.done === true) throw new Error(`child exited early: ${stderr}`);
    return next.value;
  };
  expect(await nextLine()).toBe('ready');
  return {
    send: (line) => {
      process_.stdin.write(`${line}\n`);
      return nextLine();
    },
    read: nextLine,
  };
};

describe('claims across processes', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('hands a single queued run to exactly one process per round, with both sides winning', async () => {
    const { dbPath, store } = harness();
    const child = await startChild(dbPath);
    const barrierDir = makeStoreDir();
    const wins = { parent: 0, child: 0 };
    const parseClaim = (reply: string): Claim | null => JSON.parse(reply) as Claim | null;
    for (let round = 0; round < 30; round += 1) {
      enqueue(store, newSession(store, `/work/${round}`).id);
      let parentClaim: Claim | null;
      let childClaim: Claim | null;
      if (round % 3 === 0) {
        parentClaim = store.claim('parent');
        childClaim = parseClaim(await child.send('claim child'));
      } else if (round % 3 === 1) {
        childClaim = parseClaim(await child.send('claim child'));
        parentClaim = store.claim('parent');
      } else {
        const barrier = path.join(barrierDir, `go-${round}`);
        expect(await child.send(`race child|${barrier}`)).toBe('armed');
        fs.writeFileSync(barrier, '');
        parentClaim = store.claim('parent');
        childClaim = parseClaim(await child.read());
      }
      expect([parentClaim, childClaim].filter((claim) => claim !== null)).toHaveLength(1);
      const winner = parentClaim ?? childClaim!;
      wins[winner.workerId === 'parent' ? 'parent' : 'child'] += 1;
      expect((await store.release(winner, 'COMPLETED')).kind).toBe('ok');
    }
    expect(wins.parent).toBeGreaterThan(0);
    expect(wins.child).toBeGreaterThan(0);
  });

  it('rejects every write from a stale worker after another process reclaimed the run', async () => {
    const { dbPath, store } = harness();
    const run = enqueue(store, newSession(store).id);
    const child = await startChild(dbPath);
    const stale = mustClaim(store, 'parent');
    expect(await child.send(`clock ${START_MS + LEASE_MS}`)).toBe('ok');
    const reclaimed = JSON.parse(await child.send('claim child')) as Claim | null;
    expect(reclaimed).toMatchObject({ runId: run.id, workerId: 'child', leaseToken: stale.leaseToken + 1, attempt: 2 });
    const before = store.readRunEvents(run.id, 0, 100).length;
    expect(store.append(stale, [{ type: 'notice', level: 'info', message: 'stale' }])).toEqual({ kind: 'lease_lost' });
    expect(store.heartbeat(stale)).toEqual({ kind: 'lease_lost' });
    expect(await store.transition(stale, ['RUNNING'], 'COMPLETED')).toEqual({ kind: 'lease_lost' });
    expect(await store.release(stale, 'QUEUED')).toEqual({ kind: 'lease_lost' });
    expect(store.readRunEvents(run.id, 0, 100)).toHaveLength(before);
    expect(store.append(reclaimed!, [{ type: 'notice', level: 'info', message: 'fresh' }]).kind).toBe('ok');
  });
});
