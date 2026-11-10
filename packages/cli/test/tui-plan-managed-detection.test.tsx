import { describe, expect, it, vi } from 'vitest';
import { untilFrame } from './ink-helpers.ts';
import { PLAN_TEST_TIMEOUT_MS, choose, eventually, startPlan } from './fake-plan-gateway.tsx';
import type { DetectedServer } from './fake-plan-gateway.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const managed = { shape: 'managed', id: 'ready-server', provider: 'someone', binary: '/opt/ready/serve' } as unknown as DetectedServer;
const refused = {
  shape: 'managed',
  id: 'gated-server',
  provider: 'someone',
  binary: '/opt/gated/serve',
  refused: { message: 'the licence has not been accepted', remedy: 'gated license' },
} as unknown as DetectedServer;
const ollama: DetectedServer = { baseUrl: 'http://127.0.0.1:11434', shape: 'ollama', models: [{ id: 'bare:3b', tools: 'no' }] };

describe('managed servers and unusable models in the detection list (O-R5-5 item 4, S7, S10)', () => {
  it('shows a usable managed row, a disabled refused row with its remedy, and the Ollama row with no trained context', async () => {
    const { app } = await startPlan({ aliases: [], accounts: [], detected: [managed, refused, ollama] });
    await choose(app, 'Use a local server');
    const frame = await untilFrame(app, 'ready-server');
    expect(frame).toContain('ready-server · /opt/ready/serve · managed');
    expect(frame).toContain('gated-server · /opt/gated/serve · the licence has not been accepted (gated license)');
    expect(frame).toContain('bare:3b · http://127.0.0.1:11434 · the server reports no trained context length for this model');
    app.unmount();
  });

  it('writes a managed connection for the chosen managed row and nothing for the refused one', async () => {
    const { app, backend } = await startPlan({ aliases: [], accounts: [], detected: [managed, refused] });
    await choose(app, 'Use a local server');
    await untilFrame(app, 'ready-server');
    await choose(app, 'ready-server');
    await eventually(() => backend.connections.length > 0, 'the managed connection');
    expect(backend.connections).toHaveLength(1);
    expect(backend.connections[0]).toMatchObject({ kind: 'managed', server: 'ready-server' });
    app.unmount();
  });
});
