export type ForgeContractCase = { readonly status: number; readonly body: unknown; readonly expected: Readonly<Record<string, string>> | readonly Readonly<Record<string, string>>[] };

const PULL = {
  url: 'https://api.github.com/repos/octocat/Hello-World/pulls/1347',
  id: 1,
  number: 1347,
  state: 'open',
  locked: true,
  title: 'Amazing new feature',
  html_url: 'https://github.com/octocat/Hello-World/pull/1347',
  head: { label: 'octocat:new-topic', ref: 'new-topic', sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e' },
  base: { label: 'octocat:master', ref: 'master', sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e' },
  merged: false,
  draft: false,
};

const PULL_FIELDS = { number: '1347', url: 'https://github.com/octocat/Hello-World/pull/1347', headSha: '6dcb09b5b57875f334f61aebed695e2e4193db5e', state: 'open', merged: 'false' };

const ISSUE = {
  id: 1,
  node_id: 'MDU6SXNzdWUx',
  url: 'https://api.github.com/repos/octocat/Hello-World/issues/1347',
  html_url: 'https://github.com/octocat/Hello-World/issues/1347',
  number: 1347,
  state: 'open',
  title: 'Found a bug',
  body: "I'm having a problem with this.",
  user: { login: 'octocat', id: 1 },
  labels: [{ id: 208045946, name: 'bug', color: 'f29513' }],
  author_association: 'COLLABORATOR',
  locked: true,
  comments: 0,
};

const ISSUE_FIELDS = { number: '1347', url: 'https://github.com/octocat/Hello-World/issues/1347', title: 'Found a bug', author: 'octocat', authorAssociation: 'COLLABORATOR' };

export const GITHUB_CONTRACT: Readonly<Record<string, ForgeContractCase>> = {
  listPullRequests: { status: 200, body: [PULL], expected: [PULL_FIELDS] },
  getPullRequest: { status: 200, body: PULL, expected: PULL_FIELDS },
  createPullRequest: { status: 201, body: PULL, expected: { number: '1347', url: PULL_FIELDS.url, headSha: PULL_FIELDS.headSha } },
  mergePullRequest: { status: 200, body: { sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e', merged: true, message: 'Pull Request successfully merged' }, expected: { sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e' } },
  getBranch: {
    status: 200,
    body: { name: 'main', commit: { sha: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d', url: 'https://api.github.com/repos/octocat/Hello-World/commits/7fd1a60b01f91b314f59955a4e4d4e80d8edf11d' }, protected: true },
    expected: { sha: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d' },
  },
  listChecks: {
    status: 200,
    body: { total_count: 1, check_runs: [{ id: 4, head_sha: 'ce587453ced02b1526dfb4cb910479d431683101', name: 'mighty_readme', status: 'completed', conclusion: 'neutral', started_at: '2018-05-04T01:14:52Z' }] },
    expected: [{ name: 'mighty_readme', status: 'completed', conclusion: 'neutral' }],
  },
  listComments: {
    status: 200,
    body: [{ id: 1, node_id: 'MDEyOklzc3VlQ29tbWVudDE=', html_url: 'https://github.com/octocat/Hello-World/issues/1347#issuecomment-1', body: 'Me too', user: { login: 'octocat' } }],
    expected: [{ id: '1', body: 'Me too' }],
  },
  listReviewComments: {
    status: 200,
    body: [{ id: 10, path: 'file1.txt', line: 2, original_line: 2, side: 'RIGHT', commit_id: '6dcb09b5b57875f334f61aebed695e2e4193db5e', body: 'Great stuff!', user: { login: 'octocat' } }],
    expected: [{ id: '10', path: 'file1.txt', line: '2', body: 'Great stuff!' }],
  },
  getIssue: { status: 200, body: ISSUE, expected: { ...ISSUE_FIELDS, body: "I'm having a problem with this.", state: 'open' } },
  listIssues: { status: 200, body: [ISSUE], expected: [ISSUE_FIELDS] },
  listIssueComments: {
    status: 200,
    body: [{ id: 1, node_id: 'MDEyOklzc3VlQ29tbWVudDE=', html_url: 'https://github.com/octocat/Hello-World/issues/1347#issuecomment-1', body: 'Me too', user: { login: 'octocat' }, author_association: 'COLLABORATOR' }],
    expected: [{ id: '1', body: 'Me too', author: 'octocat' }],
  },
  createIssueComment: { status: 201, body: { id: 1, body: 'Me too', html_url: 'https://github.com/octocat/Hello-World/issues/1347#issuecomment-1' }, expected: { id: '1' } },
  createComment: { status: 201, body: { id: 1, body: 'Me too', html_url: 'https://github.com/octocat/Hello-World/issues/1347#issuecomment-1' }, expected: { id: '1' } },
};

export const GITHUB_REFUSALS = {
  alreadyExists: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for octocat:new-topic.' }], documentation_url: 'https://docs.github.com/rest/pulls/pulls#create-a-pull-request', status: '422' },
  noCommits: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'No commits between master and new-topic' }], documentation_url: 'https://docs.github.com/rest/pulls/pulls#create-a-pull-request', status: '422' },
} as const;
