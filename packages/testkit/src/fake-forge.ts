import type http from 'node:http';
import { readBody, sendJson, startLoopbackServer } from './loopback-http.ts';

export type ForgeShape = 'hub' | 'lab';

export type FakePullRequest = { number: number; head: string; base: string; headSha: string; title: string; state: 'open' | 'closed'; merged: boolean };

export type Fault = 'apply_then_drop' | 'drop_before_apply' | 'echo_authorization_500';

export type FakeForgeRequest = { method: string; path: string; query: Record<string, string>; body: unknown; headers: http.IncomingHttpHeaders };

export type FakeForge = {
  origin: string;
  host: string;
  shape: ForgeShape;
  requests: FakeForgeRequest[];
  pulls: FakePullRequest[];
  comments: Map<number, string[]>;
  branchSha: Map<string, string>;
  faultNext(kind: 'create' | 'merge' | 'comment' | 'any', fault: Fault): void;
  creates(): number;
  merges(): number;
  commentPosts(): number;
  openPullsFor(head: string, base: string): FakePullRequest[];
  urlOf(number: number): string;
  close(): Promise<void>;
};

const OWNER = 'acme';
const NAME = 'widgets';

export const REPOSITORY_PATH = `${OWNER}/${NAME}`;

type Route = { kind: 'list' | 'get' | 'create' | 'merge' | 'comments' | 'comment' | 'checks' | 'branch'; number?: number; branch?: string };

const routeOf = (shape: ForgeShape, method: string, pathname: string): Route | undefined => {
  const parts = pathname.split('/').filter((part) => part !== '').map(decodeURIComponent);
  if (shape === 'hub') {
    if (parts[0] !== 'repos' || parts[1] !== OWNER || parts[2] !== NAME) return undefined;
    const rest = parts.slice(3);
    if (rest[0] === 'pulls' && rest.length === 1) return method === 'GET' ? { kind: 'list' } : method === 'POST' ? { kind: 'create' } : undefined;
    if (rest[0] === 'pulls' && rest.length === 2 && method === 'GET') return { kind: 'get', number: Number(rest[1]) };
    if (rest[0] === 'pulls' && rest[2] === 'merge' && method === 'PUT') return { kind: 'merge', number: Number(rest[1]) };
    if (rest[0] === 'issues' && rest[2] === 'comments') return { kind: method === 'GET' ? 'comments' : 'comment', number: Number(rest[1]) };
    if (rest[0] === 'commits' && rest[2] === 'check-runs') return { kind: 'checks' };
    if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') return { kind: 'branch', branch: rest[1] as string };
    return undefined;
  }
  if (parts[0] !== 'api' || parts[1] !== 'v4' || parts[2] !== 'projects' || parts[3] !== OWNER || parts[4] !== NAME) return undefined;
  const rest = parts.slice(5);
  if (rest[0] === 'merge_requests' && rest.length === 1) return method === 'GET' ? { kind: 'list' } : method === 'POST' ? { kind: 'create' } : undefined;
  if (rest[0] === 'merge_requests' && rest.length === 2 && method === 'GET') return { kind: 'get', number: Number(rest[1]) };
  if (rest[0] === 'merge_requests' && rest[2] === 'merge' && method === 'PUT') return { kind: 'merge', number: Number(rest[1]) };
  if (rest[0] === 'merge_requests' && rest[2] === 'notes') return { kind: method === 'GET' ? 'comments' : 'comment', number: Number(rest[1]) };
  if (rest[0] === 'repository' && rest[1] === 'commits' && rest[3] === 'statuses') return { kind: 'checks' };
  if (rest[0] === 'repository' && rest[1] === 'branches' && rest.length === 3 && method === 'GET') return { kind: 'branch', branch: rest[2] as string };
  return undefined;
};

const branchOf = (value: string | undefined): string => (value ?? '').replace(new RegExp(`^${OWNER}:`), '');

