import { selfInvocation } from '../daemon/launcher.ts';
import { UpdateError } from './errors.ts';
import { installRelease, resolveUpdateTarget } from './install.ts';
import type { UpdatePorts } from './ports.ts';
import { checkForUpdate } from './release.ts';
import type { BuildUpdateInputs, UpdateEndpoints } from './source.ts';
import { parseUpdateState } from './state.ts';
import type { BackgroundOutcome, UpdateState } from './state.ts';

export const UPDATE_CHECK_COMMAND = '__update-check';

export type UpdateWiring = {
  ports: UpdatePorts;
  build: BuildUpdateInputs;
  endpoints: UpdateEndpoints;
  checkIntervalMs: number;
};

const NOT_APPLICABLE_CODES: ReadonlySet<string> = new Set(['no_update_source', 'not_single_executable', 'unsupported_platform']);

const isApplicable = (wiring: UpdateWiring): boolean => {
  try {
    resolveUpdateTarget(wiring.ports, wiring.build, wiring.endpoints);
    return true;
  } catch (error) {
    if (error instanceof UpdateError && NOT_APPLICABLE_CODES.has(error.code)) return false;
    throw error;
  }
};

const readState = async (ports: UpdatePorts): Promise<UpdateState | undefined> => {
  const raw = await ports.state.read();
  return raw === undefined ? undefined : parseUpdateState(raw);
};

const noticeOf = (ports: UpdatePorts, state: UpdateState): string | undefined => {
  if (state.announced) return undefined;
  switch (state.outcome.kind) {
    case 'up_to_date':
      return undefined;
    case 'installed':
      return state.outcome.version === ports.version
        ? `momonga was updated to ${state.outcome.version} in the background`
        : `momonga ${state.outcome.version} was installed in the background; you are running ${ports.version}`;
    case 'failed':
      return `the background update check failed (${state.outcome.code}): ${state.outcome.message}; run \`momonga update\` for details`;
  }
};

const isDue = (state: UpdateState | undefined, now: number, intervalMs: number): boolean =>
  state === undefined || state.checkedAt > now || now - state.checkedAt >= intervalMs;

export const startBackgroundCheck = async (wiring: UpdateWiring): Promise<void> => {
  const { ports } = wiring;
  if (!isApplicable(wiring)) return;
  if (!(await ports.autoUpdates())) return;
  const state = await readState(ports);
  if (state !== undefined) {
    const notice = noticeOf(ports, state);
    if (notice !== undefined) {
      ports.stderr.write(`momonga: ${notice}\n`);
      await ports.state.write({ ...state, announced: true });
    }
  }
  if (!isDue(state, ports.clock.now(), wiring.checkIntervalMs)) return;
  const invocation = selfInvocation(ports.self, UPDATE_CHECK_COMMAND);
  const child = ports.spawnDetached({ command: invocation.command, args: invocation.args, env: ports.env, cwd: ports.home });
  void child.exit.then(undefined, (error: unknown) => {
    ports.stderr.write(`momonga: the background update check could not run: ${error instanceof Error ? error.message : String(error)}\n`);
  });
};

const recordOutcome = (ports: UpdatePorts, checkedAt: number, outcome: BackgroundOutcome): Promise<void> =>
  ports.state.write({ checkedAt, outcome, announced: outcome.kind === 'up_to_date' } satisfies UpdateState);

const failureOutcome = (error: unknown): BackgroundOutcome => ({
  kind: 'failed',
  code: error instanceof UpdateError ? error.code : 'unexpected',
  message: error instanceof Error ? error.message : String(error),
});

const checkAndInstall = async (wiring: UpdateWiring, signal: AbortSignal): Promise<BackgroundOutcome> => {
  const { ports } = wiring;
  const target = resolveUpdateTarget(ports, wiring.build, wiring.endpoints);
  const check = await checkForUpdate(ports, target.source, signal);
  if (check.kind !== 'available') return { kind: 'up_to_date' };
  const result = await installRelease(ports, target, check.latest, { restartDaemon: false, signal });
  return { kind: 'installed', version: result.to };
};

export const runBackgroundCheck = async (wiring: UpdateWiring, signal: AbortSignal): Promise<number> => {
  const { ports } = wiring;
  const checkedAt = ports.clock.now();
  let outcome: BackgroundOutcome;
  try {
    outcome = await checkAndInstall(wiring, signal);
  } catch (error) {
    if (error instanceof UpdateError && error.code === 'update_in_progress') return 0;
    await recordOutcome(ports, checkedAt, failureOutcome(error));
    throw error;
  }
  await recordOutcome(ports, checkedAt, outcome);
  return 0;
};
