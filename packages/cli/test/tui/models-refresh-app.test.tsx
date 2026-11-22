import { describe, expect, it, vi } from 'vitest';
import { account } from '../fake-plan-gateway.tsx';
import { KEYS } from '../ink-helpers.ts';
import { ollamaFound, OLLAMA_ADDRESS } from '../models-shell-harness.ts';
import { highlighted, hold, NOTHING_HELD, startAtRealTiming } from './keys-shown-screen.tsx';
import type { AtRealTiming } from './keys-shown-screen.tsx';
import { toRow } from './keys-shown-screen-cases.tsx';
import { freshPlace } from './settings-harness.tsx';

vi.setConfig({ testTimeout: 30_000 });

const MODEL = 'ollama/qwen3.8:27b';

const openAdd = async (driver: AtRealTiming, entry: '/model' | '/config'): Promise<void> => {
  await driver.submit(entry);
  if (entry === '/model') {
    await driver.untilShown('Model settings…');
    await driver.settled();
    await toRow(driver, 'Model settings…');
  } else {
    await driver.untilShown('Open the settings file');
    await driver.settled();
    await driver.step('Models', 'filter: Models');
    await toRow(driver, 'Models');
  }
  await driver.step(KEYS.enter, 'Add a model');
  await toRow(driver, 'Add a model');
  await driver.step(KEYS.enter, highlighted('Search this computer for model servers'));
  await driver.step(KEYS.enter, highlighted('ollama'));
};

describe('adding a local model refreshes the connection while Models remains open', () => {
  it.each(['/model', '/config'] as const)('updates the banner and footer when opened from %s', async (entry) => {
    const place = freshPlace();
    let opening = NOTHING_HELD;
    const driver = await startAtRealTiming({
      options: {
        models: [],
        accounts: [account({ active: false })],
        session: { model: MODEL },
        detected: [ollamaFound(OLLAMA_ADDRESS, ['qwen3.8:27b'])],
        settingsPlace: { home: place.home, projectDir: place.project },
      },
      extra: { startup: { version: '1.2.3', home: place.home } },
      ready: 'no model connected · /login',
      prepare: (backend) => { opening = hold(backend, 'openSession'); },
    });

    await openAdd(driver, entry);
    await toRow(driver, `ollama  ·  ${OLLAMA_ADDRESS}  ·  1 model`);
    await driver.step(KEYS.enter, 'ollama/qwen3.8:27b');
    await toRow(driver, 'ollama/qwen3.8:27b');
    await driver.step(KEYS.enter, 'Add ollama/qwen3.8:27b to your settings?');
    driver.app.stdin.write(KEYS.down);
    await driver.untilShown(highlighted('Yes'));
    driver.app.stdin.write(KEYS.enter);
    await driver.until(() => opening.calls() === 1, 'the committed write starts opening a session');
    await driver.burst([[KEYS.down, 0], [KEYS.enter, 20]]);
    expect(opening.calls()).toBe(1);
    opening.release();

    const connected = await driver.until(
      (frame) => frame.includes(`model: ${MODEL}`) && frame.split('\n').some((row) => row.trim() === MODEL) && highlighted('Add a model')(frame),
      'the banner and footer show the model while the Models panel is open',
    ).catch((error: unknown) => { throw new Error(driver.frameNow(), { cause: error }); });
    expect(connected).not.toContain('no model connected · /login');
    expect(driver.backend.opened).toHaveLength(1);

    await driver.step(KEYS.escape, entry === '/model' ? 'Model settings…' : 'Open the settings file');
    expect(driver.backend.opened).toHaveLength(1);
    driver.app.unmount();
  });
});