export const startFakeForge = async (shape: ForgeShape, credential: string): Promise<FakeForge> => {
  const requests: FakeForgeRequest[] = [];
  const pulls: FakePullRequest[] = [];
  const comments = new Map<number, string[]>();
  const branchSha = new Map<string, string>();
  const faults: Array<{ kind: 'create' | 'merge' | 'comment' | 'any'; fault: Fault }> = [];
  let origin = '';

  const urlOf = (number: number): string => (shape === 'hub' ? `${origin}/${OWNER}/${NAME}/pull/${number}` : `${origin}/${OWNER}/${NAME}/-/merge_requests/${number}`);

  const view = (pull: FakePullRequest): Record<string, unknown> =>
    shape === 'hub'
      ? { number: pull.number, html_url: urlOf(pull.number), state: pull.state, merged: pull.merged, title: pull.title, head: { ref: pull.head, sha: pull.headSha }, base: { ref: pull.base } }
      : { iid: pull.number, web_url: urlOf(pull.number), state: pull.merged ? 'merged' : pull.state === 'open' ? 'opened' : 'closed', merged_flag: pull.merged, title: pull.title, source_branch: pull.head, target_branch: pull.base, sha: pull.headSha };

  const authorised = (req: http.IncomingMessage): boolean =>
    shape === 'hub' ? req.headers['authorization'] === `Bearer ${credential}` || req.headers['authorization'] === `token ${credential}` : req.headers['private-token'] === credential;

  const takeFault = (kind: Route['kind']): Fault | undefined => {
    const effectKind = kind === 'create' ? 'create' : kind === 'merge' ? 'merge' : kind === 'comment' ? 'comment' : undefined;
    const index = faults.findIndex((entry) => entry.kind === 'any' || entry.kind === effectKind);
    if (index < 0) return undefined;
    if (faults[index]?.kind !== 'any' && effectKind === undefined) return undefined;
    return faults.splice(index, 1)[0]?.fault;
  };

  const server = await startLoopbackServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const text = await readBody(req);
    const body: unknown = text === '' ? undefined : JSON.parse(text);
    const method = req.method ?? 'GET';
    requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers });
    if (!authorised(req)) return sendJson(res, 401, { message: 'bad credentials' });
    const route = routeOf(shape, method, url.pathname);
    if (route === undefined) return sendJson(res, 404, { message: `no route ${method} ${url.pathname}` });
    const fault = takeFault(route.kind);
    if (fault === 'echo_authorization_500') return sendJson(res, 500, { message: 'internal error', echoed: req.headers['authorization'] ?? req.headers['private-token'] });
    if (fault === 'drop_before_apply') {
      req.socket.destroy();
      return;
    }
    const fields = (body ?? {}) as Record<string, unknown>;
    const reply = (status: number, payload: unknown): void => {
      if (fault === 'apply_then_drop') {
        req.socket.destroy();
        return;
      }
      sendJson(res, status, payload);
    };
    switch (route.kind) {
      case 'branch': {
        const sha = branchSha.get(route.branch ?? '');
        if (sha === undefined) return sendJson(res, 404, { message: 'branch not found' });
        return sendJson(res, 200, shape === 'hub' ? { name: route.branch, commit: { sha } } : { name: route.branch, commit: { id: sha } });
      }
      case 'list': {
        const head = branchOf(shape === 'hub' ? url.searchParams.get('head') ?? undefined : url.searchParams.get('source_branch') ?? undefined);
        const baseRef = shape === 'hub' ? url.searchParams.get('base') : url.searchParams.get('target_branch');
        const wantOpen = shape === 'hub' ? url.searchParams.get('state') === 'open' : url.searchParams.get('state') === 'opened';
        return sendJson(
          res,
          200,
          pulls.filter((pull) => (head === '' || pull.head === head) && (baseRef === null || pull.base === baseRef) && (!wantOpen || pull.state === 'open')).map(view),
        );
      }
      case 'get': {
        const pull = pulls.find((candidate) => candidate.number === route.number);
        return pull === undefined ? sendJson(res, 404, { message: 'not found' }) : sendJson(res, 200, view(pull));
      }
      case 'create': {
        const head = branchOf(String(shape === 'hub' ? fields['head'] : fields['source_branch']));
        const baseRef = String(shape === 'hub' ? fields['base'] : fields['target_branch']);
        if (pulls.some((pull) => pull.head === head && pull.base === baseRef && pull.state === 'open')) {
          return sendJson(res, shape === 'hub' ? 422 : 409, { message: 'A pull request already exists for this head and base' });
        }
        const pull: FakePullRequest = { number: pulls.length + 1, head, base: baseRef, headSha: branchSha.get(head) ?? '0'.repeat(40), title: String(fields['title']), state: 'open', merged: false };
        pulls.push(pull);
        return reply(shape === 'hub' ? 201 : 200, view(pull));
      }
      case 'merge': {
        const pull = pulls.find((candidate) => candidate.number === route.number);
        if (pull === undefined) return sendJson(res, 404, { message: 'not found' });
        if (fields['sha'] !== pull.headSha) return sendJson(res, shape === 'hub' ? 409 : 406, { message: 'Head branch was modified' });
        pull.merged = true;
        pull.state = 'closed';
        return reply(200, shape === 'hub' ? { merged: true, sha: `m${pull.headSha.slice(1)}` } : { merge_commit_sha: `m${pull.headSha.slice(1)}` });
      }
      case 'comments':
        return sendJson(res, 200, (comments.get(route.number ?? 0) ?? []).map((entry, index) => ({ id: index + 1, body: entry })));
      case 'comment': {
        const list = comments.get(route.number ?? 0) ?? [];
        list.push(String(fields['body']));
        comments.set(route.number ?? 0, list);
        return reply(shape === 'hub' ? 201 : 200, { id: list.length, body: fields['body'] });
      }
      case 'checks':
        return sendJson(res, 200, shape === 'hub' ? { total_count: 0, check_runs: [] } : []);
    }
  });
  origin = server.origin;
  const effectCount = (kind: Route['kind']): number => requests.filter((request) => routeOf(shape, request.method, request.path)?.kind === kind).length;
  return {
    origin,
    host: `127.0.0.1:${server.port}`,
    shape,
    requests,
    pulls,
    comments,
    branchSha,
    faultNext: (kind, fault) => {
      faults.push({ kind, fault });
    },
    creates: () => effectCount('create'),
    merges: () => effectCount('merge'),
    commentPosts: () => effectCount('comment'),
    openPullsFor: (head, base) => pulls.filter((pull) => pull.head === head && pull.base === base && pull.state === 'open'),
    urlOf,
    close: () => server.close(),
  };
};

