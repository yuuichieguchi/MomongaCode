import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPEN_LOG_FILE_NAME } from './support/cli.ts';
import { prepareProduct } from './support/product.ts';
import { KEYS, answerTrust, spawnPty } from './support/pty.ts';
import { E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

describe('the sandbox-off dialog of a sign-in, reached through a runtime whose sandbox is none', () => {
  it('asks before a sign-in when the runtime runs with sandbox none, starts on Cancel, and escape starts no sign-in and opens no browser', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepareProduct({ settings: { sandbox: 'none' } });
    const pty = await spawnPty(home, [], {}, { fakes: true });
    await answerTrust(pty, 'trust');
    await pty.waitFor('mode: manual');
    pty.write('/login chatgpt');
    await pty.waitFor('> /login chatgpt');
    pty.write(KEYS.enter);
    await pty.waitFor('Continue with ChatGPT');
    pty.write(KEYS.enter);
    await pty.waitFor('The sandbox is off');
    expect(pty.screen()).toContain('› 2. Cancel');
    pty.write(KEYS.escape);
    await pty.waitFor('mode: manual');
    expect(pty.visible().join('\n')).not.toContain('The sandbox is off');
    expect(fs.existsSync(path.join(home.root, OPEN_LOG_FILE_NAME))).toBe(false);
    pty.write(KEYS.ctrlD);
    await pty.waitFor('Press ctrl+d again to exit');
    pty.write(KEYS.ctrlD);
    expect(await pty.exit()).toEqual({ code: 0, signal: null });
  });
});
