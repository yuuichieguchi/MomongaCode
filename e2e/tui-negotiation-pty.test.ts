import { describe, expect, it } from 'vitest';
import { titleOf } from './support/cases.ts';
import { createE2eHome } from './support/home.ts';
import { answerTrust, KEYS, spawnPty } from './support/pty.ts';
import { baseSettings, sandboxChoiceOf, startUpstream, writeSettingsFile } from './support/stack.ts';
import { E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

describe('tui: terminal negotiation through a pty', () => {
  it(titleOf('tui-negotiation-pty'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    await startUpstream(home, { home, script: [] });
    writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));

    const pty = await spawnPty(home, []);
    await answerTrust(pty, 'trust');
    await pty.waitFor('mode: manual');
    const shown = pty.visible();
    const screen = shown.join('\n');
    expect(screen, screen).toContain('(•ᴥ•)');
    expect(screen, screen).toMatch(/MomongaCode v\S+/);
    expect(screen, screen).toMatch(/model: \S+/);
    expect(screen, screen).toContain('mode: manual (shift+tab)');

    pty.write(KEYS.ctrlD);
    await pty.waitFor('Press ctrl+d again to exit');
    pty.write(KEYS.ctrlD);
    expect(await pty.exit()).toEqual({ code: 0, signal: null });
  });
});