export const LAB_DESCRIPTOR = {
  id: 'labforge-test',
  auth: { header: 'PRIVATE-TOKEN', prefix: '' },
  operations: {
    listPullRequests: {
      method: 'GET',
      path: '/api/v4/projects/{owner}/{name}/merge_requests',
      query: { source_branch: '{head}', target_branch: '{base}', state: 'opened' },
      success: [200],
      items: '',
      result: { number: 'iid', url: 'web_url', headSha: 'sha', state: 'state', merged: 'merged_flag' },
    },
    getPullRequest: {
      method: 'GET',
      path: '/api/v4/projects/{owner}/{name}/merge_requests/{number}',
      success: [200],
      result: { number: 'iid', url: 'web_url', headSha: 'sha', state: 'state', merged: 'merged_flag' },
    },
    createPullRequest: {
      method: 'POST',
      path: '/api/v4/projects/{owner}/{name}/merge_requests',
      body: { source_branch: '{head}', target_branch: '{base}', title: '{title}', description: '{body}' },
      success: [200],
      alreadyExists: [409],
      result: { number: 'iid', url: 'web_url', headSha: 'sha' },
    },
    mergePullRequest: {
      method: 'PUT',
      path: '/api/v4/projects/{owner}/{name}/merge_requests/{number}/merge',
      body: { sha: '{headSha}' },
      success: [200],
      conflict: [406],
      result: { sha: 'merge_commit_sha' },
    },
    getBranch: {
      method: 'GET',
      path: '/api/v4/projects/{owner}/{name}/repository/branches/{branch}',
      success: [200],
      result: { sha: 'commit.id' },
    },
    listChecks: {
      method: 'GET',
      path: '/api/v4/projects/{owner}/{name}/repository/commits/{headSha}/statuses',
      success: [200],
      items: '',
      result: { name: 'name', status: 'status' },
    },
    listComments: {
      method: 'GET',
      path: '/api/v4/projects/{owner}/{name}/merge_requests/{number}/notes',
      success: [200],
      items: '',
      result: { body: 'body' },
    },
    createComment: {
      method: 'POST',
      path: '/api/v4/projects/{owner}/{name}/merge_requests/{number}/notes',
      body: { body: '{body}' },
      success: [200],
      result: { id: 'id' },
    },
  },
} as const;
