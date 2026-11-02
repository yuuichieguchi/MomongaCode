import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { titleOf } from './support/cases.ts';
import { runCli } from './support/cli.ts';
import { createE2eHome } from './support/home.ts';
import { baseSettings, sandboxChoiceOf, startUpstream, writeSettingsFile } from './support/stack.ts';
import { chatCompletions, messagesOf, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

const ORIGINAL = 'greeting = "hello"\n';
const EDITED = 'greeting = "hello, momonga"\n';

describe('cli: momonga -p', () => {
  it(titleOf('cli-print'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const project = fs.realpathSync.native(home.project);
    const target = path.join(project, 'config.toml');
    fs.writeFileSync(target, ORIGINAL);
    const fake = await startUpstream(home, {
      home,
      script: [
        toolCallReply('Glob', { pattern: '*.toml', path: project }, 'call_glob'),
        toolCallReply('Read', { file_path: target }, 'call_read'),
        toolCallReply('Edit', { file_path: target, old_string: '"hello"', new_string: '"hello, momonga"' }, 'call_edit'),
        textReply('Updated the greeting in config.toml.'),
      ],
    });
    writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));

    const result = await runCli(home, ['-p', 'Update the greeting', '--permission-mode', 'acceptEdits']);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('Updated the greeting in config.toml.\n');
    expect(fs.readFileSync(target, 'utf8')).toBe(EDITED);
    const calls = chatCompletions(fake);
    expect(calls).toHaveLength(4);
    const toolMessages = messagesOf(calls[3]).filter((message) => message.role === 'tool');
    expect(toolMessages).toHaveLength(3);
  });
});
