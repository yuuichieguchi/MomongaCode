import { Worker } from 'node:worker_threads';
import { evaluateWithPatternAnswers, patternQueryKey } from '@momonga/ata-validator/lite';
import type { PatternQuery } from '@momonga/ata-validator/lite';

export const PATTERN_CHECK_LIMIT_MS = 5000;

export type PatternCheckOptions = { readonly signal?: AbortSignal; readonly patternCheckLimitMs?: number };

export type PatternChecked<T> =
  | { readonly kind: 'checked'; readonly value: T }
  | { readonly kind: 'not-checked'; readonly input: string; readonly limitMs: number }
  | { readonly kind: 'stopped' };

type Round = { readonly kind: 'answered'; readonly matched: readonly boolean[] } | { readonly kind: 'limit'; readonly answered: number } | { readonly kind: 'stopped' };

const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
for (let index = 0; index < workerData.queries.length; index++) {
  const query = workerData.queries[index];
  parentPort.postMessage({ index, matched: new RegExp(query.source, query.flags).test(query.input) });
}
`;

type Reply = { readonly index: number; readonly matched: boolean };

const isReply = (message: unknown): message is Reply =>
  typeof message === 'object' && message !== null && typeof (message as Reply).index === 'number' && typeof (message as Reply).matched === 'boolean';

const roundInWorker = async (queries: readonly PatternQuery[], signal: AbortSignal | undefined, limit: AbortSignal): Promise<Round> => {
  const worker = new Worker(WORKER_CODE, { eval: true, workerData: { queries } });
  const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
  const matched: boolean[] = [];
  const stop = new AbortController();
  const relay = (): void => stop.abort();
  signal?.addEventListener('abort', relay, { once: true });
  limit.addEventListener('abort', relay, { once: true });
  if (signal?.aborted === true || limit.aborted) relay();
  try {
    return await new Promise<Round>((resolve, reject) => {
      const settleOnStop = (): void => resolve(signal?.aborted === true ? { kind: 'stopped' } : { kind: 'limit', answered: matched.length });
      if (stop.signal.aborted) return settleOnStop();
      stop.signal.addEventListener('abort', settleOnStop, { once: true });
      worker.on('message', (message: unknown) => {
        if (!isReply(message)) return reject(new TypeError('the pattern check worker sent an unexpected message'));
        matched[message.index] = message.matched;
        if (matched.length === queries.length) resolve({ kind: 'answered', matched });
      });
      worker.once('error', reject);
      worker.once('exit', () => reject(new Error('the pattern check worker ended before it answered every query')));
    });
  } finally {
    signal?.removeEventListener('abort', relay);
    limit.removeEventListener('abort', relay);
    await worker.terminate();
    await exited;
  }
};

export const checkWithPatterns = async <T>(pass: (answers: ReadonlyMap<string, boolean>) => T, options: PatternCheckOptions = {}): Promise<PatternChecked<T>> => {
  const limitMs = options.patternCheckLimitMs ?? PATTERN_CHECK_LIMIT_MS;
  const answers = new Map<string, boolean>();
  let attempt = evaluateWithPatternAnswers(answers, () => pass(answers));
  if (attempt.queries.length === 0) return { kind: 'checked', value: attempt.value };
  const limit = new AbortController();
  const timer = setTimeout(() => limit.abort(), limitMs);
  try {
    while (attempt.queries.length > 0) {
      if (options.signal?.aborted === true) return { kind: 'stopped' };
      const round = await roundInWorker(attempt.queries, options.signal, limit.signal);
      if (round.kind === 'stopped') return round;
      if (round.kind === 'limit') return { kind: 'not-checked', input: (attempt.queries[round.answered] as PatternQuery).input, limitMs };
      attempt.queries.forEach((query, index) => answers.set(patternQueryKey(query), round.matched[index] as boolean));
      attempt = evaluateWithPatternAnswers(answers, () => pass(answers));
    }
    return { kind: 'checked', value: attempt.value };
  } finally {
    clearTimeout(timer);
  }
};
