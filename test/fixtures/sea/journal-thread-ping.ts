import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { migrateRuntimeDatabase } from '@momonga/store';
import { startJournalThread } from '../../../packages/runtime/src/memory/journal-thread-client.ts';
import { JOURNAL_THREAD_CODE } from '../../../packages/runtime/src/memory/journal-thread-code.generated.ts';
import { testKernelLock } from '@momonga/testkit';

const PING_SILENCE_MS = 30_000;

const directory = process.argv[2];
if (directory === undefined) throw new Error('usage: journal-thread-ping <private directory>');
const databasePath = path.join(directory, 'runtime.db');
migrateRuntimeDatabase(databasePath);
const stat = fs.statSync(databasePath);
const client = await startJournalThread({ lock: testKernelLock(), databasePath, identity: { dev: stat.dev, ino: stat.ino }, silenceLimitMs: PING_SILENCE_MS });
try {
  const pong = await client.ping();
  const codeSha256 = createHash('sha256').update(JOURNAL_THREAD_CODE).digest('hex');
  process.stdout.write(`${JSON.stringify({ pinged: pong.threadId > 0, codeSha256 })}\n`);
} finally {
  await client.close();
}
