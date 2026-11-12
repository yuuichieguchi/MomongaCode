import type { IssueWatchEntry } from '@momonga/config';
import { hostPaths, isRecord } from '@momonga/foundation';
import { issueRunInput } from '@momonga/protocol';
import type { IssueStart } from '@momonga/store';
import { listMatchingIssues } from '@momonga/tools';
import type { ForgeAccess, IssueLocation } from '@momonga/tools';

export type WatchedForge = { id: string; hosts: readonly string[] };

export type IssueWatchView = { entries: readonly IssueWatchEntry[]; forges: readonly WatchedForge[]; forge: ForgeAccess; boundMs: number };

export type PersonAsk = (method: string, path: string, body: unknown, signal: AbortSignal) => Promise<{ status: number; body: unknown }>;

export type IssueWatchOptions = {
  view(signal: AbortSignal): Promise<IssueWatchView>;
  startedOf(folder: string): readonly IssueStart[];
  ask: PersonAsk;
  env: Readonly<Record<string, string>>;
};

const ISSUE_ALREADY_STARTED = 'issue_already_started';

const SESSION_CREATED = 201;
const RUN_ACCEPTED = 202;
const CONFLICT = 409;

const hostOf = (forges: readonly WatchedForge[], entry: IssueWatchEntry): string => {
  const host = forges.find((forge) => forge.id === entry.forge)?.hosts[0];
  if (host === undefined) throw new Error(`the issue watch of ${entry.repository} names the forge ${entry.forge}, which is not declared under forges`);
  return host;
};

const answerText = (body: unknown): string => JSON.stringify(body);

const sessionIdOf = (body: unknown): string => {
  const session = isRecord(body) ? body['session'] : undefined;
  const id = isRecord(session) ? session['id'] : undefined;
  if (typeof id !== 'string') throw new Error(`the issue watch was answered a session without an id: ${answerText(body)}`);
  return id;
};

const errorCodeOf = (body: unknown): unknown => {
  const error = isRecord(body) ? body['error'] : undefined;
  return isRecord(error) ? error['code'] : undefined;
};

const startIssue = async (options: IssueWatchOptions, entry: IssueWatchEntry, issue: IssueLocation, signal: AbortSignal): Promise<void> => {
  const session = await options.ask('POST', '/v1/sessions', { cwd: entry.folder, env: options.env }, signal);
  if (session.status !== SESSION_CREATED) throw new Error(`the issue watch could not open a session in ${entry.folder} for ${issue.url}: ${answerText(session.body)}`);
  const run = await options.ask('POST', `/v1/sessions/${encodeURIComponent(sessionIdOf(session.body))}/runs`, { input: issueRunInput(issue.url), mandate: { profile: entry.mandate }, issue: { url: issue.url, once: true } }, signal);
  if (run.status === RUN_ACCEPTED) return;
  if (run.status === CONFLICT && errorCodeOf(run.body) === ISSUE_ALREADY_STARTED) return;
  throw new Error(`the issue watch could not start a run for ${issue.url} in ${entry.folder}: ${answerText(run.body)}`);
};

const sweepEntry = async (options: IssueWatchOptions, view: IssueWatchView, entry: IssueWatchEntry, signal: AbortSignal): Promise<void> => {
  const filter = { labels: entry.labels ?? [], authorAssociation: entry.authorAssociation ?? [] };
  const issues = await listMatchingIssues(hostOf(view.forges, entry), entry.repository, filter, { forge: view.forge, signal, boundMs: view.boundMs });
  if (issues.length === 0) return;
  const folder = await hostPaths(signal).canonicalDirectory(entry.folder);
  if (!folder.ok) throw new Error(`the issue watch of ${entry.repository} acts in ${entry.folder}, which ${folder.reason}`);
  const started = new Set(options.startedOf(folder.path).map((start) => start.reference));
  for (const issue of issues.filter((candidate) => !started.has(candidate.url))) await startIssue(options, entry, issue, signal);
};

export const sweepIssueWatch = async (options: IssueWatchOptions, signal: AbortSignal): Promise<void> => {
  const view = await options.view(signal);
  for (const entry of view.entries) await sweepEntry(options, view, entry, signal);
};
