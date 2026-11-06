import { describe, expect, it } from 'vitest';
import type { NeedsProbe } from '@momonga/protocol';
import { FRAME_BOUND_MS, KEYS, untilFrame, untilOutput } from './ink-helpers.ts';
import { start, type } from './tui-harness.tsx';

const BOUND = { timeout: 3 * FRAME_BOUND_MS };

const NO_TOOLS_NOTICE = 'This model cannot call tools';

const NEEDS_PROBE: NeedsProbe = {
  state: 'needs_probe',
  message: 'target local has not been probed for tool calling',
  evidence: 'no probe record for local',
  remedy: 'run the tool-calling probe for local',
};

describe('the TUI shows the readiness verdict before any request', () => {
  it('shows the no-tools notice at session start for a target that reports no tool calling, naming /model', BOUND, async () => {
    const { backend, app } = await start({ toolCalling: { default: 'none' } });
    const output = await untilOutput(app, NO_TOOLS_NOTICE);
    const notice = output.split('\n').find((line) => line.includes(NO_TOOLS_NOTICE)) ?? '';
    expect(output).toContain('/model');
    expect(notice).not.toMatch(/probe/i);
    expect(backend.started).toEqual([]);
    app.unmount();
  });

  it('shows no readiness notice for a target that calls tools', BOUND, async () => {
    const { app } = await start();
    const frame = await untilFrame(app, 'mode: default');
    expect(frame).not.toContain(NO_TOOLS_NOTICE);
    app.unmount();
  });

  it('shows the no-tools notice when /model switches to a target that reports no tool calling', BOUND, async () => {
    const { backend, app } = await start({ aliases: ['default', 'chat-only'], toolCalling: { 'chat-only': 'none' } });
    await untilFrame(app, 'mode: default');
    await type(app, '/model chat-only', '> /model chat-only');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, 'model: chat-only');
    await untilOutput(app, NO_TOOLS_NOTICE);
    expect(backend.calls).toContain('model:chat-only');
    app.unmount();
  });

  it('shows the probe remedy at session start for an unprobed target, before any run', BOUND, async () => {
    const { backend, app } = await start({ toolCalling: { default: NEEDS_PROBE } });
    await untilOutput(app, NEEDS_PROBE.remedy);
    expect(backend.started).toEqual([]);
    app.unmount();
  });
});
