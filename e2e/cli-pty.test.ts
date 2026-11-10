import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { titleOf } from './support/cases.ts';
import { readDb } from './support/db.ts';
import { createE2eHome } from './support/home.ts';
import { KEYS, spawnPty, untilRunEnds } from './support/pty.ts';
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
    await pty.waitFor('Do you trust the files in');
    pty.write('1');
    await pty.waitFor('mode: manual');

    pty.write(KEYS.shiftTab);
    await pty.waitFor('mode: acceptEdits');
    pty.write(KEYS.shiftTab);
    await pty.waitFor('mode: plan');
    pty.write(KEYS.shiftTab);
    await pty.waitFor('mode: manual');

    pty.write('change the greeting');
    await pty.waitFor('> change the greeting');
    pty.write(KEYS.enter);
    await pty.waitFor('Permission requested');
    await pty.waitFor('+ "hello, momonga"');
    expect(pty.screen()).toContain('- "hello"');
    pty.write('1');
    await pty.waitFor('Edited the greeting.');
    expect(fs.readFileSync(target, 'utf8')).toBe('greeting = "hello, momonga"\n');

    pty.write(KEYS.ctrlD);
    await pty.waitFor('Press ctrl+d again to exit');
    pty.write(KEYS.ctrlD);
    expect(await pty.exit()).toEqual({ code: 0, signal: null });
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
    await pty.waitFor('Do you trust the files in');
    pty.write('1');
    await pty.waitFor('mode: manual');
    pty.write('change the greeting');
    await pty.waitFor('> change the greeting');
    pty.write(KEYS.enter);
    await pty.waitFor('waiting for subagent editor');
    await pty.waitFor('Permission requested: editor: Edit');
    await pty.waitFor('+ "hello, momonga"');
    expect(fs.readFileSync(target, 'utf8')).toBe('greeting = "hello"\n');
    pty.write('1');
    await pty.waitFor('Edited the greeting.');
    expect(fs.readFileSync(target, 'utf8')).toBe('greeting = "hello, momonga"\n');

    pty.write(KEYS.ctrlD);
    await pty.waitFor('Press ctrl+d again to exit');
    pty.write(KEYS.ctrlD);
    expect(await pty.exit()).toEqual({ code: 0, signal: null });
  });

  it(titleOf('cli-pty-session'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const fake = await startUpstream(home, { home, script: [hangReply('working on it')] });
    writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));

    const pty = await spawnPty(home, []);
    await pty.waitFor('Do you trust the files in');
    pty.write('2');
    await pty.waitFor('mode: manual');

    pty.write('/help');
    await pty.waitFor('> /help');
    pty.write(KEYS.enter);
    await pty.waitFor('Commands');
    for (const command of ['/help', '/clear', '/mode', '/exit']) expect(pty.sinceLastWrite()).toContain(command);

    pty.write('/mode plan');
    await pty.waitFor('> /mode plan');
    pty.write(KEYS.enter);
    await pty.waitFor('mode: plan');
    pty.write(KEYS.shiftTab);
    await pty.waitFor('mode: manual');

    pty.write('line one\\');
    await pty.waitFor('line one\\');
    pty.write(KEYS.enter);
    await pty.waitFor('line one');
    pty.write('line two');
    await pty.waitFor('line two');
    pty.write(KEYS.enter);
    await pty.waitFor('working (esc to cancel)');
    await until(() => chatCompletions(fake).length > 0, { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the upstream to receive the request' });
    expect(messagesOf(chatCompletions(fake)[0]).at(-1)?.content).toContain('line one\nline two');

    pty.write(KEYS.escape);
    await pty.waitFor('CANCELLED');
    await untilRunEnds(pty, 'manual');

    pty.write(KEYS.up);
    await pty.waitFor('line two');
    pty.write(KEYS.ctrlC);
    pty.write('/exit');
    await pty.waitFor('> /exit');
    pty.write(KEYS.enter);
    expect(await pty.exit()).toEqual({ code: 0, signal: null });
    const history = fs.readFileSync(path.join(home.paths.state, 'history.jsonl'), 'utf8').split('\n').filter((line) => line !== '');
    expect(history.map((line) => JSON.parse(line))).toEqual(['/help', '/mode plan', 'line one\nline two', '/exit']);
  });

  it(titleOf('cli-pty-exit-running'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const fake = await startUpstream(home, { home, script: [hangReply('still thinking')] });
    writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));

    const pty = await spawnPty(home, []);
    await pty.waitFor('Do you trust the files in');
    pty.write('1');
    await pty.waitFor('mode: manual');
    pty.write('a long task');
    await pty.waitFor('> a long task');
    pty.write(KEYS.enter);
    await until(() => chatCompletions(fake).length > 0, { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the upstream to receive the request' });
    await pty.waitFor('working (esc to cancel)');

    pty.write('/exit');
    await pty.waitFor('> /exit');
    pty.write(KEYS.enter);
    expect(await pty.exit()).toEqual({ code: 0, signal: null });

    const [row] = readDb<{ status: string }>(home.paths.databases.runtime, 'SELECT status FROM runs');
    expect(row?.status).toBe('RUNNING');
  });
});
