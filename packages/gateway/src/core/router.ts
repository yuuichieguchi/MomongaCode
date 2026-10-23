import { CircuitBreaker } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import type { Capabilities, GatewayHealth, ProviderAdapter } from '@momonga/protocol';
import { createAdmissionGate } from './admission.ts';
import type { AdmissionGate } from './admission.ts';
import { invalidRequest, notFound } from './errors.ts';
import type { GatewayConfig, GatewayTimers } from '../types.ts';

export type TargetRuntime = {
  name: string;
  model: string;
  adapter: ProviderAdapter;
  breaker: CircuitBreaker;
  gate: AdmissionGate;
  capabilityOverride: Partial<Capabilities> | undefined;
};

export type Router = {
  aliases(): string[];
  hasAlias(alias: string): boolean;
  targetsOf(alias: string): TargetRuntime[];
  capabilitiesOf(target: TargetRuntime): Promise<Capabilities>;
  candidates(alias: string, requirements: { tools: boolean }): Promise<TargetRuntime[]>;
  health(): GatewayHealth;
};

export type RouterOptions = {
  config: GatewayConfig;
  adapters: Record<string, ProviderAdapter>;
  clock: Clock;
  timers: GatewayTimers;
};

const requireEntry = <T>(entries: Record<string, T>, name: string, kind: string): T => {
  const entry = Object.hasOwn(entries, name) ? entries[name] : undefined;
  if (entry === undefined) throw new Error(`gateway configuration references unknown ${kind} "${name}"`);
  return entry;
};

export const createRouter = (options: RouterOptions): Router => {
  const { config, adapters, clock, timers } = options;
  const targets = new Map<string, TargetRuntime>();
  for (const [name, target] of Object.entries(config.models.targets)) {
    targets.set(name, {
      name,
      model: target.model,
      adapter: requireEntry(adapters, target.adapter, 'adapter'),
      breaker: new CircuitBreaker({ failureThreshold: config.breaker.failureThreshold, openMs: config.breaker.openMs, clock }),
      gate: createAdmissionGate({
        targetName: name,
        maxConcurrency: target.maxConcurrency,
        admissionTimeoutMs: target.admissionTimeoutMs,
        timers,
      }),
      capabilityOverride: target.capabilities,
    });
  }
  const targetsByName = Object.fromEntries(targets);
  const aliasTargets = new Map<string, TargetRuntime[]>(
    Object.entries(config.models.aliases).map(([alias, names]) => [alias, names.map((name) => requireEntry(targetsByName, name, 'target'))]),
  );

  const targetsOf = (alias: string): TargetRuntime[] => {
    const found = aliasTargets.get(alias);
    if (found === undefined) throw notFound('model_not_found', `model alias "${alias}" is not configured`, 'model');
    return found;
  };

  const capabilitiesOf = async (target: TargetRuntime): Promise<Capabilities> => {
    const declared = await target.adapter.capabilities();
    if (target.capabilityOverride === undefined) return declared;
    return { ...declared, ...target.capabilityOverride, source: 'config' };
  };

  return {
    aliases: () => [...aliasTargets.keys()],
    hasAlias: (alias) => aliasTargets.has(alias),
    targetsOf,
    capabilitiesOf,
    candidates: async (alias, requirements) => {
      const all = targetsOf(alias);
      if (!requirements.tools) return all;
      const capabilities = await Promise.all(all.map((target) => capabilitiesOf(target)));
      const supported = all.filter((_, index) => (capabilities[index] as Capabilities).toolCalling !== 'none');
      if (supported.length === 0) {
        throw invalidRequest('capability_unsupported', `no target of model alias "${alias}" supports tool calling`, 'tools');
      }
      return supported;
    },
    health: () => {
      const entries = [...targets.values()].map((target) => {
        const breaker = target.breaker.state;
        return [target.name, { ok: breaker !== 'open', breaker }] as const;
      });
      return { ok: entries.every(([, health]) => health.ok), targets: Object.fromEntries(entries) };
    },
  };
};
