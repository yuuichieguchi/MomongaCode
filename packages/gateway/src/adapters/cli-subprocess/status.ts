import type { PlanProfileExternalCli } from '@momonga/config';
import { isRecord } from '@momonga/foundation';
import { usableUpstreamJson } from '../shared/upstream-json.ts';

export type ExternalCliStatus =
  | { state: 'active'; email?: string }
  | { state: 'missing'; cause: string }
  | { state: 'not_signed_in'; cause: string };

export type ExternalCliExecResult =
  | { kind: 'missing' }
  | { kind: 'exited'; code: number | null; stdout: string; stderr: string };

export type ExternalCliStatusExec = (command: string, args: readonly string[], signal: AbortSignal) => Promise<ExternalCliExecResult>;

const NOT_SIGNED_IN_PATTERN = /not\s+logged\s+in|logged\s+out|unauthenticated|sign\s+in/i;

export const parseExternalCliStatus = (cli: PlanProfileExternalCli, result: ExternalCliExecResult): ExternalCliStatus => {
  if (result.kind === 'missing') return { state: 'missing', cause: cli.installHint };
  const trimmed = result.stdout.trim();
  if (trimmed.startsWith('{')) {
    const parsed: unknown = usableUpstreamJson(trimmed);
    if (isRecord(parsed)) {
      if (parsed['loggedIn'] === false) {
        return { state: 'not_signed_in', cause: `Not signed in; run ${cli.loginCommand}` };
      }
      if (parsed['loggedIn'] === true) {
        const email = typeof parsed['email'] === 'string' && parsed['email'] !== '' ? parsed['email'] : undefined;
        return email === undefined ? { state: 'active' } : { state: 'active', email };
      }
    }
  }
  if (result.code !== 0 || NOT_SIGNED_IN_PATTERN.test(`${result.stdout}\n${result.stderr}`)) {
    return { state: 'not_signed_in', cause: `Not signed in; run ${cli.loginCommand}` };
  }
  return { state: 'active' };
};

export const checkExternalCliStatus = async (
  cli: PlanProfileExternalCli,
  signal: AbortSignal,
  exec: ExternalCliStatusExec,
): Promise<ExternalCliStatus> => parseExternalCliStatus(cli, await exec(cli.command, cli.statusArgs, signal));
