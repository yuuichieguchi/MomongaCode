import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { titleOf } from './support/cases.ts';
import { createE2eHome } from './support/home.ts';
import { KEYS, spawnPty } from './support/pty.ts';
import { baseSettings, sandboxChoiceOf, startUpstream, writeSettingsFile } from './support/stack.ts';
import { textReply, toolCallReply } from './support/upstream.ts';
import { E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

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
});
