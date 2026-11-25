import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startMcpHttpFixture } from '@momonga/testkit';
import cliPackage from '../packages/cli/package.json' with { type: 'json' };
import { ART_WIDTH } from '../packages/cli/src/tui/figure.ts';
import { ART_GAP } from '../packages/cli/src/tui/startup.tsx';
import { titleOf } from './support/cases.ts';
import { OPEN_LOG_FILE_NAME, SECRETS_FILE_NAME, runCli } from './support/cli.ts';
import type { E2eHome } from './support/home.ts';
import { PNG_BYTES, WINDOW_WITH_ROOM_FOR_ALL_TOOLS_AND_AN_IMAGE, prepareProduct, requestText, writePng, writeUserSkill } from './support/product.ts';
import { answerTrust, spawnPty, untilRunEnds } from './support/pty.ts';
import type { Frame, Proof, PtySession } from './support/pty.ts';
import { chatCompletions, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

const spawnWithFakes = (home: E2eHome, args: readonly string[] = []): Promise<PtySession> => spawnPty(home, args, {}, { fakes: true });

const trustAndWait = async (pty: PtySession, mode = 'manual'): Promise<void> => {
  await answerTrust(pty, 'trust');
  await pty.waitFor({ shows: `mode: ${mode}`, in: 'footer' });
};

const submit = async (pty: PtySession, text: string, until: Proof): Promise<Frame> => {
  await pty.type(text);
  return pty.key('enter', { until });
};

const leave = async (pty: PtySession): Promise<void> => {
  await pty.key('ctrlD', { until: 'Press ctrl+d again to exit' });
  expect((await pty.key('ctrlD', { until: 'exit' })).status).toEqual({ code: 0, signal: null });
};

const DRAFT_SECOND_ROW = /^│ {3} *│$/;

const BANNER_GUTTER = ART_WIDTH + ART_GAP + 1;
const BANNER_WRAP = `(?: +| *│ *\\n│(?: |[^\\n]{${BANNER_GUTTER}}))`;

const wrappedText = (phrase: string): RegExp => new RegExp(phrase.split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(BANNER_WRAP));

describe('momonga secret set through a pty', () => {
  it(titleOf('cli-secret'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepareProduct();
    const value = 'sk-fake-hidden-value-0123456789';

    const stored = await spawnWithFakes(home, ['secret', 'set', 'anthropic-main']);
    await stored.waitFor('Value for secret anthropic-main (input is hidden): ');
    await stored.write(value);
    await stored.key('enter', { until: 'Enter it again to confirm: ' });
    await stored.write(value);
    await stored.key('enter', { until: 'stored secret anthropic-main' });
    const storedExit = await stored.exit();
    expect(storedExit.status).toEqual({ code: 0, signal: null });
    expect(storedExit.frame.lines.join('\n')).not.toContain(value);
    expect(JSON.parse(fs.readFileSync(path.join(home.root, SECRETS_FILE_NAME), 'utf8'))).toEqual({ 'anthropic-main': value });

    const mismatched = await spawnWithFakes(home, ['secret', 'set', 'other-key']);
    await mismatched.waitFor('Value for secret other-key');
    await mismatched.write('first-value');
    await mismatched.key('enter', { until: 'Enter it again' });
    await mismatched.write('second-value');
    await mismatched.key('enter', { until: 'the two entries differ; nothing was stored' });
    const mismatchedExit = await mismatched.exit();
    expect(mismatchedExit.status).toEqual({ code: 1, signal: null });
    expect(mismatchedExit.frame.lines.join('\n')).not.toContain('first-value');
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(home.root, SECRETS_FILE_NAME), 'utf8')))).toEqual(['anthropic-main']);

    const refused = await runCli(home, ['secret', 'set', 'bad name']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('does not match');
  });
});

describe('the startup screen through a pty', () => {
  it('shows the squirrel, the version and the model by its own name on the start screen, and the mode only in the footer (design-screens 6.4)', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepareProduct();
    const pty = await spawnWithFakes(home);
    await answerTrust(pty, 'trust');
    const { rows: shown } = await pty.waitFor({ shows: 'mode: manual (shift+tab)', in: 'footer' });
    const banner = shown.filter((line) => line.startsWith('│'));
    const screen = shown.join('\n');
    expect(banner.some((line) => line.includes('(•ᴥ•)')), screen).toBe(true);
    expect(banner.some((line) => line.includes(`MomongaCode v${cliPackage.version}`)), screen).toBe(true);
    const modelLines = banner.filter((line) => /model: \S/.test(line));
    expect(modelLines, screen).toHaveLength(1);
    expect(modelLines[0], screen).not.toMatch(/model: default|→/);
    expect(banner.some((line) => line.includes('mode:')), screen).toBe(false);
    expect(shown.filter((line) => line.startsWith('mode: manual (shift+tab)')), screen).toHaveLength(1);
    await leave(pty);
  });
});

