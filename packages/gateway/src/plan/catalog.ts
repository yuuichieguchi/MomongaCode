import type { PlanProfile } from '@momonga/config';
import { isRecord, parseOutsideJson } from '@momonga/foundation';
import type { Clock, CredentialStore } from '@momonga/foundation';
import { maxOutputTokensFor } from '@momonga/protocol';
import type { PlanCatalogEntry, PlanModelsResponse } from '@momonga/protocol';
import { applyCredentialEffect, sendAuthorized } from '../adapters/shared/auth.ts';
import { readTextLimited } from '../adapters/shared/body-reading.ts';
import { createUpstreamClassifier } from '../adapters/shared/classify.ts';
import { nestedErrorDetail, requestIdsOf, retryAfterOf } from '../adapters/shared/http-error.ts';
import { UpstreamHttpError } from '../adapters/shared/failures.ts';
import { usableUpstreamJson } from '../adapters/shared/upstream-json.ts';
import type { CompletionResponse } from '../adapters/shared/http-client.ts';
import { gatewayErrorFromBody } from '../core/errors.ts';
import { PLAN_SESSION_DEFAULTS, PLAN_SIGN_IN_DEFAULTS } from '../defaults.ts';
import { reportedContextValue } from '../probe/run-probe.ts';
import type { AuthSource } from './auth-source.ts';
import { noPlanEvents } from './events.ts';
import type { PlanEvents } from './events.ts';
import type { PlanOutbound } from './outbound.ts';
import type { PlanFetch, PlanSleep } from './refresh.ts';

export const NO_REPORTED_WINDOW = 'the server reports no context window for this model';

const CATALOG_LABEL = 'plan catalog';
const SUCCESS_STATUS = 200;

type RecordEntry = { contextWindow: number; maxOutputTokens: number; source: 'reported' } | { unreported: true };

export type CatalogRecord = { readAt: string; models: Readonly<Record<string, RecordEntry>> };

export type CatalogRead = { profile: PlanProfile; account: string; refresh: boolean; auth: AuthSource; signal: AbortSignal };

export type PlanCatalog = {
  read(request: CatalogRead): Promise<PlanModelsResponse>;
  record(profile: string, account: string): Promise<CatalogRecord | undefined>;
  load(profile: string, account: string): Promise<void>;
  capabilitiesOf(profile: string, account: string, model: string): { contextWindow: number; maxOutputTokens: number } | undefined;
};

export type PlanCatalogOptions = { store: CredentialStore; clock: Clock; outbound: PlanOutbound; sleep: PlanSleep; events?: PlanEvents };

