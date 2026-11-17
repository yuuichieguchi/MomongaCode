import { describe, expect, it } from 'vitest';
import { buildRunReport } from '@momonga/observability';
import type { RunEventPayload } from '@momonga/protocol';
import type { ContributionPreparer, RuntimeStore } from '@momonga/store';
import { journalReaderPreparer } from '../worker/harness.ts';
import { LARGE_RUN_SETUP_TEST_TIMEOUT_MS } from '../worker/pause-budget.ts';
import { startService } from './helpers.ts';

const SIZES = [15, 50, 150] as const;
const OUTPUT_CHARS = 30_000;
const READ_CHUNK = 1000;

const asPayload = (value: Record<string, unknown>): RunEventPayload => value as unknown as RunEventPayload;

const output = `${'src/module/file.ts handler '.repeat(OUTPUT_CHARS / 2 / 27)}${'設定ファイルの読み込みに失敗しました。'.repeat(OUTPUT_CHARS / 2 / 19)}`;

const stepEvents = (step: number): RunEventPayload[] => {
  const callId = `call_${step}`;
  return [
    asPayload({ type: 'model.requested', step, attempt: 1, digest: `digest-${step}`, body: { model: 'fm', input: [{ type: 'function_call_output', call_id: `call_${step - 1}`, output }] } }),
    asPayload({ type: 'tool.call', callId, providerCallId: callId, name: 'Write', kind: 'edit', sideEffect: 'write', title: 'Write', rawInput: { file_path: `/w/file-${step % 5}.txt`, content: output } }),
    asPayload({ type: 'tool.started', callId, idemKey: `key-${callId}`, basis: 'rule' }),
    asPayload({ type: 'tool.completed', callId, status: 'completed', output, files: [{ path: `/w/file-${step % 5}.txt`, sha256: String(step % 10).repeat(64), access: 'write' }] }),
  ];
};

const inlineControl = (dbPath: string, store: () => RuntimeStore): ContributionPreparer => ({
  ...journalReaderPreparer(dbPath),
  report: async ({ runId }) => {
    const events = [];
    for (let after = 0; ; ) {
      const chunk = store().readRunEvents(runId, after, READ_CHUNK);
      events.push(...chunk);
      const last = chunk.at(-1);
      if (last === undefined || chunk.length < READ_CHUNK) break;
      after = last.seq;
    }
    const run = store().getRun(runId);
    if (run === undefined) throw new Error(`run ${runId} does not exist`);
    return { lastSeq: events.at(-1)?.seq ?? 0, report: buildRunReport(events), run };
  },
});

type Counts = { rows: number; bytes: number; mutatingCalls: number };

const countsOf = async (steps: number, path: 'thread' | 'inline', read: 'get' | 'cancel' | 'replay'): Promise<Counts> => {
  const counting = { on: false, rows: 0, bytes: 0 };
  const env = await startService({
    ...(path === 'inline' ? { preparer: inlineControl } : {}),
    onDecode: (rows, bytes) => {
      if (!counting.on) return;
      counting.rows += rows;
      counting.bytes += bytes;
    },
  });
  const session = await env.createSession();
  const run = await env.createRun(session.id, {}, { 'idempotency-key': 'key-1' });
  const claim = env.claimRun(run.id);
  env.append(claim, [asPayload({ type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'manual' })]);
  for (let step = 1; step <= steps; step += 1) env.append(claim, stepEvents(step));

  counting.on = true;
  const response =
    read === 'get'
      ? await env.http('GET', `/v1/runs/${run.id}`)
      : read === 'cancel'
        ? await env.http('POST', `/v1/runs/${run.id}/cancel`)
        : await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'Say hello' }, headers: { 'idempotency-key': 'key-1' } });
  counting.on = false;

  expect([200, 202]).toContain(response.status);
  return { rows: counting.rows, bytes: counting.bytes, mutatingCalls: response.json.run.report.changes.mutatingCalls };
};

describe('the loop share of the run report in a run view, as counts (design section 7; inventory row 23)', () => {
  it.each(['get', 'cancel', 'replay'] as const)('decodes no journal payload on the main thread at 15, 50 and 150 steps when the journal thread folds the report (%s)', async (read) => {
    const counts: Counts[] = [];
    for (const steps of SIZES) counts.push(await countsOf(steps, 'thread', read));

    expect(counts.map((count) => [count.rows, count.bytes])).toEqual(SIZES.map(() => [0, 0]));
    expect(counts.map((count) => count.mutatingCalls)).toEqual([...SIZES]);
  }, LARGE_RUN_SETUP_TEST_TIMEOUT_MS);

  it('control: a report folded through the store on the main thread decodes rows and bytes that grow with the run', async () => {
    const counts: Counts[] = [];
    for (const steps of SIZES) counts.push(await countsOf(steps, 'inline', 'get'));

    expect(counts[0]?.rows ?? 0).toBeGreaterThan(0);
    for (let index = 1; index < counts.length; index += 1) {
      expect(counts[index]?.rows ?? 0).toBeGreaterThan(counts[index - 1]?.rows ?? 0);
      expect(counts[index]?.bytes ?? 0).toBeGreaterThan(counts[index - 1]?.bytes ?? 0);
    }
  }, LARGE_RUN_SETUP_TEST_TIMEOUT_MS);
});
