import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { titleOf } from './support/cases.ts';
import { OPEN_LOG_FILE_NAME } from './support/cli.ts';
import { prepareProduct } from './support/product.ts';
import { answerTrust, spawnPty } from './support/pty.ts';
import { E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

describe('the sandbox-off dialog of a sign-in, reached through a runtime whose sandbox is none', () => {
  it(titleOf('sandbox-off-dialog'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepareProduct({ settings: { sandbox: 'none' } });
    const pty = await spawnPty(home, [], {}, { fakes: true });
    await answerTrust(pty, 'trust');
    await pty.waitFor({ shows: 'mode: manual', in: 'footer' });
    await pty.type('/login chatgpt');
    await pty.key('enter', { until: 'The sandbox is off' });
    const dialog = await pty.waitForPrompt('The sandbox is off');
    expect(dialog.rows.join('\n')).toContain('› 2. Cancel');
    const closed = await pty.key('escape', { until: [{ lacks: 'The sandbox is off' }, { shows: 'mode: manual', in: 'footer' }] });
    expect(closed.region('input')).toEqual(['>']);
    expect(fs.existsSync(path.join(home.root, OPEN_LOG_FILE_NAME))).toBe(false);
    await pty.key('ctrlD', { until: 'Press ctrl+d again to exit' });
    expect((await pty.key('ctrlD', { until: 'exit' })).status).toEqual({ code: 0, signal: null });
  });
});
