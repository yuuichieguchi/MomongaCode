import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '@momonga/testkit';
import { momongaLayout } from '@momonga/foundation';
import { environmentSnapshot } from '../../src/run/open-session.ts';

describe('the environment snapshot of a session', () => {
  it('reads the settings under the signal it is given: an aborted signal ends the read with its reason', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const { settingsFile } = momongaLayout(home, process.platform, process.env);
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(settingsFile, JSON.stringify({ models: {} }), { mode: 0o600 });
    const controller = new AbortController();
    const reason = new Error('the snapshot is cancelled');
    controller.abort(reason);

    await expect(environmentSnapshot({ home, env: {} }, controller.signal)).rejects.toBe(reason);
  });
});
