import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

const { decodeRunEvents } = await import('../../packages/store/src/codec.ts');
const { foldRunState, initialRunState } = await import('../../packages/store/src/fold.ts');
const { tokensOf, hasToken } = await import('../../packages/memory/src/contribution.ts');

const MB = 1024 * 1024;
const REPEATS = 7;

const ascii = (bytes: number): string => {
  const line = 'line-0001234 src/module/file.ts handler export const value = compute(argument) // note\n';
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
};
const japanese = (bytes: number): string => {
  const unit = '設定ファイルの読み込みに失敗しました。';
  const chars = Math.floor(bytes / 3);
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
};

const time = <T>(fn: () => T): { ms: number; value: T } => {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
};

const stats = (samples: number[]): string => {
  const sorted = [...samples].sort((a, b) => a - b);
  return `median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)} ms, max ${sorted.at(-1)!.toFixed(1)} ms`;
};

const rowOf = (payload: object, type: string, seq: number) => ({
  id: seq, run_id: 'r1', session_id: 's1', seq, step: 1, lease_token: 1, created_at: 1, type, payload_json: JSON.stringify(payload),
});

const respondedOf = (text: string) => ({
  type: 'model.responded', step: 1, attempt: 1,
  response: { status: 'completed', output: [{ type: 'message', id: 'm1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
});

console.log(`load ${os.loadavg().map((n) => n.toFixed(1)).join(' ')}  cpus ${os.cpus().length} ${os.cpus()[0]?.model}`);
for (const [label, make] of [['ascii', ascii], ['japanese', japanese]] as const) {
  for (const size of [1, 4, 16]) {
    const text = make(size * MB);
    const payload = respondedOf(text);
    const row = rowOf(payload, 'model.responded', 5);
    const decode: number[] = [];
    const fold: number[] = [];
    const tokens: number[] = [];
    const scan: number[] = [];
    for (let i = 0; i < REPEATS; i += 1) {
      decode.push(time(() => decodeRunEvents([row])).ms);
      const [event] = decodeRunEvents([row]);
      if (event === undefined) throw new Error('the row did not decode');
      fold.push(time(() => foldRunState(initialRunState({ runId: 'r1', sessionId: 's1' }), event)).ms);
      tokens.push(time(() => tokensOf(text)).ms);
      scan.push(time(() => hasToken(text, 'neverpresentidentifier')).ms);
    }
    console.log(`${label} ${size} MB event: decode ${stats(decode)} | fold ${stats(fold)} | tokensOf ${stats(tokens)} | hasToken scan ${stats(scan)}`);
  }
}

for (const size of [1, 4, 16]) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT, ordinal INTEGER, status TEXT, version INTEGER, lease_owner TEXT, lease_token INTEGER, lease_expires_at INTEGER, available_at INTEGER, created_at INTEGER, attempts INTEGER, failed_attempts INTEGER, cancel_requested INTEGER, dead_letter INTEGER, deadline_at INTEGER, limits_json TEXT, pins TEXT, step INTEGER, last_seq INTEGER, usage_json TEXT, previous_run_id TEXT, history_mode TEXT, parent_run_id TEXT, parent_call_id TEXT, origin TEXT, cancel_origin TEXT, stop_reason TEXT, error_json TEXT);
  CREATE TABLE events (id INTEGER PRIMARY KEY, run_id TEXT, session_id TEXT, seq INTEGER, step INTEGER, lease_token INTEGER, created_at INTEGER, type TEXT, payload_json TEXT, pinned_digest TEXT);`);
  const body = { model: 'fm', input: [{ type: 'message', role: 'system', content: 'sys' }, { type: 'message', role: 'user', content: ascii(size * MB) }], tools: [], tool_choice: 'auto' };
  db.prepare("INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json, pinned_digest) VALUES ('r1','s1',1,1,1,1,'model.requested',?, 'd1')").run(JSON.stringify({ type: 'model.requested', step: 1, attempt: 1, digest: 'd', body }));
  const sql = `SELECT json_object('type','model.requested','step',json_extract(x.j,'$.step'),'body',json_object('input', json((SELECT json_group_array(json(json_extract(x.j, t.path))) FROM json_tree(x.j, '$.body.input') AS t WHERE t.key = 'role' AND t.atom IN ('system','developer') AND t.path GLOB '$.body.input[[]*]' AND t.path NOT GLOB '*.*.*.*')))) AS p FROM (SELECT jsonb(e.payload_json) AS j FROM events e) AS x`;
  const samples: number[] = [];
  for (let i = 0; i < REPEATS; i += 1) samples.push(time(() => db.prepare(sql).all()).ms);
  console.log(`sqlite pinned-layer projection of a ${size} MB model.requested: ${stats(samples)}`);
  db.close();
}
