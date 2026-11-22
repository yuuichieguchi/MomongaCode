import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { titleOf } from './support/cases.ts';
import { readDb } from './support/db.ts';
import { createE2eHome } from './support/home.ts';
import { answerTrust, spawnPty, untilRunEnds } from './support/pty.ts';
import { baseSettings, sandboxChoiceOf, startUpstream, writeSettingsFile } from './support/stack.ts';
import { chatCompletions, hangReply, messagesOf, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

describe('cli: interactive TUI through a pty', () => {
  it(titleOf('cli-pty-approval'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const project = fs.realpathSync.native(home.project);
    const target = path.join(project, 'config.toml');
    fs.writeFileSync(target, 'greeting = "hello"\n');
    await startUpstream(home, {
      home,
      script: [
        toolCallReply('Read', { file_path: target }, 'call_read'),
        toolCallReply('Edit', { file_path: target, old_string: '"hello"', new_string: '"hello, momonga"' }, 'call_edit'),
        textReply('Edited the greeting.'),
      ],
    });
    writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));

    const pty = await spawnPty(home, []);
    await answerTrust(pty, 'trust');
    await pty.waitFor({ shows: 'mode: manual', in: 'footer' });

    await pty.key('shiftTab', { until: { shows: 'mode: acceptEdits', in: 'footer' } });
    await pty.key('shiftTab', { until: { shows: 'mode: plan', in: 'footer' } });
    await pty.key('shiftTab', { until: { shows: 'mode: manual', in: 'footer' } });

    await pty.type('change the greeting');
    await pty.key('enter', { until: 'Permission requested: Edit config.toml' });
    const prompt = await pty.waitForPrompt('+greeting = "hello, momonga"');
    expect(prompt.rows.join('\n')).toContain('-greeting = "hello"');
    await pty.key('1', { until: 'Edited the greeting.' });
    expect(fs.readFileSync(target, 'utf8')).toBe('greeting = "hello, momonga"\n');

    await pty.key('ctrlD', { until: 'Press ctrl+d again to exit' });
    expect((await pty.key('ctrlD', { until: 'exit' })).status).toEqual({ code: 0, signal: null });
  });

  it(titleOf('cli-pty-child-approval'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const project = fs.realpathSync.native(home.project);
    const target = path.join(project, 'config.toml');
    fs.writeFileSync(target, 'greeting = "hello"\n');
    await startUpstream(home, {
      home,
      script: [
        toolCallReply('Agent', { description: 'edit', prompt: 'Change the greeting', subagent_type: 'editor' }, 'call_agent'),
        toolCallReply('Read', { file_path: target }, 'call_child_read'),
        toolCallReply('Edit', { file_path: target, old_string: '"hello"', new_string: '"hello, momonga"' }, 'call_child_edit'),
        textReply('child edited the greeting'),
        textReply('Edited the greeting.'),
      ],
    });
    writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));
    fs.mkdirSync(home.paths.agents, { recursive: true });
    fs.writeFileSync(path.join(home.paths.agents, 'editor.md'), '---\nname: editor\ndescription: edits files\ntools: Read, Edit\n---\nYou edit files.\n');

    const pty = await spawnPty(home, []);
    await answerTrust(pty, 'trust');
    await pty.waitFor({ shows: 'mode: manual', in: 'footer' });
    await pty.type('change the greeting');
    await pty.key('enter', { until: 'waiting for subagent editor' });
    await pty.waitFor('Permission requested: editor: Edit');
    await pty.waitForPrompt('+greeting = "hello, momonga"');
    expect(fs.readFileSync(target, 'utf8')).toBe('greeting = "hello"\n');
    await pty.key('1', { until: 'Edited the greeting.' });
    expect(fs.readFileSync(target, 'utf8')).toBe('greeting = "hello, momonga"\n');

    await pty.key('ctrlD', { until: 'Press ctrl+d again to exit' });
    expect((await pty.key('ctrlD', { until: 'exit' })).status).toEqual({ code: 0, signal: null });
  });

  it(titleOf('cli-pty-session'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const fake = await startUpstream(home, { home, script: [hangReply('working on it')] });
    writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));

    const pty = await spawnPty(home, []);
    await answerTrust(pty, 'decline');
    await pty.waitFor({ shows: 'mode: manual', in: 'footer' });

    await pty.type('/help');
    await pty.key('enter', { until: { shows: 'click on a menu row  complete it', in: 'transcript' } });
    const top = await pty.key('ctrlHome', {
      until: [
        { shows: /^Commands[^\n]*\n  \/help  list the commands/m, in: 'transcript' },
        { lacks: 'click on a menu row  complete it', in: 'transcript' },
      ],
    });
    for (const command of ['/help', '/clear', '/mode', '/exit']) expect(top.region('transcript').join('\n')).toContain(command);
    await pty.key('ctrlEnd', { until: { shows: 'click on a menu row  complete it', in: 'transcript' } });

    await pty.type('/mode plan');
    await pty.key('enter', { until: { shows: 'mode: plan', in: 'footer' } });
    await pty.key('shiftTab', { until: { shows: 'mode: manual', in: 'footer' } });

    await pty.type('line one\\');
    await pty.key('enter', { until: { lacks: 'line one\\', in: 'input' } });
    await pty.type('line two');
    await pty.key('enter', { until: /\d+s · esc to cancel/ });
    await until(() => chatCompletions(fake).length > 0, { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the upstream to receive the request' });
    expect(messagesOf(chatCompletions(fake)[0]).at(-1)?.content).toContain('line one\nline two');

    await pty.key('escape', { until: 'CANCELLED' });
    await untilRunEnds(pty, 'manual');

    await pty.key('up', { until: { shows: 'line two', in: 'input' } });
    await pty.key('ctrlC', { until: { lacks: 'line', in: 'input' } });
    await pty.type('/exit');
    expect((await pty.key('enter', { until: 'exit' })).status).toEqual({ code: 0, signal: null });
    const history = fs.readFileSync(path.join(home.paths.state, 'history.jsonl'), 'utf8').split('\n').filter((line) => line !== '');
    expect(history.map((line) => JSON.parse(line))).toEqual(['/help', '/mode plan', 'line one\nline two', '/exit']);
  });

  it(titleOf('cli-pty-exit-running'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const fake = await startUpstream(home, { home, script: [hangReply('still thinking')] });
    writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));

    const pty = await spawnPty(home, []);
    await answerTrust(pty, 'trust');
    await pty.waitFor({ shows: 'mode: manual', in: 'footer' });
    await pty.type('a long task');
    await pty.key('enter', { until: /\d+s · esc to cancel/ });
    await until(() => chatCompletions(fake).length > 0, { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the upstream to receive the request' });

    await pty.type('/exit');
    expect((await pty.key('enter', { until: 'exit' })).status).toEqual({ code: 0, signal: null });

    const [row] = readDb<{ status: string }>(home.paths.databases.runtime, 'SELECT status FROM runs');
    expect(row?.status).toBe('RUNNING');
  });
});
