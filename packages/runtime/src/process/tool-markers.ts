import path from 'node:path';
import { findHolders, reapMarkedProcesses } from '@momonga/foundation';
import type { ReapTiming } from '@momonga/foundation';
import { TERMINAL_STATUSES } from '@momonga/protocol';
import type { IdempotencyLookup, RuntimeStore } from '@momonga/store';
import { asError } from './as-error.ts';
import { nodeRuntimeFiles } from './runtime-files.ts';
import type { RuntimeFiles } from './runtime-files.ts';

const IDEMPOTENCY_KEY = /^[0-9a-f]{64}$/;

type ReapPlan = { marker: string; pgid?: number | undefined; terminalRunId?: string };

export type ReapToolMarkersScope = 'all' | { deadLetterOnly: true; skipKeys: ReadonlySet<string> };

type PendingLookup = Extract<IdempotencyLookup, { s: 'PENDING' }>;

const isTerminal = (status: string): boolean => (TERMINAL_STATUSES as readonly string[]).includes(status);

export type ReapToolMarkersOptions = {
  dir: string;
  store: Pick<RuntimeStore, 'idempotency' | 'getRun'>;
  scope?: ReapToolMarkersScope;
  killGraceMs: number;
  onWarning(message: string): void;
  timing?: ReapTiming;
  reap?: typeof reapMarkedProcesses;
  files?: RuntimeFiles;
};

export const reapToolMarkers = async ({
  dir,
  store,
  killGraceMs,
  onWarning,
  timing,
  reap = reapMarkedProcesses,
  scope = 'all',
  files = nodeRuntimeFiles,
}: ReapToolMarkersOptions): Promise<void> => {
  let names: string[];
  try {
    names = await files.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onWarning(`tool marker directory ${dir} could not be read: ${asError(error).message}`);
    return;
  }

  const deadLetteredRunOf = (lookup: PendingLookup, requireDeadLetter: boolean): string | undefined => {
    const runId = lookup.rec.meta['runId'];
    if (typeof runId !== 'string') return undefined;
    const run = store.getRun(runId);
    if (run === undefined || !isTerminal(run.status)) return undefined;
    if (requireDeadLetter && !run.deadLetter) return undefined;
    return runId;
  };

  const terminalRunPlan = (marker: string, lookup: PendingLookup, runId: string): ReapPlan => ({
    marker,
    pgid: lookup.rec.pgid,
    terminalRunId: runId,
  });

  const periodicPlanFor = (name: string, skipKeys: ReadonlySet<string>): ReapPlan | undefined => {
    if (!IDEMPOTENCY_KEY.test(name) || skipKeys.has(name)) return undefined;
    const lookup = store.idempotency.get(name);
    if (lookup?.s !== 'PENDING') return undefined;
    const runId = deadLetteredRunOf(lookup, true);
    return runId === undefined ? undefined : terminalRunPlan(path.join(dir, name), lookup, runId);
  };

  const planFor = async (name: string): Promise<ReapPlan | undefined> => {
    const marker = path.join(dir, name);
    let holders: number[];
    try {
      holders = await findHolders(marker);
    } catch (error) {
      onWarning(`tool marker ${marker} holders could not be determined: ${asError(error).message}`);
      return undefined;
    }
    if (holders.length === 0) {
      try {
        await files.unlink(marker);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onWarning(`tool marker ${marker} could not be removed: ${asError(error).message}`);
      }
      return undefined;
    }
    const lookup: IdempotencyLookup | undefined = IDEMPOTENCY_KEY.test(name) ? store.idempotency.get(name) : undefined;
    if (lookup?.s === 'PENDING') {
      const runId = deadLetteredRunOf(lookup, false);
      return runId === undefined ? undefined : terminalRunPlan(marker, lookup, runId);
    }
    if (lookup?.s === 'UNKNOWN') return { marker, pgid: lookup.rec.pgid };
    return { marker };
  };

  const planned =
    scope === 'all' ? await Promise.all(names.map(planFor)) : names.map((name) => periodicPlanFor(name, scope.skipKeys));
  const plans = planned.filter((plan): plan is ReapPlan => plan !== undefined);

  const outcomes = await Promise.allSettled(
    plans.map(({ marker, pgid }) =>
      reap({ marker, ...(pgid === undefined ? {} : { pgid }), killGraceMs, label: 'tool', onWarning, ...(timing === undefined ? {} : { timing }) }),
    ),
  );
  outcomes.forEach((outcome, index) => {
    const plan = plans[index];
    if (outcome.status === 'rejected') onWarning(`tool marker ${plan?.marker} could not be reaped: ${asError(outcome.reason).message}`);
    else if (plan?.terminalRunId !== undefined) onWarning(`tool marker ${plan.marker}: run ${plan.terminalRunId} is terminal, so its holder was reaped`);
  });
};
