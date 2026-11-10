import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { enqueue, harness, makeStoreDir, mustClaim, newSession, registerCleanup } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const STORE_ENTRY = pathToFileURL(path.resolve(import.meta.dirname, '../src/index.ts')).href;
const ROUNDS = 200;

const CHILD_SCRIPT = `
import { dirname } from 'node:path';
const { openRuntimeStore } = await import(process.argv[2]);
const [dbPath, runId, rounds] = [process.argv[3], process.argv[4], Number(process.argv[5])];
const store = openRuntimeStore({ path: dbPath, home: dirname(dbPath), clock: { now: () => Date.now() }, leaseMs: 60000, maxAttempts: 5, maxTotalAttempts: 1000 });
process.stdout.write('ready\\n');
let written = 0;
let tries = 0;
while (written < rounds) {
  tries += 1;
  if (tries > rounds * 1000) {
    process.stderr.write('too many conflicts');
    process.exit(3);
  }
  const run = store.getRun(runId);
  const result = await store.appendAsService(runId, run.version, null, [{ type: 'notice', level: 'info', message: 'child' }]);
  if (result.kind === 'ok') written += 1;
}
store.close();
`;

describe('writers in separate processes', () => {
  it('serialize through BEGIN IMMEDIATE and busy_timeout without losing or duplicating seq', async () => {
    const { dbPath, store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'parent');
    const scriptDir = makeStoreDir();
    const script = path.join(scriptDir, 'child.mjs');
    fs.writeFileSync(script, CHILD_SCRIPT);

    const child = spawn(process.execPath, [script, STORE_ENTRY, dbPath, run.id, String(ROUNDS)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    registerCleanup(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('ready')) resolve();
      });
      child.on('exit', () => reject(new Error(`child exited early: ${stderr}`)));
    });

    for (let index = 0; index < ROUNDS; index += 1) {
      expect(store.append(claim, [{ type: 'notice', level: 'info', message: 'parent' }]).kind).toBe('ok');
    }

    expect(await exited).toBe(0);
    expect(stderr).toBe('');
    const events = store.readRunEvents(run.id, 0, 10_000);
    expect(events).toHaveLength(1 + 2 * ROUNDS);
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 1 + 2 * ROUNDS }, (_value, index) => index + 1));
    for (let index = 1; index < events.length; index += 1) expect(events[index]!.id).toBeGreaterThan(events[index - 1]!.id);
    const messages = events.slice(1).map((event) => (event.type === 'notice' ? event.message : ''));
    expect(messages.filter((message) => message === 'parent')).toHaveLength(ROUNDS);
    expect(messages.filter((message) => message === 'child')).toHaveLength(ROUNDS);
  });
});
