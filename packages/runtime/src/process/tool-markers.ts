import path from 'node:path';
import { claimRetry, operationSignal, readMarkerGroup, reapMarkedProcesses, unreadableMarkerNotice } from '@momonga/foundation';
import type { MarkerMode, MarkerState, ProcessInspector, ReapTiming, RetryKind, UninspectableRegistry } from '@momonga/foundation';
import { TERMINAL_STATUSES } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { createMarkerSettle, unownedOf } from '@momonga/tools';
import type { MarkerOwners } from '@momonga/tools';
import { asError } from './as-error.ts';
import { nodeRuntimeFiles } from './runtime-files.ts';
import type { RuntimeFiles } from './runtime-files.ts';

const IDEMPOTENCY_KEY = /^[0-9a-f]{64}$/;

const isTerminal = (status: string): boolean => (TERMINAL_STATUSES as readonly string[]).includes(status);

export type ReapToolMarkersOptions = {
  dir: string;
  store: Pick<RuntimeStore, 'idempotency' | 'getRun'>;
  event: Exclude<RetryKind, 'guard'>;
  owners: MarkerOwners;
  signal?: AbortSignal | undefined;
  killGraceMs: number;
  onWarning(message: string): void;
  timing?: ReapTiming;
  reap?: typeof reapMarkedProcesses;
  files?: RuntimeFiles;
  inspector?: ProcessInspector;
  uninspectable?: UninspectableRegistry;
};

export const reapToolMarkers = async ({
  dir,
  store,
  event,
  owners,
  killGraceMs,
  onWarning,
  timing,
  signal: given,
  reap = reapMarkedProcesses,
  files = nodeRuntimeFiles,
  inspector,
  uninspectable,
}: ReapToolMarkersOptions): Promise<void> => {
  const operation = operationSignal(given);
  try {
    await sweep(operation.signal);
  } finally {
    operation.end();
  }

  async function sweep(signal: AbortSignal): Promise<void> {
    let names: string[];
    try {
      names = await files.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onWarning(`tool marker directory ${dir} could not be read: ${asError(error).message}`);
      return;
    }

    type Plan = { marker: string; mode: MarkerMode; pgid: number | undefined; terminalRunId: string | undefined };

    const planOf = async (name: string): Promise<Plan | undefined> => {
      const marker = path.join(dir, name);
      const mode = owners.modeOf(name) ?? 'listed';
      const settle = createMarkerSettle({ marker, mode, onWarning, killGraceMs, ...(inspector === undefined ? {} : { inspector }), ...(timing === undefined ? {} : { timing }) });
      let state: MarkerState;
      try {
        state = await settle.state(signal);
      } catch (error) {
        onWarning(`tool marker ${marker} holders could not be determined: ${asError(error).message}`);
        return undefined;
      }
      if (state === 'free') {
        await settle.remove();
        return undefined;
      }
      if (state !== 'held') return undefined;
      const keyed = IDEMPOTENCY_KEY.test(name);
      const lookup = keyed ? store.idempotency.get(name) : undefined;
      let pgid: number | undefined;
      try {
        pgid = await readMarkerGroup(marker);
      } catch (error) {
        onWarning(unreadableMarkerNotice(marker, error));
        return undefined;
      }
      const runId = lookup?.s === 'PENDING' ? lookup.rec.meta['runId'] : undefined;
      const run = typeof runId === 'string' ? store.getRun(runId) : undefined;
      return { marker, mode, pgid, terminalRunId: run !== undefined && isTerminal(run.status) ? run.id : undefined };
    };

    const unsettled = unownedOf(names, owners);
    const plans = (await Promise.all(unsettled.map(planOf))).filter((plan): plan is Plan => plan !== undefined);

    const reapPlan = async ({ marker, mode, pgid }: Plan): Promise<boolean> => {
      if ((await claimRetry(marker, event, { signal })) !== 'claimed') return false;
      await reap({
        marker,
        ...(pgid === undefined ? {} : { pgid }),
        killGraceMs,
        label: 'tool',
        onWarning,
        signal,
        markerMode: mode,
        ...(timing === undefined ? {} : { timing }),
        ...(inspector === undefined ? {} : { inspector }),
        ...(uninspectable === undefined ? {} : { uninspectable }),
      });
      return true;
    };

    const outcomes = await Promise.allSettled(plans.map(reapPlan));
    outcomes.forEach((outcome, index) => {
      const plan = plans[index];
      if (outcome.status === 'rejected') onWarning(`tool marker ${plan?.marker} could not be reaped: ${asError(outcome.reason).message}`);
      else if (outcome.value && plan?.terminalRunId !== undefined) onWarning(`tool marker ${plan.marker}: run ${plan.terminalRunId} is terminal, so its holder was reaped`);
    });
  }
};
