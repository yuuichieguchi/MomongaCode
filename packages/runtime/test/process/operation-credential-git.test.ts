import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { finishApprovingPrompts, launchRuntime, prepareStack, readDb, scriptedToolCall, sessionEnvFor, startGateway } from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

const HOST_KIND = process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap';
const BYPASS = { permissionMode: 'bypassPermissions', bypassAllowed: true };
const FORGE_VARIABLE = 'MOMONGA_TEST_FORGE_ACCESS';
const FORGE_HOST = 'git.invalid';
const REMOTE_URL = `https://${FORGE_HOST}/owner/repo.git`;
const HELPER_REFUSAL = 'started without the executable that answers the credential prompt';

const textReply = (text: string) => ({ kind: 'stream' as const, chunks: [{ delta: { role: 'assistant', content: text }, finishReason: 'stop' }] });

const gitIn = (temp: RunHome, ...args: string[]): string => {
  const result = spawnSync('git', args, { cwd: temp.project, env: { ...sessionEnvFor(temp.home) }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
};

const repositoryWithHostedRemote = (temp: RunHome): void => {
  fs.writeFileSync(path.join(temp.home, '.gitconfig'), '[user]\n\tname = Momonga Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n', { mode: 0o600 });
  gitIn(temp, 'init', '-q');
  gitIn(temp, 'remote', 'add', 'origin', REMOTE_URL);
};

const completedOutputs = (temp: RunHome, runId: string): string[] =>
  readDb<{ payload_json: string }>(temp.paths.databases.runtime, "SELECT payload_json FROM events WHERE run_id = ? AND type = 'tool.completed' ORDER BY seq", runId).map(
    (row) => (JSON.parse(row.payload_json) as { output: string }).output,
  );

const forgeSettings = {
  forges: [{ id: 'hosted', descriptor: 'github', hosts: [FORGE_HOST], apiBaseUrl: `https://api.${FORGE_HOST}`, credential: { env: FORGE_VARIABLE } }],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a credentialed git operation through the runtime process, composed as the product composes it', () => {
  it('starts git for a credentialed remote through the credential helper of the process', async () => {
    vi.stubEnv(FORGE_VARIABLE, 'forge-test-token');
    const stack = await prepareStack({ script: [scriptedToolCall('GitFetch', { remote: 'origin', branch: 'main' }), textReply('fetched')] });
    stack.settings({ sandbox: HOST_KIND, ...forgeSettings });
    repositoryWithHostedRemote(stack.temp);
    await startGateway(stack.temp);
    const launched = await launchRuntime(stack.temp);
    const trusted = await launched.http('PUT', '/v1/trust', { body: { path: stack.temp.project, decision: 'trusted' } });
    if (trusted.status !== 200) throw new Error(`trust failed with ${trusted.status}: ${trusted.text}`);
    const session = await launched.createSession({ ...BYPASS, env: { ...sessionEnvFor(stack.temp.home), GIT_TERMINAL_PROMPT: '0' } });
    const run = await launched.createRun(session.id, { input: 'fetch main from origin' });
    await finishApprovingPrompts(launched, stack.temp, run.id);

    const [output] = completedOutputs(stack.temp, run.id);
    expect(output).toBeDefined();
    expect(output).not.toContain(HELPER_REFUSAL);
    expect(output).toContain('GitFetch did not reach its goal');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});
