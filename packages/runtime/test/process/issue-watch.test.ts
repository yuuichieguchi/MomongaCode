import { describe, expect, it } from 'vitest';
import type { IssueWatchEntry } from '@momonga/config';
import { startFakeForge } from '@momonga/testkit';
import type { FakeForge, FakeIssue } from '@momonga/testkit';
import { createForgeAccess, loadForgeDescriptors, parseIssueUrl, readIssue } from '@momonga/tools';
import type { ForgeAccess } from '@momonga/tools';
import { sweepIssueWatch } from '../../src/process/issue-watch.ts';
import type { IssueWatchOptions } from '../../src/process/issue-watch.ts';
import { onCleanup, startService } from '../service/helpers.ts';
import type { DelegationPort, ServiceEnv } from '../service/helpers.ts';

const CREDENTIAL = 'fake-forge-credential-for-tests';
const BOUND_MS = 10_000;

const mandates: DelegationPort = {
  settings: async () => ({ mandates: { fix: { allow: ['GitCommit'], steps: 20 } } }),
  projectMandate: async () => undefined,
  chainBilling: async () => ({ metered: false, priced: true }),
};

const issue = (number: number, overrides: Partial<FakeIssue> = {}): FakeIssue => ({
  number,
  title: `Issue ${number}`,
  body: 'It breaks',
  state: 'open',
  labels: ['momonga'],
  author: 'reporter',
  authorAssociation: 'MEMBER',
  ...overrides,
});

const accessTo = (forge: FakeForge): ForgeAccess =>
  createForgeAccess({
    descriptors: loadForgeDescriptors(),
    instances: [{ id: 'hub', descriptor: 'github', hosts: [forge.host], apiBaseUrl: forge.origin, credential: { env: 'FAKE_FORGE_TOKEN' } }],
    readCredential: async () => CREDENTIAL,
    fetch: (url, { boundMs: _boundMs, ...init }) => fetch(url, init),
  });

const world = async () => {
  const forge = await startFakeForge('hub', CREDENTIAL);
  onCleanup(() => forge.close());
  const access = accessTo(forge);
  const env = await startService({ delegation: mandates, issues: { read: async (url, signal) => ({ reference: { ...parseIssueUrl(url) }, content: await readIssue(parseIssueUrl(url), { forge: access, signal, boundMs: BOUND_MS }) }) } });
  return { forge, access, env };
};

const optionsFor = (env: ServiceEnv, forge: FakeForge, access: ForgeAccess, entries: readonly IssueWatchEntry[]): IssueWatchOptions => ({
  view: async () => ({ entries, forges: [{ id: 'hub', hosts: [forge.host] }], forge: access, boundMs: BOUND_MS }),
  startedOf: (folder) => env.store.issueWatch.issueStartsOf(folder),
  ask: (method, path, body, signal) => env.service.askAsPerson(method, path, body, signal),
  env: { PATH: '/usr/bin:/bin', LANG: 'C' },
});

const entryFor = (env: ServiceEnv, filter: Pick<IssueWatchEntry, 'labels' | 'authorAssociation'>): IssueWatchEntry => ({ repository: 'acme/widgets', folder: env.layout.project, forge: 'hub', mandate: 'fix', ...filter });

const sweep = (env: ServiceEnv, forge: FakeForge, access: ForgeAccess, filter: Pick<IssueWatchEntry, 'labels' | 'authorAssociation'>): Promise<void> =>
  sweepIssueWatch(optionsFor(env, forge, access, [entryFor(env, filter)]), new AbortController().signal);

const runsOf = (env: ServiceEnv): string[] => env.store.issueWatch.issueStartsOf(env.layout.project).map((start) => start.reference);

describe('the issue watch of the daemon', () => {
  it('starts each matching issue once, when it is polled twice', async () => {
    const { forge, access, env } = await world();
    forge.issues.push(issue(7));
    const options = optionsFor(env, forge, access, [entryFor(env, { labels: ['momonga'] })]);
    await sweepIssueWatch(options, new AbortController().signal);
    await sweepIssueWatch(options, new AbortController().signal);
    expect(runsOf(env)).toEqual([`https://${forge.host}/acme/widgets/issues/7`]);
    const started = env.store.issueWatch.issueStartsOf(env.layout.project)[0];
    expect(env.store.getRun(started?.startedRunId ?? '')?.pins['issue']).toMatchObject({ number: 7, repository: 'acme/widgets' });
  });

  it('does not start an issue again after a restart: what was started is read from the store', async () => {
    const { forge, access, env } = await world();
    forge.issues.push(issue(7));
    await sweep(env, forge, access, { labels: ['momonga'] });
    await sweep(env, forge, access, { labels: ['momonga'] });
    expect(runsOf(env)).toHaveLength(1);
  });

  it('takes nothing, and asks the forge nothing, when the entry declares no filter', async () => {
    const { forge, access, env } = await world();
    forge.issues.push(issue(7));
    await sweep(env, forge, access, {});
    expect(runsOf(env)).toEqual([]);
    expect(forge.requests).toEqual([]);
  });

  it('takes only issues whose author has a declared association, and never a pull request', async () => {
    const { forge, access, env } = await world();
    forge.issues.push(issue(7, { authorAssociation: 'NONE' }), issue(8, { authorAssociation: 'OWNER' }), issue(9, { authorAssociation: 'OWNER', pullRequest: true }));
    await sweep(env, forge, access, { authorAssociation: ['OWNER'] });
    expect(runsOf(env)).toEqual([`https://${forge.host}/acme/widgets/issues/8`]);
  });
});
