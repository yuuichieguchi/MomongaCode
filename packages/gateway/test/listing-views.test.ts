import { describe, expect, it, vi } from 'vitest';
import { resolveModels, viewsOf } from '@momonga/config';
import { displayOf, resolveStoredModelRef, resolveTypedModelRef, storedModelRef, typedModelText } from '@momonga/protocol';
import type { ModelView, ModelViews } from '@momonga/protocol';
import { PROPERTY_TIMEOUT_MS, createFakeClock, createFakeTimers, createScriptedAdapter, modelSettings } from '@momonga/testkit';
import type { ModelSpec } from '@momonga/testkit';
import { seeded } from '../../context/test/helpers.ts';
import { gatewayConfigOf } from '../src/process.ts';
import { createReasoningOriginCodec } from '../src/core/reasoning-origin.ts';
import { createRedactor } from '../src/core/redaction.ts';
import { createRouter } from '../src/core/router.ts';
import { listModel } from '../src/server/capability-listing.ts';
import { HMAC_KEY, START_MS, counterForTest } from './gateway-helpers.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const SEEDS = 200;
const ADAPTERS = ['ollama', 'chat-completions', 'open-responses'] as const;
const OWN_NAMES = ['x', 'x:latest', 'a/b', 'qwen3.8:27b'] as const;

const settingsOf = (seed: number) => {
  const random = seeded(seed);
  const models: ModelSpec[] = [];
  const connections = random.int(1, 4);
  for (let connection = 0; connection < connections; connection += 1) {
    const adapter = ADAPTERS[random.int(0, ADAPTERS.length - 1)] as string;
    const named = random.int(0, 1) === 1;
    const provider = `server-${connection}`;
    const ids = new Set(Array.from({ length: random.int(1, 3) }, () => OWN_NAMES[random.int(0, OWN_NAMES.length - 1)] as string));
    if (adapter === 'ollama' && ids.has('x') && ids.has('x:latest')) ids.delete('x');
    for (const id of ids) models.push({ provider, adapter, id, baseUrl: `http://127.0.0.1:${9000 + connection}${adapter === 'ollama' ? '' : '/v1'}`, unnamed: !named });
  }
  const settings = modelSettings({ models: models.map(({ unnamed: _unnamed, ...spec }) => spec) });
  for (const connection of settings.models.connections) {
    if (models.some((model) => model.provider === connection.provider && model['unnamed'] === true)) delete (connection as Record<string, unknown>)['provider'];
  }
  return settings;
};

const viewOf = (entry: { id: string; provider: string; ownName: string; defaultTag?: string }): ModelView => ({
  canon: entry.id,
  provider: entry.provider,
  ownName: entry.ownName,
  ...(entry.defaultTag === undefined ? {} : { defaultTag: entry.defaultTag }),
});

const listedViewsOf = async (resolved: ReturnType<typeof resolveModels>): Promise<ModelViews> => {
  const uncounted = gatewayConfigOf(resolved);
  const { targets, ...rest } = uncounted.models;
  const config = { ...uncounted, models: { ...rest, targets: Object.fromEntries(Object.entries(targets).map(([canon, target]) => [canon, { ...target, counter: counterForTest(canon) }])) } };
  const clock = createFakeClock(START_MS);
  const router = createRouter({
    config,
    adapters: Object.fromEntries(Object.keys(targets).map((canon) => [canon, createScriptedAdapter({ calls: [] })])),
    clock,
    timers: createFakeTimers(clock),
    redactor: createRedactor({ credentials: [] }),
    reasoningOrigin: createReasoningOriginCodec(HMAC_KEY),
  });
  const signal = new AbortController().signal;
  return (await Promise.all(router.models().map((model) => listModel(router, model, signal)))).map(viewOf);
};

describe('I-N19: resolution over the listing equals resolution over the settings', () => {
  it(
    'gives the same views, display names and resolutions for generated settings',
    async () => {
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const settings = settingsOf(seed);
        const resolved = resolveModels(settings.models as never, { source: 'settings.json', home: undefined, warnings: [], servers: {} });
        const views = viewsOf(resolved);
        const listed = await listedViewsOf(resolved);
        expect(listed, `seed ${seed}`).toEqual(views);
        for (const view of views) {
          const display = displayOf(view, views);
          expect(displayOf(view, listed), `seed ${seed} ${view.canon}`).toBe(display);
          expect(resolveTypedModelRef(typedModelText(display), listed)).toEqual(resolveTypedModelRef(typedModelText(display), views));
          expect(resolveStoredModelRef(storedModelRef(view.canon), listed)).toEqual(resolveStoredModelRef(storedModelRef(view.canon), views));
        }
      }
    },
  );
});
