import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.ts';
import { agentReadiness, readinessText } from '../src/index.ts';
import type { NeedsProbe, Readiness } from '../src/index.ts';

type Surface = 'tui' | 'shell';
type NotReady = Exclude<Readiness, { state: 'ready' }>;

const exported = <T>(name: string): T => {
  const value = (protocol as Record<string, unknown>)[name];
  if (typeof value !== 'function') throw new Error(`@momonga/protocol does not export ${name}`);
  return value as T;
};

const readinessRemedy = (state: 'no_tools' | 'unavailable', surface: Surface): string => exported<(state: string, surface: Surface) => string>('readinessRemedy')(state, surface);
const readinessShownText = (readiness: NotReady, surface: Surface): string => exported<(readiness: NotReady, surface: Surface) => string>('readinessShownText')(readiness, surface);

const NO_TOOLS_MESSAGE = 'This model cannot call tools. MomongaCode will answer without reading or changing files.';
const NO_TOOLS_SHELL = 'For coding work, choose another model with momonga --model <model>; momonga models detect lists the local servers that are running.';

const NEEDS_PROBE: NeedsProbe = { state: 'needs_probe', message: 'the model has not been probed for tool calling', evidence: 'no probe record', remedy: 'run `momonga gateway probe devstral-small-2`' };

describe('a readiness state carries its message; the remedy belongs to the place that shows it', () => {
  it('a model that cannot call tools: the state and the message, no remedy', () => {
    const readiness = agentReadiness({ toolCalling: 'none' });
    expect(readiness).toEqual({ state: 'no_tools', message: NO_TOOLS_MESSAGE });
    expect(readiness).not.toHaveProperty('remedy');
  });

  it('an unavailable model: the state and the message it was given, no remedy', () => {
    const readiness = agentReadiness({ unavailable: 'x' });
    expect(readiness).toEqual({ state: 'unavailable', message: 'x' });
    expect(readiness).not.toHaveProperty('remedy');
  });

  it('no tools, in the interactive screen', () => {
    expect(readinessRemedy('no_tools', 'tui')).toBe('For coding work, choose another model with /model; /models add lists the local servers that are running.');
  });

  it('no tools, in the shell', () => {
    expect(readinessRemedy('no_tools', 'shell')).toBe(NO_TOOLS_SHELL);
  });

  it('unavailable, in the interactive screen', () => {
    expect(readinessRemedy('unavailable', 'tui')).toBe('Choose a model with /model, or set one up with /models add.');
  });

  it('unavailable, in the shell', () => {
    expect(readinessRemedy('unavailable', 'shell')).toBe('Choose a model with momonga --model <model>, or set one up with momonga models add.');
  });

  it('the shown text of a model without tools is the message, then the remedy of the surface on its own line', () => {
    const readiness = agentReadiness({ toolCalling: 'none' });
    if (readiness.state === 'ready') throw new Error('a model without tools is not ready');
    expect(readinessText(readiness)).toBe(NO_TOOLS_MESSAGE);
    expect(readinessShownText(readiness, 'shell')).toBe(`${NO_TOOLS_MESSAGE}\n${NO_TOOLS_SHELL}`);
  });

  it('the shown text of a model that needs a probe is the message and the remedy of the probe, on every surface', () => {
    const readiness = agentReadiness({ toolCalling: NEEDS_PROBE });
    if (readiness.state === 'ready') throw new Error('an unprobed model is not ready');
    const expected = `${NEEDS_PROBE.message}\n${NEEDS_PROBE.remedy}`;
    expect(readinessText(readiness)).toBe(expected);
    expect(readinessShownText(readiness, 'tui')).toBe(expected);
    expect(readinessShownText(readiness, 'shell')).toBe(expected);
  });
});
