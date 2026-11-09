import { readTextLimited } from '../adapters/shared/body-reading.ts';
import type { BoundedSendPorts } from './refresh.ts';

export type CappedOutcome = { kind: 'answered'; status: number; headers: Headers; body: string; truncated: boolean } | { kind: 'unanswered' };

const EMPTY_BODY: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: async function* () {} };

export const cappedSend = async (ports: BoundedSendPorts, url: string, init: RequestInit, boundMs: number, maxBytes: number): Promise<CappedOutcome> => {
  const fetchControl = new AbortController();
  const boundControl = new AbortController();
  const bound = ports.sleep(boundMs, boundControl.signal).then(
    (): 'elapsed' => 'elapsed',
    (error: unknown): 'cancelled' => {
      if (boundControl.signal.aborted) return 'cancelled';
      throw error;
    },
  );
  const sent = (async (): Promise<CappedOutcome> => {
    const response = await ports.fetch(url, { ...init, redirect: 'manual', signal: fetchControl.signal });
    const read = await readTextLimited((response.body as AsyncIterable<Uint8Array> | null) ?? EMPTY_BODY, maxBytes);
    return { kind: 'answered', status: response.status, headers: response.headers, body: read.text, truncated: read.truncated };
  })().catch((): CappedOutcome => ({ kind: 'unanswered' }));
  const outcome = await Promise.race([sent, bound.then((): CappedOutcome => ({ kind: 'unanswered' }))]);
  boundControl.abort();
  fetchControl.abort();
  await bound;
  return outcome;
};
