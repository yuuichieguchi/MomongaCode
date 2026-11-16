import fs from 'node:fs';
import type { LocalServerDetection } from '@momonga/protocol';
import { describe, expect, it, vi } from 'vitest';
import { untilFrame } from './ink-helpers.ts';
import { PLAN_TEST_TIMEOUT_MS, choose, startPlan } from './fake-plan-gateway.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const managed: LocalServerDetection = { shape: 'managed', id: 'fm', label: 'the Apple on-device model', provider: 'apple', binary: '/usr/bin/fm' };
const refused: LocalServerDetection = {
  shape: 'managed',
  id: 'gated-server',
  label: 'the server gated-server',
  provider: 'someone',
  binary: '/opt/gated/serve',
  refused: { message: 'the licence has not been accepted', remedy: 'gated license' },
};
const ollama: LocalServerDetection = { kind: 'ollama', provider: 'ollama', address: 'http://127.0.0.1:11434', models: [{ id: 'bare:3b', tools: 'no' }] };

describe('server programs in the list of local servers (O-R5-5 item 4, S7, S10)', () => {
  it('shows a row for a usable program, a disabled row with its remedy for a refused one, and a row for the servers that answered', async () => {
    const { app } = await startPlan({ models: [], accounts: [], detected: [managed, refused, ollama] });
    await choose(app, 'Use a local server');
    const frame = await untilFrame(app, 'Use the Apple on-device model');
    expect(frame).toContain('A model server that answered');
    expect(frame).toContain('Use the server gated-server · the licence has not been accepted (gated license)');
    app.unmount();
  });

  it('reads the model of the chosen program by starting it once and writes its connection after the confirm row, and nothing for the refused one', async () => {
    const { app, backend } = await startPlan({ models: [], accounts: [], detected: [managed, refused], programModel: 'apple-fm' });
    await choose(app, 'Use a local server');
    await choose(app, 'Use the Apple on-device model');
    await untilFrame(app, 'Add apple-fm to your settings?');
    expect(fs.existsSync(backend.modelsFile())).toBe(false);
    await choose(app, 'Yes');
    await backend.called('openSession');
    const written = JSON.parse(fs.readFileSync(backend.modelsFile(), 'utf8')) as { models: { connections: unknown[] } };
    expect(written.models.connections).toMatchObject([{ adapter: 'managed', server: 'fm', models: [{ id: 'apple-fm' }] }]);
    app.unmount();
  });
});
