import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startMcpHttpFixture } from '@momonga/testkit';
import { titleOf } from './support/cases.ts';
import { OPEN_LOG_FILE_NAME, SECRETS_FILE_NAME, runCli } from './support/cli.ts';
import type { E2eHome } from './support/home.ts';
import { PNG_BYTES, prepareProduct, requestText, writePng, writeUserSkill } from './support/product.ts';
import { KEYS, spawnPty } from './support/pty.ts';
import type { PtySession } from './support/pty.ts';
import { chatCompletions, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

const spawnWithFakes = (home: E2eHome, args: readonly string[] = []): Promise<PtySession> => spawnPty(home, args, {}, { fakes: true });

const trustAndWait = async (pty: PtySession, mode = 'default'): Promise<void> => {
  await pty.waitFor('Do you trust the files in');
  pty.write('1');
  await pty.waitFor(`mode: ${mode}`);
};

const submit = async (pty: PtySession, text: string): Promise<void> => {
  pty.write(text);
  await pty.waitFor(`> ${text}`);
  pty.write(KEYS.enter);
};

const leave = async (pty: PtySession): Promise<void> => {
  pty.write(KEYS.ctrlD);
  expect(await pty.exit()).toEqual({ code: 0, signal: null });
};

const pasted = (text: string): string => `\u001b[200~${text}\u001b[201~`;

describe('momonga secret set through a pty', () => {
  it(titleOf('cli-secret'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepareProduct();
    const value = 'sk-fake-hidden-value-0123456789';

    const stored = await spawnWithFakes(home, ['secret', 'set', 'anthropic-main']);
    await stored.waitFor('Value for secret anthropic-main (input is hidden): ');
    stored.write(`${value}\r`);
    await stored.waitFor('Enter it again to confirm: ');
    stored.write(`${value}\r`);
    await stored.waitFor('stored secret anthropic-main');
    expect(await stored.exit()).toEqual({ code: 0, signal: null });
    expect(stored.screen()).not.toContain(value);
    expect(JSON.parse(fs.readFileSync(path.join(home.root, SECRETS_FILE_NAME), 'utf8'))).toEqual({ 'anthropic-main': value });

    const mismatched = await spawnWithFakes(home, ['secret', 'set', 'other-key']);
    await mismatched.waitFor('Value for secret other-key');
    mismatched.write('first-value\r');
    await mismatched.waitFor('Enter it again');
    mismatched.write('second-value\r');
    await mismatched.waitFor('the two entries differ; nothing was stored');
    expect(await mismatched.exit()).toEqual({ code: 1, signal: null });
    expect(mismatched.screen()).not.toContain('first-value');
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(home.root, SECRETS_FILE_NAME), 'utf8')))).toEqual(['anthropic-main']);

    const refused = await runCli(home, ['secret', 'set', 'bad name']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('does not match');
  });
});

describe('the startup screen through a pty', () => {
  it('shows the squirrel, the version, the model with its target and the mode above the first prompt', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepareProduct();
    const pty = await spawnWithFakes(home);
    await pty.waitFor('Do you trust the files in');
    pty.write('1');
    await pty.waitFor('model: default → primary');
    const screen = pty.screen();
    console.log(screen.slice(screen.indexOf('╭')));
    expect(screen).toContain('MomongaCode v0.0.0');
    expect(screen).toContain('(•ᴥ•)');
    expect(screen).toContain('mode: default');
    await leave(pty);
  });
});

