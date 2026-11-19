import { messageOf } from './vocabulary.ts';
import type { Surface } from './vocabulary.ts';

export const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9._-]*$/;

export const MODEL_NAMINGS = ['server', 'account'] as const;

export type ModelNaming = (typeof MODEL_NAMINGS)[number];

const IPV4_OWN_RANGES: readonly (readonly [number, number])[] = [
  [0x7f000000, 8],
  [0x0a000000, 8],
  [0xac100000, 12],
  [0xc0a80000, 16],
  [0xa9fe0000, 16],
  [0x64400000, 10],
];

const ipv4Of = (host: string): number | undefined => {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return undefined;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
};

const inRange = (address: number, [base, bits]: readonly [number, number]): boolean => Math.floor(address / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits));

const isOwnIpv6 = (host: string): boolean => {
  const first = Number.parseInt(host.split(':')[0] || '0', 16);
  return host === '::1' || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
};

const isOwnNetworkHost = (hostname: string): boolean => {
  if (hostname.startsWith('[')) return isOwnIpv6(hostname.slice(1, -1));
  const ipv4 = ipv4Of(hostname);
  if (ipv4 !== undefined) return IPV4_OWN_RANGES.some((range) => inRange(ipv4, range));
  return !hostname.includes('.') || hostname.endsWith('.local') || hostname.endsWith('.localhost');
};

const textOf = (connection: object, key: string): string | undefined => {
  const value: unknown = Reflect.get(connection, key);
  return typeof value === 'string' ? value : undefined;
};

export const modelNamingOf = (connection: object): ModelNaming => {
  if (Reflect.get(connection, 'plan') !== undefined) return 'account';
  if (textOf(connection, 'adapter') === 'managed' || textOf(connection, 'socketPath') !== undefined) return 'server';
  const baseUrl = textOf(connection, 'baseUrl');
  if (baseUrl === undefined || !URL.canParse(baseUrl)) return 'account';
  return isOwnNetworkHost(new URL(baseUrl).hostname) ? 'server' : 'account';
};

export type ModelView = { canon: string; provider: string; ownName: string; defaultTag?: string; naming: ModelNaming };
export type ModelViews = readonly ModelView[];

declare const storedBrand: unique symbol;
declare const typedBrand: unique symbol;

export type StoredModelRef = string & { readonly [storedBrand]: true };
export type TypedModelText = string & { readonly [typedBrand]: true };

export const storedModelRef = (text: string): StoredModelRef => text as StoredModelRef;
export const typedModelText = (text: string): TypedModelText => text as TypedModelText;

export const canonOf = (provider: string, ownName: string): string => `${provider}/${ownName}`;

export const parseCanon = (text: string): { provider: string; ownName: string } | undefined => {
  const slash = text.indexOf('/');
  if (slash < 0) return undefined;
  const provider = text.slice(0, slash);
  const ownName = text.slice(slash + 1);
  if (!PROVIDER_NAME_PATTERN.test(provider) || ownName === '') return undefined;
  return { provider, ownName };
};

export const hasTag = (ownName: string): boolean => ownName.slice(ownName.lastIndexOf('/') + 1).includes(':');

export const withDefaultTag = (ownName: string, defaultTag: string | undefined): string => (defaultTag === undefined || hasTag(ownName) ? ownName : `${ownName}:${defaultTag}`);

export const shortOf = (view: ModelView): string | undefined => {
  if (view.defaultTag === undefined) return undefined;
  const colon = view.ownName.lastIndexOf(':');
  if (colon <= 0) return undefined;
  return view.ownName.slice(colon + 1) === view.defaultTag ? view.ownName.slice(0, colon) : undefined;
};

export type TypedResolution = { kind: 'found'; model: ModelView } | { kind: 'ambiguous'; choices: readonly ModelView[] } | { kind: 'not_found' };

type ViewIndex = { byCanon: ReadonlyMap<string, ModelView>; byServerAndShort: ReadonlyMap<string, ModelView>; holders: ReadonlyMap<string, readonly ModelView[]> };

