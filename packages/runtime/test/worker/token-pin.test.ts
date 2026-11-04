import { describe, expect, it } from 'vitest';
import type { ResolvedContextSettings, ResolvedToolsSettings } from '@momonga/config';
import type { RunEvent } from '@momonga/protocol';
import type { Run, Session } from '@momonga/store';
import { readPins } from '../../src/worker/pins.ts';
import type { RunPins } from '../../src/worker/pins.ts';
import { tokenPinFor } from '../../src/worker/token-pin.ts';
import type { TokenPin } from '../../src/worker/token-pin.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

const OFF_CONTEXT: ResolvedContextSettings = { adaptiveBudget: false, autoCompact: true, cachePrefix: false, outputFormatters: [], loopGuidance: false, observedCapacity: false };
const OFF_TOOLS: ResolvedToolsSettings = { deferral: false, conciseDescriptions: false };

const settingsOf = (context: ResolvedContextSettings, tools: ResolvedToolsSettings) => ({
  context: async () => context,
  tools: async () => tools,
});

const started = (pins: Record<string, unknown>) => ({ type: 'run.started' as const, seq: 1, attempt: 1, now: 0, pins });

const storeWith = (events: readonly Pick<RunEvent, 'type'>[]) => ({
  readRunEventsOfTypes: () => events as unknown as RunEvent[],
});

const SESSION = { id: 'sess-1', cwd: '/work/a' } as unknown as Session;
const rootRun = { id: 'run-root', parentRunId: null } as unknown as Run;
const childRun = { id: 'run-child', parentRunId: 'run-root' } as unknown as Run;

const BASE_PINS = { modelAlias: 'fm', systemPromptDigest: 'd'.repeat(64), toolSetDigest: 't'.repeat(64), capabilities: capabilitiesFor(100_000) };

describe('the token pin of a root run', () => {
  it('pins nothing when every token setting is off', async () => {
    expect(await tokenPinFor({ store: storeWith([]), settings: settingsOf(OFF_CONTEXT, OFF_TOOLS), session: SESSION, run: rootRun })).toEqual({});
  });

  it('pins each setting that is on', async () => {
    const context: ResolvedContextSettings = { ...OFF_CONTEXT, cachePrefix: true, outputFormatters: ['log', 'grep'], loopGuidance: true };
    const pin = await tokenPinFor({ store: storeWith([]), settings: settingsOf(context, { deferral: false, conciseDescriptions: true }), session: SESSION, run: rootRun });
    expect(pin).toEqual({ cachePrefix: true, conciseDescriptions: true, outputFormatters: ['log', 'grep'], loopGuidance: true });
  });

  it('ignores the settings that are not part of the token pin', async () => {
    const context: ResolvedContextSettings = { ...OFF_CONTEXT, adaptiveBudget: true, autoCompact: false, observedCapacity: true };
    expect(await tokenPinFor({ store: storeWith([]), settings: settingsOf(context, OFF_TOOLS), session: SESSION, run: rootRun })).toEqual({});
  });
});

describe('the token pin of a child run', () => {
  it('inherits the pin of its parent, whatever the settings say now', async () => {
    const parentPin: TokenPin = { cachePrefix: true, deferred: ['WebFetch'], outputFormatters: ['json'] };
    const store = storeWith([started({ ...BASE_PINS, token: parentPin })]);
    const context: ResolvedContextSettings = { ...OFF_CONTEXT, loopGuidance: true };
    expect(await tokenPinFor({ store, settings: settingsOf(context, { deferral: true, conciseDescriptions: true }), session: SESSION, run: childRun })).toEqual(parentPin);
  });

  it('inherits an all-off pin from a parent that recorded none', async () => {
    const store = storeWith([started(BASE_PINS)]);
    const context: ResolvedContextSettings = { ...OFF_CONTEXT, cachePrefix: true };
    expect(await tokenPinFor({ store, settings: settingsOf(context, OFF_TOOLS), session: SESSION, run: childRun })).toEqual({});
  });
});

describe('reading pins.token', () => {
  it('reads a pin with every field', () => {
    const token: TokenPin = { cachePrefix: true, deferred: ['WebFetch', 'Glob'], conciseDescriptions: true, outputFormatters: ['log', 'identicalOutput'], loopGuidance: true };
    const pins: RunPins = readPins({ ...BASE_PINS, token });
    expect(pins.token).toEqual(token);
  });

  it('reads an empty pin and a run recorded before the pin existed', () => {
    expect(readPins({ ...BASE_PINS, token: {} }).token).toEqual({});
    expect(readPins(BASE_PINS).token).toBeUndefined();
  });

  it.each([
    ['an unknown key', { cachePrefix: true, observedCapacity: true }],
    ['a cachePrefix that is not a boolean', { cachePrefix: 'yes' }],
    ['a deferred list with a non-string name', { deferred: [3] }],
    ['an unknown formatter', { outputFormatters: ['markdown'] }],
    ['a loopGuidance that is not a boolean', { loopGuidance: 1 }],
    ['a conciseDescriptions that is not a boolean', { conciseDescriptions: null }],
    ['a token pin that is not a record', 'on'],
  ])('refuses a pin with %s', (_label, token) => {
    expect(() => readPins({ ...BASE_PINS, token })).toThrow(/malformed/);
  });
});

describe('the token pin recorded at run start', () => {
  it('records an all-off pin on run.started with the default settings', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Done.'));
    const run = env.enqueue('say done');
    await env.runOnce(env.worker());
    const [first] = env.ofType(run.id, 'run.started');
    expect(first?.pins['token']).toEqual({});
  });

  it('records the settings that are on when the root run starts', async () => {
    const env = await makeEnv();
    env.settings.contextValue = { ...env.settings.contextValue, cachePrefix: true, outputFormatters: ['log'] };
    env.gateway.script.push(textStep('Done.'));
    const run = env.enqueue('say done');
    await env.runOnce(env.worker());
    const [first] = env.ofType(run.id, 'run.started');
    expect(first?.pins['token']).toEqual({ cachePrefix: true, outputFormatters: ['log'] });
  });
});
