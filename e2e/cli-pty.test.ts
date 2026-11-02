import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { titleOf } from './support/cases.ts';
import { createE2eHome } from './support/home.ts';
import { KEYS, spawnPty } from './support/pty.ts';
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
    await pty.waitFor('mode: default');

    pty.write(KEYS.shiftTab);
    await pty.waitFor('mode: acceptEdits');
    pty.write(KEYS.shiftTab);
    await pty.waitFor('mode: plan');
    pty.write(KEYS.shiftTab);
    await pty.waitFor('mode: default');

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
    expect(await pty.exit()).toEqual({ code: 0, signal: null });
  });

  it(titleOf('cli-pty-session'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const fake = await startUpstream(home, { home, script: [hangReply('working on it')] });
    writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));

    const pty = await spawnPty(home, []);
    await pty.waitFor('Do you trust the files in');
    pty.write('2');
    await pty.waitFor('mode: default');

    pty.write('/help');
    await pty.waitFor('> /help');
    pty.write(KEYS.enter);
    await pty.waitFor('Slash commands');
    for (const command of ['/help', '/clear', '/mode', '/exit']) expect(pty.sinceLastWrite()).toContain(command);

    pty.write('/mode plan');
    await pty.waitFor('> /mode plan');
    pty.write(KEYS.enter);
    await pty.waitFor('mode: plan');
    pty.write(KEYS.shiftTab);
    await pty.waitFor('mode: default');

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
    await pty.waitFor(/mode: default \(shift\+tab\) · tokens: \d+( · context: \d+%)?\s*$/);

    pty.write(KEYS.up);
    await pty.waitFor('line two');
    pty.write(KEYS.ctrlC);
    pty.write('/exit');
    await pty.waitFor('> /exit');
    pty.write(KEYS.enter);
    expect(await pty.exit()).toEqual({ code: 0, signal: null });
  });
});
