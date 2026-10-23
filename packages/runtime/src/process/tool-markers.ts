import fs from 'node:fs';
import path from 'node:path';
import { findHolders, reapMarkedProcesses } from '@momonga/foundation';
import type { ReapTiming } from '@momonga/foundation';
import type { IdempotencyLookup, RuntimeStore } from '@momonga/store';
import { asError } from './as-error.ts';

const IDEMPOTENCY_KEY = /^[0-9a-f]{64}$/;

type ReapPlan = { marker: string; pgid?: number | undefined };

export type ReapToolMarkersOptions = {
  dir: string;
  store: Pick<RuntimeStore, 'idempotency'>;
  killGraceMs: number;
  onWarning(message: string): void;
  timing?: ReapTiming;
  reap?: typeof reapMarkedProcesses;
};

export const reapToolMarkers = async ({
  dir,
  store,
  killGraceMs,
  onWarning,
  timing,
  reap = reapMarkedProcesses,
}: ReapToolMarkersOptions): Promise<void> => {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onWarning(`tool marker directory ${dir} could not be read: ${asError(error).message}`);
    return;
  }

  const planFor = async (name: string): Promise<ReapPlan | undefined> => {
    const marker = path.join(dir, name);
    const holders = await findHolders(marker);
    if (holders.length === 0) {
      try {
        await fs.promises.unlink(marker);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onWarning(`tool marker ${marker} could not be removed: ${asError(error).message}`);
      }
      return undefined;
    }
    const lookup: IdempotencyLookup | undefined = IDEMPOTENCY_KEY.test(name) ? store.idempotency.get(name) : undefined;
    if (lookup?.s === 'PENDING') return undefined;
    if (lookup?.s === 'UNKNOWN') return { marker, pgid: lookup.rec.pgid };
    return { marker };
  };

  const plans = (await Promise.all(names.map(planFor))).filter((plan): plan is ReapPlan => plan !== undefined);

  const outcomes = await Promise.allSettled(
    plans.map((plan) =>
      reap({ ...plan, killGraceMs, label: 'tool', onWarning, ...(timing === undefined ? {} : { timing }) }),
    ),
  );
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') onWarning(`tool marker ${plans[index]?.marker} could not be reaped: ${asError(outcome.reason).message}`);
  });
};
