import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const INPUT = `Write the two files. ${'Context the request body carries in full. '.repeat(400)}`;

describe('within one model step the recorded request body is decoded once across its readers (row 9)', () => {
  it('the readers of the latest recorded request decode each model.requested body at most once under the claim', async () => {
    const decodedBytes: number[] = [];
    const latestReads = { inside: false, calls: 0 };
    const env = await makeEnv({
      mode: 'bypassPermissions',
      onDecode: (_rows, bytes) => {
        if (latestReads.inside) decodedBytes.push(bytes);
      },
    });
    const uncachedRead = env.store.readLatestRunEventBefore.bind(env.store);
    Object.assign(env.store, {
      readLatestRunEventBefore: (...args: Parameters<typeof uncachedRead>) => {
        latestReads.inside = true;
        latestReads.calls += 1;
        try {
          return uncachedRead(...args);
        } finally {
          latestReads.inside = false;
        }
      },
    });
    const run = await env.enqueue(INPUT);
    env.gateway.script.push(
      callsStep([{ callId: 'call_once_1', name: 'Write', args: { file_path: `${env.project}/one.txt`, content: 'one' } }]),
      callsStep([{ callId: 'call_once_2', name: 'Write', args: { file_path: `${env.project}/two.txt`, content: 'two' } }]),
      textStep('Both written.'),
    );

    const worker = env.worker('worker-once');
    while ((await env.runOnce(worker)) === 'yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(latestReads.calls).toBeGreaterThanOrEqual(4);
    const bodies = env
      .raw()
      .prepare("SELECT seq, payload_json FROM events WHERE run_id = :runId AND type = 'model.requested' ORDER BY seq")
      .all({ runId: run.id })
      .map((row) => ({ seq: Number(row['seq']), bytes: Buffer.byteLength(String(row['payload_json'])) }));
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((body) => body.bytes)).size).toBe(3);

    const decodesPerBody = Object.fromEntries(bodies.map((body) => [body.seq, decodedBytes.filter((bytes) => bytes === body.bytes).length]));
    expect(Object.values(decodesPerBody).every((count) => count <= 1), JSON.stringify(decodesPerBody)).toBe(true);
    expect(Object.values(decodesPerBody).some((count) => count === 1), JSON.stringify(decodesPerBody)).toBe(true);
  });
});
