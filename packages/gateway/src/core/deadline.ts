import { deadlineExceededError, invalidRequest } from './errors.ts';
import type { Services } from './services.ts';

export const parseDeadlineHeader = (header: string | undefined, nowMs: number): number | undefined => {
  if (header === undefined) return undefined;
  if (!/^[1-9]\d{0,14}$/.test(header)) {
    throw invalidRequest('invalid_deadline', `momonga-deadline-ms must be a positive integer number of milliseconds, got "${header}"`);
  }
  return nowMs + Number(header);
};

export const armDeadline = (services: Services, deadlineAt: number | undefined, abort: (reason: unknown) => void): (() => void) => {
  if (deadlineAt === undefined) return () => undefined;
  const handle = services.timers.setTimeout(
    () => abort(deadlineExceededError('the request deadline passed before the response completed')),
    Math.max(0, deadlineAt - services.clock.now()),
  );
  return () => services.timers.clearTimeout(handle);
};

export const withDeadline = async <T>(
  services: Services,
  deadlineAt: number | undefined,
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  if (deadlineAt === undefined) return run(signal);
  const controller = new AbortController();
  const disarm = armDeadline(services, deadlineAt, (reason) => controller.abort(reason));
  try {
    return await run(AbortSignal.any([signal, controller.signal]));
  } finally {
    disarm();
  }
};
