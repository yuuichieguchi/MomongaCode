import type { ModelOutputKind } from '@momonga/protocol';
import { endpointKeyOf, upstreamEndpointOf } from './probe-record-key.ts';
import type { ProbeRecordKey, WrittenAddress } from './probe-record-key.ts';
import type { ModelTarget, TargetCapabilitiesCore } from './settings.ts';

export type AdapterKind = ModelTarget['adapter'];

export type WireFacts = Partial<Omit<TargetCapabilitiesCore, 'contextWindow' | 'maxOutputTokens' | 'imageInput' | 'imageTokens'>>;

export type ProbeKind = 'managed-process' | 'chat-completions-wire' | 'ollama-wire' | 'none';

export type AdapterTraits = {
  readonly outputKind: ModelOutputKind;
  readonly credentials: 'none' | 'key';
  readonly address: 'server' | 'written' | 'url';
  readonly models: 'one' | 'many';
  readonly toolCallingSetting: boolean;
  readonly jsonOnlyForm: boolean;
  readonly probeRecord: 'model' | 'address' | 'none';
  readonly probe: ProbeKind;
  readonly measured: 'always' | 'when-tool-calling-auto' | 'never';
  readonly serverListable: boolean;
  readonly wire: WireFacts;
};

const ANTHROPIC_WIRE_CACHE_BREAKPOINTS = 4;

export const ADAPTERS = {
  managed: {
    outputKind: 'text',
    credentials: 'none',
    address: 'server',
    models: 'one',
    toolCallingSetting: true,
    jsonOnlyForm: true,
    probeRecord: 'model',
    probe: 'managed-process',
    measured: 'always',
    serverListable: true,
    wire: {},
  },
  'chat-completions': {
    outputKind: 'text',
    credentials: 'key',
    address: 'written',
    models: 'many',
    toolCallingSetting: true,
    jsonOnlyForm: true,
    probeRecord: 'address',
    probe: 'chat-completions-wire',
    measured: 'when-tool-calling-auto',
    serverListable: true,
    wire: {},
  },
  'open-responses': {
    outputKind: 'text',
    credentials: 'key',
    address: 'written',
    models: 'many',
    toolCallingSetting: true,
    jsonOnlyForm: true,
    probeRecord: 'none',
    probe: 'none',
    measured: 'never',
    serverListable: true,
    wire: { stopSequences: false },
  },
  anthropic: {
    outputKind: 'text',
    credentials: 'key',
    address: 'written',
    models: 'many',
    toolCallingSetting: false,
    jsonOnlyForm: false,
    probeRecord: 'none',
    probe: 'none',
    measured: 'never',
    serverListable: true,
    wire: { stopSequences: false, parallelToolCalls: true, tokenCounting: 'exact', promptCache: { kind: 'breakpoints', maxBreakpoints: ANTHROPIC_WIRE_CACHE_BREAKPOINTS } },
  },
  ollama: {
    outputKind: 'text',
    credentials: 'none',
    address: 'written',
    models: 'many',
    toolCallingSetting: false,
    jsonOnlyForm: true,
    probeRecord: 'address',
    probe: 'ollama-wire',
    measured: 'always',
    serverListable: true,
    wire: { structuredOutput: 'json_schema', stopSequences: false },
  },
  'system-one': {
    outputKind: 'choice',
    credentials: 'key',
    address: 'url',
    models: 'many',
    toolCallingSetting: false,
    jsonOnlyForm: false,
    probeRecord: 'none',
    probe: 'none',
    measured: 'never',
    serverListable: false,
    wire: { outputKind: 'choice', structuredOutput: 'json_schema', streaming: false, stopSequences: false, outputBoundField: 'none' },
  },
} as const satisfies Record<AdapterKind, AdapterTraits>;

export type AdapterTable = Readonly<Record<string, AdapterTraits>>;

type Adapters = typeof ADAPTERS;

export type MeasuredBy<Target extends { adapter: AdapterKind }, Kind extends ProbeKind> =
  | Extract<Target, { adapter: { [A in AdapterKind]: Adapters[A]['probe'] extends Kind ? (Adapters[A]['measured'] extends 'always' ? A : never) : never }[AdapterKind] }>
  | (Extract<Target, { adapter: { [A in AdapterKind]: Adapters[A]['probe'] extends Kind ? (Adapters[A]['measured'] extends 'when-tool-calling-auto' ? A : never) : never }[AdapterKind] }> & { toolCalling: 'auto' });

export type ProbedBy<Target extends { adapter: AdapterKind }, Kind extends ProbeKind> = Extract<Target, { adapter: { [A in AdapterKind]: Adapters[A]['probe'] extends Kind ? A : never }[AdapterKind] }>;

export type Probeable<Target extends { adapter: AdapterKind }> = ProbedBy<Target, Exclude<ProbeKind, 'none'>>;

export const isAdapterKind = (name: string): name is AdapterKind => Object.hasOwn(ADAPTERS, name);

type Measurable = { readonly adapter: string; readonly toolCalling?: string | undefined };

type Addressed = WrittenAddress & { readonly adapter: string; readonly model: string };

export const takesKeyIn =
  (traits: AdapterTable) =>
  (adapter: string): boolean =>
    traits[adapter]?.credentials === 'key';

export const measuringProbeIn =
  (traits: AdapterTable) =>
  (target: Measurable): Exclude<ProbeKind, 'none'> | undefined => {
    const own = traits[target.adapter];
    if (own === undefined || own.probe === 'none' || own.measured === 'never') return undefined;
    if (own.measured === 'when-tool-calling-auto' && target.toolCalling !== 'auto') return undefined;
    return own.probe;
  };

export const probeRecordKeyIn =
  (traits: AdapterTable) =>
  (canon: string, target: Addressed): ProbeRecordKey | undefined => {
    switch (traits[target.adapter]?.probeRecord) {
      case 'model':
        return { kind: 'model', model: canon };
      case 'address':
        return { kind: 'endpoint', key: { endpoint: endpointKeyOf(upstreamEndpointOf(target)), model: target.model } };
      default:
        return undefined;
    }
  };

export const takesKey = takesKeyIn(ADAPTERS);

export const measuringProbeOf = measuringProbeIn(ADAPTERS);

export const isMeasuredBy = <Target extends { adapter: AdapterKind; toolCalling?: string | undefined }, Kind extends Exclude<ProbeKind, 'none'>>(target: Target, kind: Kind): target is MeasuredBy<Target, Kind> =>
  measuringProbeOf(target) === kind;

export const isProbedBy = <Target extends { adapter: AdapterKind }, Kind extends Exclude<ProbeKind, 'none'>>(target: Target, kind: Kind): target is ProbedBy<Target, Kind> => ADAPTERS[target.adapter].probe === kind;

export const isProbeable = <Target extends { adapter: AdapterKind }>(target: Target): target is Probeable<Target> => ADAPTERS[target.adapter].probe !== 'none';

export const isServerListable = (adapter: string): boolean => !isAdapterKind(adapter) || ADAPTERS[adapter].serverListable;
