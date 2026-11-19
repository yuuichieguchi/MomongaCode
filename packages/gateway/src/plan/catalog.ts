import type { PlanProfile } from '@momonga/config';
import { isRecord } from '@momonga/foundation';
import type { Clock, CredentialStore, EventPayload } from '@momonga/foundation';
import { isReasoningEffort, maxOutputTokensFor } from '@momonga/protocol';
import type { PlanCatalogEntry, PlanModelsResponse, ReasoningCapability, ReasoningEffort } from '@momonga/protocol';
import { OPEN_RESPONSES_REASONING_EFFORTS } from '../adapters/open-responses/request.ts';
import { afterCredentialEffect, sendAuthorized } from '../adapters/shared/auth.ts';
import { readTextLimited } from '../adapters/shared/body-reading.ts';
import { createUpstreamClassifier } from '../adapters/shared/classify.ts';
import { nestedErrorDetail, requestIdsOf, retryAfterOf } from '../adapters/shared/http-error.ts';
import { UpstreamHttpError } from '../adapters/shared/failures.ts';
import { usableUpstreamJson } from '../adapters/shared/upstream-json.ts';
import type { CompletionResponse } from '../adapters/shared/http-client.ts';
import { gatewayErrorFromBody } from '../core/errors.ts';
import { PLAN_SESSION_DEFAULTS, PLAN_SIGN_IN_DEFAULTS } from '../defaults.ts';
import { reportedContextWindow } from '../probe/run-probe.ts';
import type { AuthSource } from './auth-source.ts';
import { PLAN_EVENT_INTERNAL, eventScalar, noPlanEvents } from './events.ts';
import type { PlanEvents } from './events.ts';
import type { PlanOutbound } from './outbound.ts';
import { SUCCESS_STATUS } from './http-status.ts';
import { ownEntry } from './own-entry.ts';
import { parsePlanJson } from './plan-json.ts';
import { endedByOperation, recordAccess } from './record-io.ts';
import { responseBytes } from './refresh.ts';
import type { PlanFetch, PlanSleep } from './refresh.ts';

import { NO_REPORTED_WINDOW } from '../reported-window.ts';

export { NO_REPORTED_WINDOW };

const CATALOG_LABEL = 'plan catalog';

export type ReportedReasoning = { efforts: readonly ReasoningEffort[]; default?: ReasoningEffort };

type RecordEntry = { contextWindow: number; maxOutputTokens: number; source: 'reported'; reasoning?: ReportedReasoning } | { unreported: true; reason?: string };

export type CatalogCapabilities = { contextWindow: number; maxOutputTokens: number; reasoning?: ReasoningCapability };

const SENDABLE_EFFORTS: readonly ReasoningEffort[] = OPEN_RESPONSES_REASONING_EFFORTS;

const levelOf = (level: unknown): unknown => (isRecord(level) ? ownEntry(level, 'effort') : level);

const reportedReasoningOf = (levels: unknown, preferred: unknown): ReportedReasoning | undefined => {
  if (!Array.isArray(levels)) return undefined;
  const named = levels.map(levelOf);
  const efforts = SENDABLE_EFFORTS.filter((effort) => named.includes(effort));
  if (efforts.length === 0) return undefined;
  return isReasoningEffort(preferred) && efforts.includes(preferred) ? { efforts, default: preferred } : { efforts };
};

const reasoningEntryOf = (reasoning: ReportedReasoning | undefined): { reasoning?: ReportedReasoning } => (reasoning === undefined ? {} : { reasoning });

const capabilityOf = (reasoning: ReportedReasoning): ReasoningCapability => {
  const [lowest] = reasoning.efforts;
  if (lowest === undefined) throw new Error('a reported reasoning control has no level');
  return { control: 'reasoning_effort', lowest, efforts: reasoning.efforts, ...(reasoning.default === undefined ? {} : { default: reasoning.default }) };
};

export const unusableReasonOf = (entry: { unreported: true; reason?: string }): string => entry.reason ?? NO_REPORTED_WINDOW;

export type CatalogRecord = { readAt: string; models: Readonly<Record<string, RecordEntry>> };

export type CatalogRead = { profile: PlanProfile; account: string; refresh: boolean; auth: AuthSource; signal: AbortSignal };

export type PlanCatalog = {
  read(request: CatalogRead): Promise<PlanModelsResponse>;
  record(profile: string, account: string, signal: AbortSignal): Promise<CatalogRecord | undefined>;
  load(profile: string, account: string, signal: AbortSignal): Promise<void>;
  capabilitiesOf(profile: string, account: string, model: string): CatalogCapabilities | undefined;
};

export type PlanCatalogOptions = { store: CredentialStore; clock: Clock; outbound: PlanOutbound; sleep: PlanSleep; events?: PlanEvents };

