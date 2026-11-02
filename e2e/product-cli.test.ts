import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startMcpHttpFixture, startMcpOauthFixture } from '@momonga/testkit';
import { titleOf } from './support/cases.ts';
import { OPEN_LOG_FILE_NAME, runCli, runCliWithFakes, startCli, startCliWithFakes } from './support/cli.ts';
import type { E2eHome } from './support/home.ts';
import { PNG_BYTES, prepareProduct, requestText, writePng, writeUserSkill } from './support/product.ts';
import { chatCompletions, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const WINDOW_WITH_ROOM_FOR_ALL_TOOLS_AND_AN_IMAGE = 32768;

const jsonOf = (text: string): unknown => JSON.parse(text);

const openedUrls = (home: E2eHome): string[] => {
  const file = path.join(home.root, OPEN_LOG_FILE_NAME);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '') : [];
};

const approveAsUser = async (url: string): Promise<void> => {
  const authorize = await fetch(url, { redirect: 'manual' });
  const location = authorize.headers.get('location');
  if (location === null) throw new Error(`the authorization endpoint did not redirect (${authorize.status})`);
  await (await fetch(location)).arrayBuffer();
};

describe('momonga models, cost and memory', () => {
  it(titleOf('cli-models'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepareProduct({ imageInput: true });

    const text = await runCli(home, ['models']);

    expect(text.stderr).toBe('');
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('default  -> primary');
    expect(text.stdout).toContain('context window: 8192, max output: 1024');
    expect(text.stdout).toContain('image input: yes');
    const json = jsonOf((await runCli(home, ['models', '--json'])).stdout);
    expect(json).toMatchObject([{ id: 'default', targets: ['primary'], capabilities: { contextWindow: 8192, maxOutputTokens: 1024, imageInput: true } }]);
  });

  it(titleOf('cli-policy-verify'), { timeout: 3 * E2E_TEST_TIMEOUT_MS }, async () => {
    type Report = {
      results: { id: string; verdict: { status: string; findings?: { counterexample?: { witness: { command?: string }; replay: { agrees?: boolean } } }[] } }[];
      mismatches: unknown[];
      outsideProof: string[];
      exitCode: number;
    };
    const clean = await prepareProduct({ settings: { permissions: { allow: ['Bash(git status:*)'], deny: ['Bash(git push:*)'] } } });

    const text = await runCli(clean.home, ['policy', 'verify']);
    expect(text.stderr).toBe('');
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('[PROVED ] the rules leave no route to secrets');
    expect(text.stdout).toContain('Outside the proof:');
    expect(text.stdout).toContain('does not prove:');
    const cleanJson = jsonOf((await runCli(clean.home, ['policy', 'verify', '--json'])).stdout) as Report;
    expect(cleanJson.results.map((result) => [result.id, result.verdict.status])).toEqual([
      ['deny-precedence', 'proved'],
      ['secret-reach', 'proved'],
      ['rule-consistency', 'proved'],
      ['bash-admission', 'proved'],
    ]);
    expect(cleanJson.mismatches).toEqual([]);
    expect(cleanJson.exitCode).toBe(0);
    expect(cleanJson.outsideProof.length).toBeGreaterThan(0);

    const escape = await prepareProduct({ settings: { permissions: { allow: ['Bash(git:*)', 'Read(~/**)'], deny: ['Bash(git push:*)'] } } });
    const refuted = await runCli(escape.home, ['policy', 'verify']);
    expect(refuted.code).toBe(1);
    expect(refuted.stdout).toContain('[REFUTED] a Bash allow rule does not admit a denied program or subcommand');
    expect(refuted.stdout).toContain('[REFUTED] the rules leave no route to secrets');
    expect(refuted.stdout).toContain('the decision code agrees (allow)');
    const refutedJson = jsonOf((await runCli(escape.home, ['policy', 'verify', '--json'])).stdout) as Report;
    expect(refutedJson.mismatches).toEqual([]);
    expect(refutedJson.exitCode).toBe(1);
    const bash = refutedJson.results.find((result) => result.id === 'bash-admission');
    expect(bash?.verdict.status).toBe('refuted');
    expect(bash?.verdict.findings?.[0]?.counterexample?.replay.agrees).toBe(true);
  });

  it(titleOf('cli-cost'),{ timeout: 2 * E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepareProduct({ script: [textReply('first'), textReply('second')] });
    expect((await runCli(home, ['-p', 'one'])).stdout).toBe('first\n');
    const second = await runCli(home, ['-p', 'two', '--output-format', 'json']);
    const secondRun = jsonOf(second.stdout) as { run_id: string; session_id: string };

    const report = jsonOf((await runCli(home, ['cost', '--json'])).stdout) as { runs: { runId: string; calls: number }[]; sessions: unknown[]; total: { calls: number; inputTokens: number; outputTokens: number } };
    expect(report.runs).toHaveLength(2);
    expect(report.total).toMatchObject({ calls: 2, inputTokens: 20, outputTokens: 10 });

    const single = jsonOf((await runCli(home, ['cost', secondRun.run_id, '--json'])).stdout) as { runs: { runId: string }[]; total: { calls: number } };
    expect(single.runs.map((run) => run.runId)).toEqual([secondRun.run_id]);
    expect(single.total.calls).toBe(1);
    const bySession = jsonOf((await runCli(home, ['cost', '--session', secondRun.session_id, '--json'])).stdout) as { sessions: { sessionId: string }[] };
    expect(bySession.sessions.map((session) => session.sessionId)).toEqual([secondRun.session_id]);

    const text = await runCli(home, ['cost', '--all']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('cost report');
    expect(text.stdout).toContain('total: 2 call(s), 20 input (0 cached) + 10 output tokens');
    const mixed = await runCli(home, ['cost', secondRun.run_id, '--all']);
    expect(mixed.code).toBe(1);
    expect(mixed.stderr).toContain('choose one of a run id, --session and --all');
  });

  it(titleOf('cli-memory'), { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async () => {
    const note = 'The team deploys with pnpm and needs the staging VPN.';
    const { home } = await prepareProduct({ script: [toolCallReply('MemorySave', { text: note, scope: 'user' }, 'call_mem'), textReply('Saved.')] });
    const saved = await runCli(home, ['-p', 'Remember how we deploy', '--dangerously-skip-permissions']);
    expect(saved.code).toBe(0);

    const listed = await runCli(home, ['memory', 'list']);
    expect(listed.code).toBe(0);
    const line = listed.stdout.trim();
    const id = line.split(/\s+/)[0] ?? '';
    expect(line).toBe(`${id}  [user]  ${note}`);
    expect((await runCli(home, ['memory', 'list', '--scope', 'project'])).stdout).toBe('no memories\n');
    expect((await runCli(home, ['memory', 'list', '--scope', 'user'])).stdout).toBe(listed.stdout);

    const shown = await runCli(home, ['memory', 'show', id]);
    expect(shown.stdout).toContain(`id: ${id}`);
    expect(shown.stdout).toContain('scope: user');
    expect(shown.stdout).toMatch(/source: session \S+, run \S+, step \d+, call \S+, event \d+/);
    expect(shown.stdout).toContain(note);
    expect(jsonOf((await runCli(home, ['memory', 'show', id, '--json'])).stdout)).toMatchObject({ id, scope: 'user', project: null, text: note });

    const deleted = await runCli(home, ['memory', 'delete', id]);
    expect(deleted.stdout).toBe(`deleted memory ${id}\n`);
    expect((await runCli(home, ['memory', 'list'])).stdout).toBe('no memories\n');
    const missing = await runCli(home, ['memory', 'show', id]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('404');
  });
});

describe('momonga -p with skills and images', () => {
  it(titleOf('cli-skill-print'), { timeout: 3 * E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepareProduct({ script: [textReply('one'), textReply('two'), textReply('three')] });
    writeUserSkill(home, 'pdf', 'Extract PDF text');

    const slash = await runCli(home, ['-p', '/pdf summarize the report']);
    expect(slash.code).toBe(0);
    expect(slash.stdout).toBe('one\n');
    const explicit = await runCli(home, ['-p', 'summarize the other report', '--skill', 'pdf']);
    expect(explicit.stdout).toBe('two\n');
    const plain = await runCli(home, ['-p', '/etc/hosts what is this']);
    expect(plain.stdout).toBe('three\n');

    const requests = chatCompletions(fake);
    expect(requestText(requests[0])).toContain('Activated skill pdf');
    expect(requestText(requests[0])).toContain('summarize the report');
    expect(requestText(requests[0])).not.toContain('/pdf summarize');
    expect(requestText(requests[1])).toContain('Activated skill pdf');
    expect(requestText(requests[1])).toContain('summarize the other report');
    expect(requestText(requests[2])).not.toContain('Activated skill');
    expect(requestText(requests[2])).toContain('/etc/hosts what is this');

    const bare = await runCli(home, ['-p', '/pdf']);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain('/pdf needs a task to run the skill on');
    const unknown = await runCli(home, ['-p', 'x', '--skill', 'nope']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('no skill named nope; available: pdf');
    expect(chatCompletions(fake)).toHaveLength(3);
  });

  it(titleOf('cli-image-print'), { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async () => {
    const capable = await prepareProduct({ imageInput: true, contextWindow: WINDOW_WITH_ROOM_FOR_ALL_TOOLS_AND_AN_IMAGE, script: [textReply('It is a picture.')] });
    const shot = writePng(capable.home.project, 'shot.png');

    const described = await runCli(capable.home, ['-p', 'What is in the picture?', '--image', 'shot.png']);
    expect(described.stderr).toBe('');
    expect(described.stdout).toBe('It is a picture.\n');
    expect(requestText(chatCompletions(capable.fake)[0])).toContain(`data:image/png;base64,${PNG_BYTES.toString('base64')}`);

    const notAnImage = path.join(capable.home.project, 'notes.png');
    fs.writeFileSync(notAnImage, 'plain text');
    const refused = await runCli(capable.home, ['-p', 'x', '--image', notAnImage]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('is not a PNG, JPEG, GIF or WebP image');
    expect(shot).toContain('shot.png');

    const incapable = await prepareProduct({ script: [textReply('never')] });
    writePng(incapable.home.project, 'shot.png');
    const declined = await runCli(incapable.home, ['-p', 'What is in the picture?', '--image', 'shot.png']);
    expect(declined.code).toBe(1);
    expect(declined.stderr).toContain('the model alias default does not declare image input');
    expect(chatCompletions(incapable.fake)).toHaveLength(0);
  });
});

describe('momonga with MCP servers', () => {
  it(titleOf('cli-elicit-print'), { timeout: 3 * E2E_TEST_TIMEOUT_MS }, async () => {
    const fixture = await startMcpHttpFixture({ era: 'modern' });
    try {
      const { home, fake } = await prepareProduct({
        script: [toolCallReply('mcp__remote__mrtr_elicit', {}, 'call_1'), textReply('done')],
        settings: { mcpServers: { remote: { type: 'http', url: fixture.url } } },
      });
      const running = startCli(home, ['-p', 'Ask me who I am', '--dangerously-skip-permissions']);

      const listed = await until(
        async () => {
          const result = await runCli(home, ['elicit']);
          return /MCP server remote asks for input/.test(result.stdout) ? result : undefined;
        },
        { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the pending elicitation to be listed by momonga elicit' },
      );
      const inputId = listed.stdout.split(/\s+/)[0] ?? '';
      expect(inputId).not.toBe('');
      expect(listed.stdout).toContain('[who] Who are you?');
      expect(listed.stdout).toContain('name (string, required)');
      expect(listed.stdout).toContain(`momonga elicit ${inputId} --accept --set name=<string>`);
      expect((await runCli(home, ['elicit', inputId])).stdout).toBe(listed.stdout);

      const missing = await runCli(home, ['elicit', inputId, '--accept']);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("must have required property 'name'");
      const unknownField = await runCli(home, ['elicit', inputId, '--accept', '--set', 'age=3']);
      expect(unknownField.code).toBe(1);
      expect(unknownField.stderr).toContain('unknown field age; the request asks for name');
      const conflicting = await runCli(home, ['elicit', inputId, '--accept', '--decline']);
      expect(conflicting.code).toBe(1);
      expect(conflicting.stderr).toContain('choose one of --accept, --decline, --cancel and --responses');
      expect(fixture.rpcRecords('tools/call')).toHaveLength(1);

      const answered = await runCli(home, ['elicit', inputId, '--accept', '--set', 'name=Ada']);
      expect(answered.code).toBe(0);
      expect(answered.stdout).toMatch(/^elicitation \S+ resolved; run \S+ is /);

      const finished = await running.result;
      expect(finished.code).toBe(0);
      expect(finished.stdout).toBe('done\n');
      expect(finished.stderr).toContain(`momonga: waiting for input ${inputId}  MCP server remote asks for input`);
      expect(finished.stderr).toContain(`momonga elicit ${inputId} --decline`);
      expect(requestText(chatCompletions(fake).at(-1))).toContain('hello Ada');
      expect(fixture.rpcRecords('tools/call')).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });

  it(titleOf('cli-mcp-notice'), { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async () => {
    const oauth = await startMcpOauthFixture();
    const fixture = await startMcpHttpFixture({ era: 'modern', oauth });
    try {
      const { home } = await prepareProduct({
        script: [toolCallReply('mcp__remote__echo', { text: 'first' }, 'call_1'), textReply('needs login')],
        settings: { mcpServers: { remote: { type: 'http', url: fixture.url } } },
      });

      const result = await runCli(home, ['-p', 'Use the remote tool', '--dangerously-skip-permissions']);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('needs login\n');
      expect(result.stderr).toContain('momonga: MCP server remote needs authorization; run: momonga mcp login remote');
    } finally {
      await fixture.close();
      await oauth.close();
    }
  });

  it(titleOf('cli-mcp-login'), { timeout: 3 * E2E_TEST_TIMEOUT_MS }, async () => {
    const oauth = await startMcpOauthFixture();
    const fixture = await startMcpHttpFixture({ era: 'modern', oauth });
    try {
      const { home } = await prepareProduct({ settings: { mcpServers: { remote: { type: 'http', url: fixture.url } } } });

      const before = await runCli(home, ['mcp', 'list']);
      expect(before.code).toBe(0);
      expect(before.stdout).toMatch(/^NAME\s+SCOPE\s+TRANSPORT\s+AUTH\s+DETAIL$/m);
      expect(before.stdout).toMatch(/^remote\s+user\s+http\s+required\s+.*run: momonga mcp login remote$/m);

      const login = startCliWithFakes(home, ['mcp', 'login', 'remote']);
      const [url] = await until(
        () => {
          const urls = openedUrls(home);
          return urls.length > 0 ? urls : undefined;
        },
        { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the browser port to be asked to open the authorization URL' },
      );
      if (url === undefined) throw new Error('no URL was opened');
      await approveAsUser(url);
      const finished = await login.result;
      expect(finished.stderr).toBe('');
      expect(finished.code).toBe(0);
      expect(finished.stdout).toBe(`Authorize MCP server remote in your browser:\n${url}\nMCP server remote is authorized\n`);
      expect(openedUrls(home)).toEqual([url]);

      const after = await runCli(home, ['mcp', 'list']);
      expect(after.stdout).toMatch(/^remote\s+user\s+http\s+authorized\s/m);
      const again = await runCliWithFakes(home, ['mcp', 'login', 'remote']);
      expect(again.stdout).toBe('MCP server remote is authorized\n');
      expect(openedUrls(home)).toEqual([url]);

      const unknown = await runCliWithFakes(home, ['mcp', 'login', 'nope']);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('no enabled MCP server named nope');
    } finally {
      await fixture.close();
      await oauth.close();
    }
  });

  it('mcp login --no-browser only prints the URL and an interrupt cancels the waiting authorization', { timeout: 3 * E2E_TEST_TIMEOUT_MS }, async () => {
    const oauth = await startMcpOauthFixture();
    const fixture = await startMcpHttpFixture({ era: 'modern', oauth });
    try {
      const { home } = await prepareProduct({ settings: { mcpServers: { remote: { type: 'http', url: fixture.url } } } });

      const interrupted = startCliWithFakes(home, ['mcp', 'login', 'remote', '--no-browser']);
      await until(() => (/^https?:\/\/\S+$/m.test(interrupted.partialStdout()) ? true : undefined), {
        deadlineMs: E2E_RUN_COMPLETED_BOUND_MS,
        description: 'the authorization URL to be printed',
      });
      interrupted.interrupt();
      const cancelled = await interrupted.result;
      expect(cancelled.code).toBe(130);
      expect(cancelled.stderr).toContain('authorization of MCP server remote cancelled');
      expect(openedUrls(home)).toEqual([]);

      const login = startCliWithFakes(home, ['mcp', 'login', 'remote', '--no-browser']);
      const url = await until(
        () => {
          const match = /^(https?:\/\/\S+)$/m.exec(login.partialStdout());
          return match?.[1];
        },
        { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the authorization URL to be printed' },
      );
      await approveAsUser(url);
      const finished = await login.result;
      expect(finished.code).toBe(0);
      expect(finished.stdout).toContain('MCP server remote is authorized');
      expect(openedUrls(home)).toEqual([]);
    } finally {
      await fixture.close();
      await oauth.close();
    }
  });
});
