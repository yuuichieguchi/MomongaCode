import { ToolExecutionError } from '../types.ts';
import { OPERATION_SPECS } from '../operations/catalogue.ts';
import type { OperationSpec, Probe } from '../operations/spec.ts';
import { renderTemplate, shownLine } from '../operations/template.ts';
import type { ForgeAccess } from './instances.ts';

export type IssueLocation = { url: string; remoteUrl: string; repository: string; number: number };

const ISSUE_PATH = /^\/([^/]+)\/([^/]+)\/(?:-\/)?issues\/([1-9][0-9]*)\/?$/;

export const ISSUE_URL_FORM = 'https://<host>/<owner>/<name>/issues/<number>';

export const issueLocationOf = (host: string, repository: string, number: number): IssueLocation => ({
  url: `https://${host}/${repository}/issues/${number}`,
  remoteUrl: `https://${host}/${repository}.git`,
  repository,
  number,
});

export const parseIssueUrl = (text: string): IssueLocation => {
  const url = URL.canParse(text) ? new URL(text) : undefined;
  const match = url === undefined || url.protocol !== 'https:' || url.search !== '' || url.hash !== '' ? null : ISSUE_PATH.exec(url.pathname);
  if (url === undefined || match === null) throw new ToolExecutionError(`${JSON.stringify(text)} is not the address of an issue; give it as ${ISSUE_URL_FORM}, as the forge shows it`);
  return issueLocationOf(url.host, `${match[1] as string}/${match[2] as string}`, Number(match[3]));
};

const ISSUE_READ = 'IssueRead';

const issueReadSpec = (): OperationSpec => {
  const spec = OPERATION_SPECS.find((candidate) => candidate.name === ISSUE_READ);
  if (spec === undefined) throw new ToolExecutionError(`the operation ${ISSUE_READ} is not in the catalogue`);
  return spec;
};

const linesOf = (spec: OperationSpec, id: string): Extract<Probe['via'], { lines: readonly string[] }> => {
  const via = spec.observe.find((probe) => probe.id === id)?.via;
  if (via === undefined || !('lines' in via)) throw new ToolExecutionError(`the operation ${spec.name} has no probe ${id} that shows lines`);
  return via;
};

export type IssueAsk = { forge: ForgeAccess; signal: AbortSignal; boundMs: number };

export const readIssue = async (location: IssueLocation, ask: IssueAsk): Promise<string> => {
  const spec = issueReadSpec();
  const issueVia = linesOf(spec, 'issue');
  const commentsVia = linesOf(spec, 'comments');
  const args = { number: String(location.number) };
  const request = { remoteUrl: location.remoteUrl, args, signal: ask.signal, boundMs: ask.boundMs };
  const issue = await ask.forge.request({ ...request, operation: issueVia.forge });
  const comments = await ask.forge.request({ ...request, operation: commentsVia.forge });
  const shown = (via: typeof issueVia, item: Readonly<Record<string, string>>): string => shownLine(spec.name, via.forge, via.lines, item);
  const scope = {
    after: {
      issue: { text: shown(issueVia, issue.fields) },
      comments: { count: String(comments.items.length), text: comments.items.map((item) => shown(commentsVia, item)).join('\n') },
    },
  };
  return renderTemplate(spec.report, scope);
};

export type IssueFilter = { labels: readonly string[]; authorAssociation: readonly string[] };

export const hasFilter = (filter: IssueFilter): boolean => filter.labels.length > 0 || filter.authorAssociation.length > 0;

export const listMatchingIssues = async (host: string, repository: string, filter: IssueFilter, ask: IssueAsk): Promise<IssueLocation[]> => {
  if (!hasFilter(filter)) return [];
  const answer = await ask.forge.request({
    remoteUrl: issueLocationOf(host, repository, 1).remoteUrl,
    operation: 'listIssues',
    args: { labels: filter.labels.join(',') },
    signal: ask.signal,
    boundMs: ask.boundMs,
  });
  return answer.items
    .filter((item) => item['pullRequest'] === undefined)
    .filter((item) => filter.authorAssociation.length === 0 || filter.authorAssociation.includes(item['authorAssociation'] ?? ''))
    .map((item) => {
      const number = Number(item['number']);
      if (!Number.isInteger(number) || number < 1) throw new ToolExecutionError(`the forge listed an issue of ${repository} without a number`);
      return issueLocationOf(host, repository, number);
    });
};
