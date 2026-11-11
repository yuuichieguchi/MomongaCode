import { Worker } from 'node:worker_threads';
import { isRuleVerdict } from '@momonga/protocol';
import type { ServiceTimers } from '../service/timers.ts';
import type { RuleVerification, RuleVerifyAbort, RuleVerifyJob } from './rule-verifier-thread.ts';

export type RuleVerifierThreadOptions = { readonly code: string; readonly timers: ServiceTimers; readonly loadAllowanceMs: number };

export const WHOLE_VERIFICATION = 'verification';

const undecided = (job: RuleVerifyJob, reason: string): RuleVerification => ({
  verdict: { verdict: 'unknown', solver: job.solverVersion, refuted: [], unknown: [{ property: WHOLE_VERIFICATION, reason }], notProved: [] },
  report: `The rules were not verified: ${reason}`,
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const verificationOfReply = (job: RuleVerifyJob, reply: unknown): RuleVerification => {
  if (isRecord(reply) && reply['ok'] === false && typeof reply['reason'] === 'string') return undecided(job, `the verification thread failed: ${reply['reason']}`);
  if (isRecord(reply) && reply['ok'] === true && isRuleVerdict(reply['verdict']) && typeof reply['report'] === 'string') return { verdict: reply['verdict'], report: reply['report'] };
  return undecided(job, 'the verification thread gave a reply that is not a verdict');
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const verifyInThread = ({ code, timers, loadAllowanceMs }: RuleVerifierThreadOptions, job: RuleVerifyJob, signal: AbortSignal): Promise<RuleVerification> =>
  new Promise<RuleVerification>((resolve, reject) => {
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
      timers.clearTimeout(bound);
      signal.removeEventListener('abort', onAbort);
      worker.terminate().then(settle, reject);
    };
    const onAbort = (): void => {
      const told: RuleVerifyAbort = { abort: messageOf(signal.reason) };
      worker.postMessage(told);
      end(() => reject(signal.reason));
    };
    const boundMs = job.budgetMs + loadAllowanceMs;
    const bound = timers.setTimeout(
      () => end(() => resolve(undecided(job, `the verification thread gave no verdict within ${boundMs} ms, the verification budget of ${job.budgetMs} ms and ${loadAllowanceMs} ms to load the solver`))),
      boundMs,
    );
    signal.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (reply: unknown) => end(() => resolve(verificationOfReply(job, reply))));
    worker.on('error', (error: unknown) => end(() => resolve(undecided(job, `the verification thread failed: ${messageOf(error)}`))));
    worker.on('exit', (exitCode: number) => end(() => resolve(undecided(job, `the verification thread exited with code ${exitCode} before it gave a verdict`))));
  });
