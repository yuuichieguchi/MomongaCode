import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { ResolvedSettings } from '@momonga/config';
import type { ChildRole } from './launcher.ts';

export type SettingsDigests = { sandbox: string; models: string };

export type AppliedDigests = { runtime?: SettingsDigests; gateway?: Pick<SettingsDigests, 'models'> };

export type RestartPlanPort = {
  isDraining(): boolean;
  stop(role: ChildRole): Promise<void>;
  start(role: ChildRole): void;
  awaitSettled(role: ChildRole, timeoutMs: number): Promise<void>;
  isPlanStopped(role: ChildRole): boolean;
};

export const digestsOf = (settings: Pick<ResolvedSettings, 'sandbox' | 'models'>): SettingsDigests => ({
  sandbox: sha256Hex(canonicalJson(settings.sandbox)),
  models: sha256Hex(canonicalJson(settings.models)),
});

export const planRoles = (current: SettingsDigests, applied: AppliedDigests): ChildRole[] => {
  const roles: ChildRole[] = [];
  if (applied.runtime !== undefined && (applied.runtime.models !== current.models || applied.runtime.sandbox !== current.sandbox)) roles.push('runtime');
  if (applied.gateway !== undefined && applied.gateway.models !== current.models) roles.push('gateway');
  return roles;
};

const START_ORDER = ['gateway', 'runtime'] as const satisfies readonly ChildRole[];

export const runRestartPlan = async (input: { roles: readonly ChildRole[]; port: RestartPlanPort; signal: AbortSignal; startupTimeoutMs: number }): Promise<void> => {
  const { roles, port, signal } = input;
  const halted = (): boolean => port.isDraining() || signal.aborted;
  const started = new Set<ChildRole>();
  const start = (role: ChildRole): void => {
    started.add(role);
    port.start(role);
  };
  try {
    for (const role of roles) {
      if (halted()) return;
      await port.stop(role);
    }
    if (halted()) return;
    if (roles.includes('gateway')) {
      start('gateway');
      await port.awaitSettled('gateway', input.startupTimeoutMs);
      if (halted()) return;
    }
    if (roles.includes('runtime')) start('runtime');
  } finally {
    if (!halted()) {
      for (const role of START_ORDER) if (roles.includes(role) && !started.has(role) && port.isPlanStopped(role)) start(role);
    }
  }
};
