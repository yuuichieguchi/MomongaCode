import { GatewayError } from './errors.ts';
import type { GatewayTimers } from '../types.ts';

export type Release = () => void;

type Waiter = {
  grant: (release: Release) => void;
  timer: unknown;
  detach: () => void;
};

export type AdmissionGate = {
  acquire(signal: AbortSignal): Promise<Release>;
};

export type AdmissionGateOptions = {
  targetName: string;
  maxConcurrency: number;
  admissionTimeoutMs: number;
  timers: GatewayTimers;
};

export const createAdmissionGate = (options: AdmissionGateOptions): AdmissionGate => {
  const { targetName, maxConcurrency, admissionTimeoutMs, timers } = options;
  const retryAfterSeconds = Math.max(1, Math.ceil(admissionTimeoutMs / 1000));
  const queue: Waiter[] = [];
  let active = 0;

  const issue = (): Release => {
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const next = queue.shift();
      if (next === undefined) return;
      timers.clearTimeout(next.timer);
      next.detach();
      next.grant(issue());
    };
  };

  const timeoutError = (): GatewayError =>
    new GatewayError({
      status: 429,
      type: 'too_many_requests',
      code: 'admission_timeout',
      message: `target "${targetName}" has ${maxConcurrency} concurrent requests in flight; none finished within ${admissionTimeoutMs} ms`,
      headers: { 'retry-after': String(retryAfterSeconds) },
    });

  return {
    acquire: (signal) => {
      if (signal.aborted) return Promise.reject(signal.reason);
      if (active < maxConcurrency) return Promise.resolve(issue());
      return new Promise<Release>((resolve, reject) => {
        const waiter: Waiter = {
          grant: resolve,
          timer: undefined,
          detach: () => signal.removeEventListener('abort', onAbort),
        };
        const remove = (): void => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
        };
        const onAbort = (): void => {
          remove();
          timers.clearTimeout(waiter.timer);
          reject(signal.reason);
        };
        waiter.timer = timers.setTimeout(() => {
          remove();
          waiter.detach();
          reject(timeoutError());
        }, admissionTimeoutMs);
        signal.addEventListener('abort', onAbort, { once: true });
        queue.push(waiter);
      });
    },
  };
};
