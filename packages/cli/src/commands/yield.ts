import path from 'node:path';
import { buildYieldReport, formatYieldReport, judgeYield, loadYieldDataset, refuseExistingOutput, saveYieldReport } from '@momonga/eval';
import { codeDigestOfRunningProcess, currentSocketResolver, momongaPaths, resolveLayoutLocks } from '@momonga/foundation';
import { CONTEXT_BOOTSTRAP_SEED } from '../constants.ts';
import { nodeYieldEffects } from '../eval/context-effects.ts';
import { pinnedModelOf, unownedHomesNotice, unreadableHomesNotice } from '../eval/context-host.ts';
import { runYieldLive } from '../eval/yield-host.ts';
import type { YieldHostEffects } from '../eval/yield-host.ts';
import { shellModelsOf } from '../plain-http.ts';
import type { CliPorts } from '../ports.ts';
import type { KernelLockMechanism } from '@momonga/foundation';
import { pathsOf } from '../paths.ts';
import { exitOfMeasurement } from '../measurement-exit.ts';

export type EvaluateYieldOptions = { model: string; report: string; interrupt: AbortSignal };

export const evaluateYield = async (
  ports: CliPorts,
  datasetFile: string,
  options: EvaluateYieldOptions,
  hostEffects: (ports: CliPorts, lock: KernelLockMechanism) => YieldHostEffects = nodeYieldEffects,
): Promise<number> => {
  const reportFile = path.resolve(ports.cwd, options.report);
  await refuseExistingOutput(ports.files, reportFile);
  const dataset = await loadYieldDataset(ports.files, path.resolve(ports.cwd, datasetFile));
  const { REFLECTION_ATTEMPTS_BOUND_MS, REFLECTION_PICKUP_BOUND_MS, REFLECTION_POLL_MS } = await import('@momonga/runtime');
  const models = await shellModelsOf(ports, options.interrupt);
  const runs = await runYieldLive(hostEffects(ports, resolveLayoutLocks(await pathsOf(ports)).mechanism), {
    dataset,
    model: pinnedModelOf(models, options.model),
    models,
    codeDigest: await codeDigestOfRunningProcess(),
    planRelaySocket: currentSocketResolver(momongaPaths(ports.home, ports.platform, ports.env), 'gateway'),
    reflection: { pendingBoundMs: REFLECTION_PICKUP_BOUND_MS, attemptBoundMs: REFLECTION_ATTEMPTS_BOUND_MS, pollMs: REFLECTION_POLL_MS },
    onUnreadableHomes: (count) => ports.stderr.write(unreadableHomesNotice(count)),
    onUnownedHomes: (roots) => ports.stderr.write(unownedHomesNotice(roots)),
    interrupt: options.interrupt,
  });
  const report = buildYieldReport({ dataset, runs, seed: CONTEXT_BOOTSTRAP_SEED });
  const gate = judgeYield(report, { seed: CONTEXT_BOOTSTRAP_SEED });
  ports.stdout.write(`${formatYieldReport(report, gate)}\n`);
  await saveYieldReport(ports.files, reportFile, report);
  return exitOfMeasurement(gate.passed);
};
