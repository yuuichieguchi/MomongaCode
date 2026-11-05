import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

const { decodeRunEvents } = await import('../../packages/store/src/codec.ts');
const { foldRunState, initialRunState } = await import('../../packages/store/src/fold.ts');
const { tokensOf, hasToken, CHUNK_CHARS } = await import('../../packages/memory/src/contribution.ts');

const MIB = 1024 * 1024;
const REPEATS = 5;
const SQLITE_MAX_LENGTH = 1_000_000_000;

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

const max = (samples: number[]): number => Math.max(...samples);

const longestGap = (run: (unit: () => void) => void): number => {
  let last = performance.now();
  let longest = 0;
  run(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  });
  return Math.max(longest, performance.now() - last);
};

const respondedRow = (text: string) => ({
  id: 5, run_id: 'r1', session_id: 's1', seq: 5, step: 1, lease_token: 1, created_at: 1, type: 'model.responded',
  payload_json: JSON.stringify({
    type: 'model.responded', step: 1, attempt: 1,
    response: { status: 'completed', output: [{ type: 'message', id: 'm1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  }),
});

console.log(`load ${os.loadavg().map((n) => n.toFixed(1)).join(' ')}  ${os.cpus()[0]?.model}`);
console.log(`V8 maximum string length ${constants.MAX_STRING_LENGTH} chars; SQLite maximum length ${SQLITE_MAX_LENGTH} bytes (product does not lower it)`);
console.log(`bound: ASCII ${Math.min(constants.MAX_STRING_LENGTH, SQLITE_MAX_LENGTH)} chars; Japanese ${Math.min(constants.MAX_STRING_LENGTH, Math.floor(SQLITE_MAX_LENGTH / 3))} chars (${SQLITE_MAX_LENGTH} bytes)`);

for (const [label, make] of [['ascii', ascii], ['japanese', japanese]] as const) {
  for (const size of [16, 64, 128]) {
    const text = make(size * MIB);
    const row = respondedRow(text);
    const decode: number[] = [];
    const fold: number[] = [];
    for (let i = 0; i < REPEATS; i += 1) {
      decode.push(time(() => decodeRunEvents([row])).ms);
      const [event] = decodeRunEvents([row]);
      if (event === undefined) throw new Error('the row did not decode');
      fold.push(time(() => foldRunState(initialRunState({ runId: 'r1', sessionId: 's1' }), event)).ms);
    }
    console.log(`${label} ${size} MiB row: decode max ${max(decode).toFixed(1)} ms (${(max(decode) / size).toFixed(3)} ms/MiB), fold max ${max(fold).toFixed(1)} ms`);
  }
}

for (const [label, make] of [['ascii', ascii], ['japanese', japanese]] as const) {
  const text = make(16 * MIB);
  const tokens: number[] = [];
  const scans: number[] = [];
  for (let i = 0; i < REPEATS; i += 1) {
    tokens.push(longestGap((unit) => tokensOf(text, unit)));
    scans.push(longestGap((unit) => hasToken(text, 'neverpresentidentifier', unit)));
  }
  console.log(`${label} 16 MiB text, chunk ${CHUNK_CHARS} chars: longest gap between units: tokensOf ${max(tokens).toFixed(1)} ms, hasToken ${max(scans).toFixed(1)} ms`);
}

for (const size of [16, 64, 128]) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, run_id TEXT, payload_json TEXT)');
  const body = { model: 'fm', input: [{ type: 'message', role: 'system', content: 'sys' }, { type: 'message', role: 'user', content: ascii(size * MIB) }], tools: [], tool_choice: 'auto' };
  db.prepare("INSERT INTO events (run_id, payload_json) VALUES ('r1', ?)").run(JSON.stringify({ type: 'model.requested', step: 1, attempt: 1, digest: 'd', body }));
  const sql = `SELECT json_object('body',json_object('input', json((SELECT json_group_array(json(json_extract(x.j, t.path))) FROM json_tree(x.j, '$.body.input') AS t WHERE t.key = 'role' AND t.atom IN ('system','developer') AND t.path GLOB '$.body.input[[]*]' AND t.path NOT GLOB '*.*.*.*')))) AS p FROM (SELECT jsonb(e.payload_json) AS j FROM events e) AS x`;
  const samples: number[] = [];
  for (let i = 0; i < REPEATS; i += 1) samples.push(time(() => db.prepare(sql).all()).ms);
  console.log(`sqlite pinned-layer projection of a ${size} MiB model.requested: max ${max(samples).toFixed(1)} ms (${(max(samples) / size).toFixed(3)} ms/MiB)`);
  db.close();
}