async function* bytesOf(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

type ListAnswer = CompletionResponse & { text: string; truncated: boolean };

const listErrorOf = (response: ListAnswer, clock: Clock): UpstreamHttpError => {
  const code = response.truncated ? null : (nestedErrorDetail(usableUpstreamJson(response.text)).code ?? null);
  return new UpstreamHttpError(response.status, code, `HTTP ${response.status}`, retryAfterOf(response, clock), false);
};

export const catalogKey = (profile: string, account: string): string => `${profile}/${account}`;

const recordEntryOf = (entry: unknown): RecordEntry => {
  if (isRecord(entry) && ownEntry(entry, 'unreported') === true) {
    const reason = ownEntry(entry, 'reason');
    return typeof reason === 'string' ? { unreported: true, reason } : { unreported: true };
  }
  const contextWindow = isRecord(entry) ? ownEntry(entry, 'contextWindow') : undefined;
  const maxOutputTokens = isRecord(entry) ? ownEntry(entry, 'maxOutputTokens') : undefined;
  if (typeof contextWindow !== 'number' || typeof maxOutputTokens !== 'number') throw new Error('the plan catalog record has an unrecognised entry');
  const stored = isRecord(entry) ? ownEntry(entry, 'reasoning') : undefined;
  return { contextWindow, maxOutputTokens, source: 'reported', ...reasoningEntryOf(isRecord(stored) ? reportedReasoningOf(ownEntry(stored, 'efforts'), ownEntry(stored, 'default')) : undefined) };
};

const parseRecord = (text: string): CatalogRecord => {
  const value = parsePlanJson(text, (problem) => new Error(`the plan catalog record ${problem}`));
  if (!isRecord(value)) throw new Error('the plan catalog record has an unrecognised shape');
  const readAt = ownEntry(value, 'readAt');
  const stored = ownEntry(value, 'models');
  if (typeof readAt !== 'string' || !isRecord(stored)) throw new Error('the plan catalog record has an unrecognised shape');
  const models = Object.fromEntries(Object.entries(stored).map(([slug, entry]): [string, RecordEntry] => [slug, recordEntryOf(entry)]));
  return { readAt, models };
};

type Reasonings = ReadonlyMap<string, ReportedReasoning>;

type Listed = { models: PlanCatalogEntry[]; entryKeys: string[]; reasonings: Reasonings };

const listedOf = (profile: PlanProfile, body: unknown): Listed | undefined => {
  const { listKey, filter, unusableWhen, idKey, labelKey } = profile.catalog;
  const listed = isRecord(body) ? body[listKey] : undefined;
  if (!Array.isArray(listed)) return undefined;
  const entryKeys = new Set<string>();
  const reasonings = new Map<string, ReportedReasoning>();
  const models = listed.flatMap((entry: unknown): PlanCatalogEntry[] => {
    if (!isRecord(entry) || entry[filter.field] !== filter.equals) return [];
    const slug = entry[idKey];
    if (typeof slug !== 'string' || slug === '') return [];
    for (const key of Object.keys(entry)) entryKeys.add(key);
    const label = entry[labelKey];
    const displayName = typeof label === 'string' && label !== '' ? label : slug;
    if (entry[unusableWhen.field] === unusableWhen.equals) return [{ slug, displayName, usable: false, reason: unusableWhen.reason }];
    const contextWindow = reportedContextWindow(entry);
    if (contextWindow === undefined) return [{ slug, displayName, usable: false, reason: NO_REPORTED_WINDOW }];
    const reasoning = reportedReasoningOf(entry['supported_reasoning_levels'], entry['default_reasoning_level']);
    if (reasoning !== undefined) reasonings.set(slug, reasoning);
    return [{ slug, displayName, usable: true, contextWindow, maxOutputTokens: maxOutputTokensFor(contextWindow) }];
  });
  return { models, entryKeys: [...entryKeys].sort(), reasonings };
};

const UNCLASSIFIED = 'unclassified';

const requestIdHeaderNames = (headers: Record<string, string>): string[] => Object.keys(requestIdsOf(headers)).sort();

const recordOf = (response: PlanModelsResponse, reasonings: Reasonings): CatalogRecord => ({
  readAt: response.readAt,
  models: Object.fromEntries(
    response.models.map((entry): [string, RecordEntry] => [entry.slug, entry.usable ? { contextWindow: entry.contextWindow, maxOutputTokens: entry.maxOutputTokens, source: 'reported', ...reasoningEntryOf(reasonings.get(entry.slug)) } : entry.reason === NO_REPORTED_WINDOW ? { unreported: true } : { unreported: true, reason: entry.reason }]),
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

  const listOf = (profile: string, account: string): string => `the plan model list of ${profile} account ${account}`;

  const record = (profile: string, account: string, signal: AbortSignal): Promise<CatalogRecord | undefined> =>
    recordAccess(
      'read',
      listOf(profile, account),
      async () => {
        const raw = await options.store.read(catalogKey(profile, account), signal);
        return raw === undefined ? undefined : parseRecord(raw);
      },
      signal,
    );

  const load = async (profile: string, account: string, signal: AbortSignal): Promise<void> => {
    const found = await record(profile, account, signal);
    if (found !== undefined) records.set(catalogKey(profile, account), found);
  };

  const fetchList = async (fetch: PlanFetch, request: CatalogRead): Promise<ListAnswer> => {
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
        const read = await readTextLimited(responseBytes(response), response.status === SUCCESS_STATUS ? PLAN_SIGN_IN_DEFAULTS.catalogBodyBytes : PLAN_SIGN_IN_DEFAULTS.authBodyBytes);
        return { status: response.status, headers: Object.fromEntries(response.headers), body: bytesOf(read.text), text: read.text, truncated: read.truncated };
      });
    } finally {
      if (!bound.signal.aborted) bound.abort();
      await elapsed;
    }
  };

  const readUpstream = async (fetch: PlanFetch, request: CatalogRead): Promise<{ response: PlanModelsResponse; reasonings: Reasonings }> => {
    const classify = createUpstreamClassifier(CATALOG_LABEL, request.profile.errorRules);
    let ended = false;
    const end = (fields: EventPayload): void => {
      ended = true;
      events('plan.catalog', { profile: request.profile.id, account: request.account, ...fields });
    };
    let response: ListAnswer;
    try {
      response = await fetchList(fetch, request);
    } catch (error) {
      const body = classify(error).error;
      end({ outcome: eventScalar(body.code ?? UNCLASSIFIED) });
      throw gatewayErrorFromBody(body);
    }
    const requestIdHeaders = requestIdHeaderNames(response.headers).map(eventScalar);
    try {
      if (response.status !== SUCCESS_STATUS) {
        const classified = classify(listErrorOf(response, options.clock));
        const failure = await afterCredentialEffect(gatewayErrorFromBody(classified.error), request.auth, classified, options.clock, request.signal);
        end({ outcome: eventScalar(classified.error.code ?? UNCLASSIFIED), requestIdHeaders });
        throw failure;
      }
      if (response.truncated) {
        end({ outcome: 'list_invalid', requestIdHeaders });
        throw new Error(`the ${request.profile.messages.identityLabel} model list is larger than ${PLAN_SIGN_IN_DEFAULTS.catalogBodyBytes} bytes`);
      }
      const listed = listedOf(request.profile, usableUpstreamJson(response.text));
      if (listed === undefined) {
        end({ outcome: 'list_invalid', requestIdHeaders });
        throw new Error(`the ${request.profile.messages.identityLabel} model list has no ${request.profile.catalog.listKey} array`);
      }
      end({ outcome: 'ok', listed: listed.models.length, usable: listed.models.filter((entry) => entry.usable).length, entryKeys: listed.entryKeys.map(eventScalar), requestIdHeaders });
      return { response: { readAt: new Date(options.clock.now()).toISOString(), models: listed.models }, reasonings: listed.reasonings };
    } catch (error) {
      if (!ended) end({ outcome: PLAN_EVENT_INTERNAL, requestIdHeaders });
      throw error;
    }
  };

  const readableRecord = async (request: CatalogRead): Promise<CatalogRecord | undefined> => {
    try {
      return await record(request.profile.id, request.account, request.signal);
    } catch (error) {
      if (endedByOperation(error, request.signal)) throw error;
      return undefined;
    }
  };

  const read = async (request: CatalogRead): Promise<PlanModelsResponse> => {
    const key = catalogKey(request.profile.id, request.account);
    const answered = request.refresh ? undefined : answers.get(key);
    if (answered !== undefined) {
      const saved = await readableRecord(request);
      if (saved !== undefined && answered.readAt === saved.readAt && isFresh(saved, options.clock.now())) return answered;
    }
    const { response, reasonings } = await options.outbound(request.signal, (fetch) => readUpstream(fetch, request));
    const fresh = recordOf(response, reasonings);
    await recordAccess('write', listOf(request.profile.id, request.account), () => options.store.write(key, JSON.stringify(fresh), request.signal), request.signal);
    answers.set(key, response);
    records.set(key, fresh);
    return response;
  };

  const capabilitiesOf = (profile: string, account: string, model: string): CatalogCapabilities | undefined => {
    const record = records.get(catalogKey(profile, account));
    const entry = record === undefined ? undefined : ownEntry(record.models, model);
    if (entry === undefined || 'unreported' in entry) return undefined;
    return { contextWindow: entry.contextWindow, maxOutputTokens: entry.maxOutputTokens, ...(entry.reasoning === undefined ? {} : { reasoning: capabilityOf(entry.reasoning) }) };
  };

  return { read, record, load, capabilitiesOf };
};
