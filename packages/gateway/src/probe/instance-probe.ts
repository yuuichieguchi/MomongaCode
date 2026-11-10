import { probeKeyComponentLabel } from '@momonga/foundation';
import { TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import type { Probing } from '@momonga/protocol';
import { probeBackoffOf, targetProbeFailedError } from './auto-probe.ts';
import type { ProbeBackoff } from './auto-probe.ts';

const MS_PER_SECOND = 1000;

export type InstanceProbeEnsured<Report> = { kind: 'probing'; probing: Probing } | { kind: 'measured'; report: Report };

export type InstanceProbe<Report> = {
  ensure(): Promise<InstanceProbeEnsured<Report>>;
  restarted(): void;
  close(): Promise<void>;
};

export type InstanceProbeOptions<Report> = {
  target: string;
  unknown: { component: string; reason: string };
  dir: string;
  measure: (signal: AbortSignal) => Promise<Report>;
  retryAfterMs: number;
  clock: { now(): number };
  onNotice: (text: string) => void;
  onFailure?: (error: unknown) => void;
};

export const unreadableKeyNotice = (target: string, component: string, reason: string): string =>
  `the model "${target}": its probe key needs the ${probeKeyComponentLabel(component)}, which cannot be read: ${reason}; it is measured each time its server starts and no probe record is kept`;

export const createInstanceProbe = <Report>(options: InstanceProbeOptions<Report>): InstanceProbe<Report> => {
  const stop = new AbortController();
  const probing: Probing = { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: Math.ceil(options.retryAfterMs / MS_PER_SECOND) };
  let instance = 0;
  let noticed = false;
  let measured: { report: Report } | undefined;
  let backoff: ProbeBackoff | undefined;
  let flight: Promise<void> | undefined;

  const startFlight = (): void => {
    const flightInstance = instance;
    const running = options.measure(stop.signal).then(
      (report) => {
        if (flightInstance === instance) measured = { report };
      },
      (error: unknown) => {
        if (stop.signal.aborted) return;
        if (flightInstance === instance) backoff = probeBackoffOf(error, options.clock.now() + options.retryAfterMs);
        options.onFailure?.(error);
      },
    );
    const tracked: Promise<void> = running.finally(() => {
      if (flight === tracked) flight = undefined;
    });
    flight = tracked;
  };

  return {
    ensure: async () => {
      if (measured !== undefined) return { kind: 'measured', report: measured.report };
      if (!noticed) {
        noticed = true;
        options.onNotice(unreadableKeyNotice(options.target, options.unknown.component, options.unknown.reason));
      }
      if (backoff !== undefined) {
        const remaining = backoff.until - options.clock.now();
        if (remaining > 0) throw targetProbeFailedError(backoff, remaining);
        backoff = undefined;
      }
      if (flight === undefined && !stop.signal.aborted) startFlight();
      return { kind: 'probing', probing };
    },
    restarted: () => {
      instance += 1;
      measured = undefined;
      backoff = undefined;
      noticed = false;
    },
    close: async () => {
      stop.abort();
      await flight;
    },
  };
};
