import { agentReadiness, escapeTerminalLine, readinessShownText } from '@momonga/protocol';
import type { MomongaModelEntry, Readiness, RemedySurface } from '@momonga/protocol';
import type { MomongaPaths, Timing } from '@momonga/foundation';
import { configureHintText } from './models-texts.ts';

export const readinessNoticeOf = (readiness: Readiness, surface: RemedySurface): string | undefined =>
  readiness.state === 'ready' ? undefined : readinessShownText(readiness, surface).split('\n').map(escapeTerminalLine).join('\n');

export const noTargetLines = (reason: string, paths: Pick<MomongaPaths, 'settingsFile'>): string[] => [reason, `  ${configureHintText(paths.settingsFile)}`];

export type MeasurementPorts = { read(): Promise<MomongaModelEntry>; timers: Pick<Timing, 'setTimeout' | 'clearTimeout'> };

export const followMeasurement = (ports: MeasurementPorts, retryAfterSeconds: number, settled: (entry: MomongaModelEntry) => void, failed: (error: unknown) => void): (() => void) => {
  let stopped = false;
  let handle: unknown;
  const wait = (seconds: number): void => {
    handle = ports.timers.setTimeout(() => {
      ports.read().then(
        (entry) => {
          if (stopped) return;
          const readiness = agentReadiness(entry.capabilities);
          if (readiness.state === 'probing') wait(readiness.retryAfterSeconds);
          else settled(entry);
        },
        (error: unknown) => {
          if (!stopped) failed(error);
        },
      );
    }, Math.max(1, seconds) * 1000);
  };
  wait(retryAfterSeconds);
  return () => {
    stopped = true;
    ports.timers.clearTimeout(handle);
  };
};
