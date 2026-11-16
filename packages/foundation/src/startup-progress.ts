import type { JsonLogger, TextStream } from './process-contract.ts';

export type ProgressFields = { service: string; pid: number; step: string };

export type StartupStep = <T>(name: string, run: () => T | Promise<T>) => Promise<T>;

export const announceProgress = (fields: ProgressFields, stream: TextStream): void => {
  const { service, pid, step } = fields;
  stream.write(`${JSON.stringify({ event: 'progress', service, pid, step })}\n`);
};

export const parseProgressLine = (line: string): ProgressFields | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const { event, service, pid, step } = parsed as Record<string, unknown>;
  if (event !== 'progress') return undefined;
  if (typeof service !== 'string' || typeof step !== 'string') return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid)) return undefined;
  return { service, pid, step };
};

export const startupSteps =
  (options: { service: string; pid: number; stream: TextStream; logger: JsonLogger; signal: AbortSignal | undefined }): StartupStep =>
  async (name, run) => {
    options.signal?.throwIfAborted();
    options.logger.debug('startup.step', { step: name });
    announceProgress({ service: options.service, pid: options.pid, step: name }, options.stream);
    return run();
  };