describe('skills, memory and images in the terminal', () => {
  it(titleOf('cli-skill-pty'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepareProduct({ script: [textReply('Used the skill.')] });
    writeUserSkill(home, 'pdf', 'Extract PDF text');
    const pty = await spawnWithFakes(home);
    await trustAndWait(pty);

    pty.write('/pd');
    await pty.waitFor('/pdf (tab completes)');
    pty.write('\t');
    await pty.waitFor('> /pdf');
    pty.write('summarize the report');
    await pty.waitFor('> /pdf summarize the report');
    pty.write(KEYS.enter);
    await pty.waitFor('Used the skill.');
    expect(requestText(chatCompletions(fake)[0])).toContain('Activated skill pdf');
    expect(requestText(chatCompletions(fake)[0])).toContain('summarize the report');
    await leave(pty);
  });

  it(titleOf('cli-memory-pty'), { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async () => {
    const note = 'The team deploys with pnpm and needs the staging VPN.';
    const { home } = await prepareProduct({ script: [toolCallReply('MemorySave', { text: note, scope: 'user' }, 'call_mem'), textReply('Saved.')] });
    expect((await runCli(home, ['-p', 'Remember how we deploy', '--dangerously-skip-permissions'])).code).toBe(0);
    const id = (await runCli(home, ['memory', 'list'])).stdout.split(/\s+/)[0] ?? '';
    const pty = await spawnWithFakes(home);
    await trustAndWait(pty);

    await submit(pty, '/memory');
    await pty.waitFor(`${id}  [user]  ${note}`);
    await submit(pty, `/memory show ${id}`);
    await pty.waitFor('source: session');
    await submit(pty, `/memory delete ${id}`);
    await pty.waitFor(`deleted memory ${id}`);
    await submit(pty, '/memory');
    await pty.waitFor('no memories');
    expect((await runCli(home, ['memory', 'list'])).stdout).toBe('no memories\n');
    await leave(pty);
  });

  it(titleOf('cli-image-pty'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepareProduct({ imageInput: true, script: [textReply('It is a picture.')] });
    const shot = writePng(home.project, 'shot.png');
    const pty = await spawnWithFakes(home);
    await trustAndWait(pty);
    await pty.waitFor('image input: paste a file path');

    pty.write(pasted(shot));
    await pty.waitFor('attached shot.png (image/png');
    await submit(pty, 'what is in it');
    await pty.waitFor('It is a picture.');
    expect(requestText(chatCompletions(fake)[0])).toContain(`data:image/png;base64,${PNG_BYTES.toString('base64')}`);
    await leave(pty);
  });
});

describe('MCP input in the terminal', () => {
  it(titleOf('cli-elicit-pty'), { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async () => {
    const fixture = await startMcpHttpFixture({ era: 'modern' });
    try {
      const { home, fake } = await prepareProduct({
        script: [toolCallReply('mcp__remote__mrtr_elicit', {}, 'call_form'), textReply('form done'), toolCallReply('mcp__remote__mrtr_url', {}, 'call_url'), textReply('link done')],
        settings: { mcpServers: { remote: { type: 'http', url: fixture.url } } },
      });
      const pty = await spawnWithFakes(home, ['--dangerously-skip-permissions']);
      await trustAndWait(pty, 'bypassPermissions');

      await submit(pty, 'ask me who I am');
      await pty.waitFor('MCP server remote asks for input');
      await pty.waitFor('Who are you?');
      await pty.waitFor('name (name, string, required)');
      pty.write('Ada');
      await pty.waitFor('> Ada');
      pty.write(KEYS.enter);
      await pty.waitFor('1. Submit');
      pty.write('1');
      await pty.waitFor('form done');
      expect(requestText(chatCompletions(fake)[1])).toContain('hello Ada');

      await submit(pty, 'connect my account');
      await pty.waitFor('Connect your account.');
      await pty.waitFor('URL: https://example.test/connect?s=1');
      expect(fs.existsSync(path.join(home.root, OPEN_LOG_FILE_NAME))).toBe(false);
      await pty.waitFor('1. Open the URL in the browser and accept');
      pty.write('1');
      await pty.waitFor('link done');
      expect(fs.readFileSync(path.join(home.root, OPEN_LOG_FILE_NAME), 'utf8')).toBe('https://example.test/connect?s=1\n');
      expect(requestText(chatCompletions(fake)[3])).toContain('link accept');
      await leave(pty);
    } finally {
      await fixture.close();
    }
  });

  it(titleOf('cli-startup-notices'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepareProduct();
    const agents = path.join(home.project, '.momonga', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'broken.md'), '---\nname: broken\n---\nYou are broken.\n');
    const skills = path.join(home.project, '.agents', 'skills', 'nameless');
    fs.mkdirSync(skills, { recursive: true });
    fs.writeFileSync(path.join(skills, 'SKILL.md'), '---\nname: nameless\n---\nBody.\n');
    const pty = await spawnWithFakes(home);
    await pty.waitFor('Do you trust the files in');
    pty.write('1');
    await pty.waitFor('model: default → primary');
    await pty.waitFor('! Agent at');
    await pty.waitFor('broken.md was skipped: the description is missing or empty');
    await pty.waitFor('! Skill at');
    await pty.waitFor('SKILL.md was skipped: the description is missing or empty');
    await leave(pty);
  });
});
