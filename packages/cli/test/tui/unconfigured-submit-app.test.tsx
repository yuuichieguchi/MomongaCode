import { describe, expect, it, vi } from 'vitest';
import { KEYS, untilFrame, untilOutput } from '../ink-helpers.ts';
import { start } from '../tui-harness.tsx';

const GEMMA = 'ollama/gemma-3-4b:latest';
const QWEN = 'ollama/qwen3.8:27b';
const NOT_CONFIGURED = `The model "${GEMMA}" of this session is not configured any more. Choose another with /model.`;
const LIST = 'a change applies from the next run';

const typedOnUnconfigured = async () => {
  const started = await start({ session: { model: GEMMA }, models: [QWEN] });
  await untilOutput(started.app, NOT_CONFIGURED);
  started.app.stdin.write('hello');
  await untilFrame(started.app, '> hello');
  started.app.stdin.write(KEYS.enter);
  await untilFrame(started.app, LIST);
  return started;
};

describe('a message on a session whose model is not configured any more (cli-tui-C48)', () => {
  it('sends the message once when a model is chosen', async () => {
    const { app, backend } = await typedOnUnconfigured();
    app.stdin.write(KEYS.enter);
    await vi.waitFor(() => expect(backend.started).toEqual([{ text: 'hello' }]));
    app.unmount();
  });

  it('leaves the text in the draft when the list is left', async () => {
    const { app, backend } = await typedOnUnconfigured();
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (shown) => !shown.includes(LIST) && shown.includes('> hello'));
    expect(backend.started).toEqual([]);
    app.unmount();
  });
});