const indexOf = (views: ModelViews): ViewIndex => {
  const byCanon = new Map<string, ModelView>();
  const byServerAndShort = new Map<string, ModelView>();
  const holders = new Map<string, ModelView[]>();
  const hold = (text: string, view: ModelView): void => {
    const held = holders.get(text);
    if (held === undefined) holders.set(text, [view]);
    else held.push(view);
  };
  for (const view of views) {
    if (!byCanon.has(view.canon)) byCanon.set(view.canon, view);
    hold(view.ownName, view);
    const short = shortOf(view);
    if (short === undefined) continue;
    hold(short, view);
    const withServer = canonOf(view.provider, short);
    if (!byServerAndShort.has(withServer)) byServerAndShort.set(withServer, view);
  }
  return { byCanon, byServerAndShort, holders };
};

const resolveIn = (index: ViewIndex, text: string): TypedResolution => {
  const exact = index.byCanon.get(text) ?? index.byServerAndShort.get(text);
  if (exact !== undefined) return { kind: 'found', model: exact };
  const holders = index.holders.get(text);
  if (holders === undefined) return { kind: 'not_found' };
  const [only] = holders;
  if (holders.length === 1 && only !== undefined) return { kind: 'found', model: only };
  return { kind: 'ambiguous', choices: holders };
};

export const resolveTypedModelRef = (text: TypedModelText, views: ModelViews): TypedResolution => resolveIn(indexOf(views), text);

export const resolveStoredModelRef = (ref: StoredModelRef, views: ModelViews): ModelView | undefined => views.find((view) => view.canon === ref);

const displayIn = (index: ViewIndex, view: ModelView): string => {
  const bare = shortOf(view) ?? view.ownName;
  const names = (text: string): boolean => {
    const resolution = resolveIn(index, text);
    return resolution.kind === 'found' && resolution.model.canon === view.canon;
  };
  const withServer = canonOf(view.provider, bare);
  const candidates = view.naming === 'server' ? [withServer] : [bare, withServer];
  return candidates.find(names) ?? view.canon;
};

export const displayOf = (view: ModelView, views: ModelViews): string => displayIn(indexOf(views), view);

export const displayMapOf = (views: ModelViews): ReadonlyMap<string, string> => {
  const index = indexOf(views);
  return new Map(views.map((view) => [view.canon, displayIn(index, view)]));
};

export type ModelRefErrorCode = 'ambiguous_model' | 'model_not_found';

export class ModelRefError extends Error {
  readonly code: ModelRefErrorCode;
  readonly text: string;
  readonly choices: readonly string[];

  constructor(code: ModelRefErrorCode, text: string, choices: readonly string[], message: string) {
    super(message);
    this.name = 'ModelRefError';
    this.code = code;
    this.text = text;
    this.choices = choices;
  }
}

export const modelRefErrorOf = (text: string, resolution: Exclude<TypedResolution, { kind: 'found' }>, views: ModelViews, surface: Surface): ModelRefError => {
  const index = indexOf(views);
  if (resolution.kind === 'ambiguous') {
    const choices = resolution.choices.map((choice) => displayIn(index, choice));
    return new ModelRefError('ambiguous_model', text, choices, messageOf('modelAmbiguous', surface, { text, choices }));
  }
  const choices = views.map((view) => displayIn(index, view));
  return new ModelRefError('model_not_found', text, choices, messageOf('modelNotConfigured', surface, { text, choices }));
};

export const STORED_MODEL_KEYS = {
  modelChanged: { current: 'model', legacy: 'modelAlias' },
  previousModel: { current: 'previousModel', legacy: 'previousModelAlias' },
  pin: { current: 'model', legacy: 'modelAlias' },
} as const;

export const decodeStoredModel = (record: Record<string, unknown>, keys: { current: string; legacy: string }): StoredModelRef | undefined => {
  const current = record[keys.current];
  if (typeof current === 'string') return storedModelRef(current);
  const legacy = record[keys.legacy];
  return typeof legacy === 'string' ? storedModelRef(legacy) : undefined;
};

export const sessionModelNotConfiguredText = (stored: string): string => `The model "${stored}" of this session is not configured any more. Choose another with /model.`;
