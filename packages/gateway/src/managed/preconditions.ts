import type { ManagedServerDescription, Precondition } from '@momonga/protocol';
import type { PreconditionVerdict } from '../probe/auto-probe.ts';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  signal: AbortSignal;
}

export type ExecFn = (file: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

export type RefusedVerdict = Extract<PreconditionVerdict, { kind: 'refused' }>;

export const outputOf = (result: ExecResult): string => `${result.stdout}\n${result.stderr}`.trim();

const argvText = (precondition: Precondition): string => precondition.argv.join(' ');

export class PreconditionCancelledError extends Error {
  constructor(precondition: Precondition, cause: unknown) {
    super(`the precondition "${argvText(precondition)}" was cancelled before it answered`, { cause });
    this.name = 'PreconditionCancelledError';
  }
}

const verdictOf = (precondition: Precondition, result: ExecResult): PreconditionVerdict => {
  const rule = precondition.rules.find((candidate) => ('exitCode' in candidate ? candidate.exitCode === result.exitCode : false)) ?? precondition.rules.find((candidate) => 'otherExit' in candidate);
  if (rule === undefined) {
    return { kind: 'refused', message: `the precondition "${argvText(precondition)}" exited with ${result.exitCode}, which its description does not cover`, detail: outputOf(result), remedy: undefined };
  }
  if (rule.verdict === 'met') return { kind: 'met' };
  return { kind: 'refused', message: rule.message, detail: outputOf(result), remedy: 'remedy' in rule ? rule.remedy : undefined };
};

export const runPreconditions = async (description: ManagedServerDescription, binary: string, exec: ExecFn, signal: AbortSignal): Promise<PreconditionVerdict> => {
  for (const precondition of description.preconditions) {
    let result: ExecResult;
    try {
      result = await exec(binary, precondition.argv, { signal });
    } catch (error) {
      if (signal.aborted) throw new PreconditionCancelledError(precondition, error);
      throw error;
    }
    const verdict = verdictOf(precondition, result);
    if (verdict.kind === 'refused') return verdict;
  }
  return { kind: 'met' };
};

export const notReadyText = (target: string, message: string): string => `the model "${target}" is not ready: ${message}`;

export const MISSING_EXECUTABLE_MESSAGE = 'the executable is missing';

export const missingExecutableVerdict = (target: string, binary: string): RefusedVerdict => ({
  kind: 'refused',
  message: MISSING_EXECUTABLE_MESSAGE,
  detail: `the model "${target}": the executable was not found at ${binary}`,
  remedy: undefined,
});