describe('skills, memory and images in the terminal', () => {
  it(titleOf('cli-skill-pty'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepareProduct({ script: [textReply('Used the skill.')] });
    writeUserSkill(home, 'pdf', 'Extract PDF text');
    const pty = await spawnWithFakes(home);
    await trustAndWait(pty);

    await pty.type('/pd');
    await pty.waitFor('› /pdf <task>  Extract PDF text');
    await pty.key('tab', { until: { shows: '> /pdf', in: 'input' } });
    await pty.type('summarize the report');
    await pty.key('enter', { until: 'Used the skill.' });
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

    await submit(pty, '/memory', `${id}  [user]  ${note}`);
    await submit(pty, `/memory show ${id}`, 'source: session');
    await submit(pty, `/memory delete ${id}`, `retired memory ${id}`);
    await submit(pty, '/memory', 'no memories');
    expect((await runCli(home, ['memory', 'list'])).stdout).toBe('no memories\n');
    await leave(pty);
  });

  it(titleOf('cli-image-pty'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepareProduct({ imageInput: true, contextWindow: WINDOW_WITH_ROOM_FOR_ALL_TOOLS_AND_AN_IMAGE, script: [textReply('It is a picture.')] });
    const shot = writePng(home.project, 'shot.png');
    const pty = await spawnWithFakes(home);
    await trustAndWait(pty);
    await pty.waitFor('image input: paste a file path');

    await pty.paste(shot, { until: 'attached shot.png (image/png' });
    await submit(pty, 'what is in it', 'It is a picture.');
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

      await submit(pty, 'ask me who I am', 'MCP server remote asks for input');
      await pty.waitFor('Who are you?');
      await pty.waitForPrompt('name (name, string, required)');
      await pty.type('Ada');
      await pty.key('enter', { until: '1. Submit' });
      await pty.waitForPrompt('1. Submit');
      await pty.key('1', { until: 'form done' });
      await untilRunEnds(pty, 'bypassPermissions');
      expect(requestText(chatCompletions(fake)[1])).toContain('hello Ada');

      await submit(pty, 'connect my account', 'Connect your account.');
      await pty.waitFor('URL: https://example.test/connect?s=1');
      expect(fs.existsSync(path.join(home.root, OPEN_LOG_FILE_NAME))).toBe(false);
      await pty.waitForPrompt('1. Open the URL in the browser and accept');
      await pty.key('down', { until: '› 2. Decline' });
      await pty.key('1', { until: '› 1. Open the URL in the browser and accept' });
      await pty.key('enter', { until: 'link done' });
      expect(fs.readFileSync(path.join(home.root, OPEN_LOG_FILE_NAME), 'utf8')).toBe('https://example.test/connect?s=1\n');
      expect(requestText(chatCompletions(fake)[3])).toContain('link accept');
      await leave(pty);
    } finally {
      await fixture.close();
    }
  });

  it(titleOf('cli-start-keys-pty'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepareProduct({ script: [textReply('noted 1a')] });
    const pty = await spawnWithFakes(home);
    await trustAndWait(pty);
    await pty.type('1a');
    await pty.key('ctrlJ', { until: { caretOn: DRAFT_SECOND_ROW } });
    await pty.key('up', { until: { caretOn: '> 1a' } });
    await pty.key('down', { until: { caretOn: DRAFT_SECOND_ROW } });
    await pty.key('enter', { until: 'noted 1a' });
    await untilRunEnds(pty, 'manual');
    expect(requestText(chatCompletions(fake)[0])).toContain('1a');
    expect(fs.existsSync(path.join(home.root, OPEN_LOG_FILE_NAME))).toBe(false);
    await leave(pty);
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
    await answerTrust(pty, 'trust');
    await pty.waitFor({ shows: 'mode: manual (shift+tab)', in: 'footer' });
    await pty.waitFor('! Agent at');
    await pty.waitFor(wrappedText('broken.md was skipped: the description is missing or empty'));
    await pty.waitFor('! Skill at');
    await pty.waitFor(wrappedText('SKILL.md was skipped: the description is missing or empty'));
    await leave(pty);
  });
});
