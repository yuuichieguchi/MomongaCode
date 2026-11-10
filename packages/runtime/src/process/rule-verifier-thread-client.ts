import { Worker } from 'node:worker_threads';
import { isRuleVerdict } from '@momonga/protocol';
import type { RuleVerdict } from '@momonga/protocol';
import type { ServiceTimers } from '../service/timers.ts';
import type { RuleVerifyJob } from './rule-verifier-thread.ts';

export type RuleVerifierThreadOptions = { readonly code: string; readonly timers: ServiceTimers };

export const WHOLE_VERIFICATION = 'verification';

const undecided = (job: RuleVerifyJob, reason: string): RuleVerdict => ({ verdict: 'unknown', solver: job.solverVersion, refuted: [], unknown: [{ property: WHOLE_VERIFICATION, reason }], notProved: [] });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const verdictOfReply = (job: RuleVerifyJob, reply: unknown): RuleVerdict => {
  if (isRecord(reply) && reply['ok'] === false && typeof reply['reason'] === 'string') return undecided(job, `the verification thread failed: ${reply['reason']}`);
  if (isRecord(reply) && reply['ok'] === true && isRuleVerdict(reply['verdict'])) return reply['verdict'];
  return undecided(job, 'the verification thread gave a reply that is not a verdict');
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const verifyInThread = ({ code, timers }: RuleVerifierThreadOptions, job: RuleVerifyJob, signal: AbortSignal): Promise<RuleVerdict> =>
  new Promise<RuleVerdict>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(code, { eval: true, workerData: job });
    } catch (error) {
      resolve(undecided(job, `the verification thread could not be started: ${messageOf(error)}`));
      return;
    }
    let ended = false;
    const end = (settle: () => void): void => {
      if (ended) return;
      ended = true;
      timers.clearTimeout(budget);
      signal.removeEventListener('abort', onAbort);
      worker.terminate().then(settle, reject);
    };
    const onAbort = (): void => end(() => reject(signal.reason));
    const budget = timers.setTimeout(() => end(() => resolve(undecided(job, `the verification budget of ${job.budgetMs} ms was spent`))), job.budgetMs);
    signal.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (reply: unknown) => end(() => resolve(verdictOfReply(job, reply))));
    worker.on('error', (error: unknown) => end(() => resolve(undecided(job, `the verification thread failed: ${messageOf(error)}`))));
    worker.on('exit', (exitCode: number) => end(() => resolve(undecided(job, `the verification thread exited with code ${exitCode} before it gave a verdict`))));
  });
