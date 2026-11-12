import { Worker } from 'node:worker_threads';
import { isRuleVerdict } from '@momonga/protocol';
import type { ServiceTimers } from '../service/timers.ts';
import type { RuleVerification, RuleVerifyAbort, RuleVerifyJob } from './rule-verifier-thread.ts';

export type RuleVerifierThreadOptions = { readonly code: string; readonly timers: ServiceTimers; readonly startBoundMs: number; readonly onEntered?: () => void };

export class RuleVerificationFailure extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RuleVerificationFailure';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isEntered = (reply: unknown): boolean => isRecord(reply) && reply['entered'] === true;

const verificationOfReply = (reply: unknown): RuleVerification => {
  if (isRecord(reply) && reply['ok'] === false && typeof reply['reason'] === 'string') throw new RuleVerificationFailure(`the verification thread failed: ${reply['reason']}`);
  if (isRecord(reply) && reply['ok'] === true && isRuleVerdict(reply['verdict']) && typeof reply['report'] === 'string' && isRecord(reply['findings'])) {
    return { verdict: reply['verdict'], report: reply['report'], findings: reply['findings'] };
  }
  throw new RuleVerificationFailure('the verification thread gave a reply that is not a verdict');
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const verifyInThread = ({ code, timers, startBoundMs, onEntered }: RuleVerifierThreadOptions, job: RuleVerifyJob, signal: AbortSignal): Promise<RuleVerification> =>
  new Promise<RuleVerification>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(code, { eval: true, workerData: job });
    } catch (error) {
      reject(new RuleVerificationFailure(`the verification thread could not be started: ${messageOf(error)}`));
      return;
    }
    let ended = false;
    let startBound: unknown = timers.setTimeout(() => end(() => reject(new RuleVerificationFailure(`the verification thread did not start within ${startBoundMs} ms`))), startBoundMs);
    const clearStartBound = (): void => {
      if (startBound === undefined) return;
      timers.clearTimeout(startBound);
      startBound = undefined;
    };
    const end = (settle: () => void): void => {
      if (ended) return;
      ended = true;
      clearStartBound();
      signal.removeEventListener('abort', onAbort);
      worker.terminate().then(settle, reject);
    };
    const onAbort = (): void => {
      const told: RuleVerifyAbort = { abort: messageOf(signal.reason) };
      worker.postMessage(told);
      end(() => reject(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (reply: unknown) => {
      if (isEntered(reply)) {
        clearStartBound();
        onEntered?.();
        return;
      }
      end(() => {
        try {
          resolve(verificationOfReply(reply));
        } catch (error) {
          reject(error);
        }
      });
    });
    worker.on('error', (error: unknown) => end(() => reject(new RuleVerificationFailure(`the verification thread failed: ${messageOf(error)}`))));
    worker.on('exit', (exitCode: number) => end(() => reject(new RuleVerificationFailure(`the verification thread exited with code ${exitCode} before it gave a verdict`))));
  });