async function* bytesOf(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

async function* noBytes(): AsyncGenerator<Uint8Array> {}

const listErrorOf = async (response: CompletionResponse, clock: Clock): Promise<UpstreamHttpError> => {
  const { text } = await readTextLimited(response.body, PLAN_SIGN_IN_DEFAULTS.authBodyBytes);
  const code = nestedErrorDetail(usableUpstreamJson(text)).code ?? null;
  return new UpstreamHttpError(response.status, code, `HTTP ${response.status}`, retryAfterOf(response, clock), false);
};

export const catalogKey = (profile: string, account: string): string => `${profile}/${account}`;

const parseRecord = (text: string): CatalogRecord => {
  const value: unknown = parseOutsideJson(text);
  if (!isRecord(value) || typeof value['readAt'] !== 'string' || !isRecord(value['models'])) throw new Error('the plan catalog record has an unrecognised shape');
  const models: Record<string, RecordEntry> = {};
  for (const [slug, entry] of Object.entries(value['models'])) {
    if (isRecord(entry) && entry['unreported'] === true) models[slug] = { unreported: true };
    else if (isRecord(entry) && typeof entry['contextWindow'] === 'number' && typeof entry['maxOutputTokens'] === 'number') {
      models[slug] = { contextWindow: entry['contextWindow'], maxOutputTokens: entry['maxOutputTokens'], source: 'reported' };
    } else throw new Error(`the plan catalog record has an unrecognised entry for ${JSON.stringify(slug)}`);
  }
  return { readAt: value['readAt'], models };
};

type Listed = { models: PlanCatalogEntry[]; entryKeys: string[] };

const listedOf = (profile: PlanProfile, body: unknown): Listed | undefined => {
  const { listKey, filter, idKey, labelKey } = profile.catalog;
  const listed = isRecord(body) ? body[listKey] : undefined;
  if (!Array.isArray(listed)) return undefined;
  const entryKeys = new Set<string>();
  const models = listed.flatMap((entry: unknown): PlanCatalogEntry[] => {
    if (!isRecord(entry) || entry[filter.field] !== filter.equals) return [];
    const slug = entry[idKey];
    if (typeof slug !== 'string' || slug === '') return [];
    for (const key of Object.keys(entry)) entryKeys.add(key);
    const label = entry[labelKey];
    const displayName = typeof label === 'string' && label !== '' ? label : slug;
    const contextWindow = reportedContextValue(entry);
    return [contextWindow === undefined ? { slug, displayName, usable: false, reason: NO_REPORTED_WINDOW } : { slug, displayName, usable: true, contextWindow, maxOutputTokens: maxOutputTokensFor(contextWindow) }];
  });
  return { models, entryKeys: [...entryKeys].sort() };
};

const UNCLASSIFIED = 'unclassified';

const requestIdHeaderNames = (headers: Record<string, string>): string[] => Object.keys(requestIdsOf(headers)).sort();

const recordOf = (response: PlanModelsResponse): CatalogRecord => ({
  readAt: response.readAt,
  models: Object.fromEntries(
    response.models.map((entry): [string, RecordEntry] => [entry.slug, entry.usable ? { contextWindow: entry.contextWindow, maxOutputTokens: entry.maxOutputTokens, source: 'reported' } : { unreported: true }]),
  ),
});

const isFresh = (record: CatalogRecord, nowMs: number): boolean => {
  const age = nowMs - Date.parse(record.readAt);
  return age >= 0 && age < PLAN_SESSION_DEFAULTS.accessLifetimeMs;
};

export const createPlanCatalog = (options: PlanCatalogOptions): PlanCatalog => {
  const events = options.events ?? noPlanEvents;
  const answers = new Map<string, PlanModelsResponse>();
  const records = new Map<string, CatalogRecord>();

  const record = async (profile: string, account: string): Promise<CatalogRecord | undefined> => {
    const raw = await options.store.read(catalogKey(profile, account));
    return raw === undefined ? undefined : parseRecord(raw);
  };

  const load = async (profile: string, account: string): Promise<void> => {
    const found = await record(profile, account);
    if (found !== undefined) records.set(catalogKey(profile, account), found);
  };

  const fetchList = async (fetch: PlanFetch, request: CatalogRead): Promise<CompletionResponse> => {
    const url = `${request.profile.oauth.resource}${request.profile.catalog.path}`;
    const bound = new AbortController();
    const elapsed = options.sleep(PLAN_SIGN_IN_DEFAULTS.catalogTimeoutMs, bound.signal).then(
      () => bound.abort(new Error(`the model list did not answer within ${PLAN_SIGN_IN_DEFAULTS.catalogTimeoutMs} ms`)),
      (error: unknown) => {
        if (!bound.signal.aborted) throw error;
      },
    );
    const signal = AbortSignal.any([request.signal, bound.signal]);
    try {
      return await sendAuthorized(request.auth, signal, async (bearer) => {
        const response = await fetch(url, { method: 'GET', redirect: 'manual', signal, headers: { accept: 'application/json', ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) } });
        const read = await readTextLimited((response.body as AsyncIterable<Uint8Array> | null) ?? noBytes(), PLAN_SIGN_IN_DEFAULTS.authBodyBytes);
        if (read.truncated) throw new Error(`the model list is larger than ${PLAN_SIGN_IN_DEFAULTS.authBodyBytes} bytes`);
        return { status: response.status, headers: Object.fromEntries(response.headers), body: bytesOf(read.text) };
      });
    } finally {
      if (!bound.signal.aborted) bound.abort();
      await elapsed;
    }
  };

  const readUpstream = async (fetch: PlanFetch, request: CatalogRead): Promise<PlanModelsResponse> => {
    const classify = createUpstreamClassifier(CATALOG_LABEL, request.profile.errorRules);
    const identity = { profile: request.profile.id, account: request.account };
    let response: CompletionResponse;
    try {
      response = await fetchList(fetch, request);
    } catch (error) {
      const body = classify(error).error;
      events('plan.catalog', { ...identity, outcome: body.code ?? UNCLASSIFIED });
      throw gatewayErrorFromBody(body);
    }
    const requestIdHeaders = requestIdHeaderNames(response.headers);
    if (response.status !== SUCCESS_STATUS) {
      const classified = classify(await listErrorOf(response, options.clock));
      await applyCredentialEffect(request.auth, classified, options.clock);
      events('plan.catalog', { ...identity, outcome: classified.error.code ?? UNCLASSIFIED, requestIdHeaders });
      throw gatewayErrorFromBody(classified.error);
    }
    const { text } = await readTextLimited(response.body, PLAN_SIGN_IN_DEFAULTS.authBodyBytes);
    const listed = listedOf(request.profile, usableUpstreamJson(text));
    if (listed === undefined) {
      events('plan.catalog', { ...identity, outcome: 'list_invalid', requestIdHeaders });
      throw new Error(`the ${request.profile.messages.identityLabel} model list has no ${request.profile.catalog.listKey} array`);
    }
    events('plan.catalog', { ...identity, outcome: 'ok', listed: listed.models.length, usable: listed.models.filter((entry) => entry.usable).length, entryKeys: listed.entryKeys, requestIdHeaders });
    return { readAt: new Date(options.clock.now()).toISOString(), models: listed.models };
  };

  const read = async (request: CatalogRead): Promise<PlanModelsResponse> => {
    const key = catalogKey(request.profile.id, request.account);
    const saved = await record(request.profile.id, request.account);
    const answered = answers.get(key);
    if (!request.refresh && saved !== undefined && answered !== undefined && answered.readAt === saved.readAt && isFresh(saved, options.clock.now())) return answered;
    const response = await options.outbound(request.signal, (fetch) => readUpstream(fetch, request));
    const fresh = recordOf(response);
    await options.store.write(key, JSON.stringify(fresh));
    answers.set(key, response);
    records.set(key, fresh);
    return response;
  };

  const capabilitiesOf = (profile: string, account: string, model: string): { contextWindow: number; maxOutputTokens: number } | undefined => {
    const entry = records.get(catalogKey(profile, account))?.models[model];
    return entry === undefined || 'unreported' in entry ? undefined : { contextWindow: entry.contextWindow, maxOutputTokens: entry.maxOutputTokens };
  };

  return { read, record, load, capabilitiesOf };
};
