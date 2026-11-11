import { describe, expect, it, vi } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { seeded } from '../../context/test/helpers.ts';
import { documentOf, editModels, homeWith, op, textOf } from './models-edit.ts';
import type { Home, Operation } from './models-edit.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

type Random = ReturnType<typeof seeded>;
type View = { canon: string; provider: string; ownName: string };
type Step = { operation: Operation; before: string; viewsBefore: View[]; accepted: boolean; home: Home };

const SEEDS = 40;
const CAPABILITIES = { contextWindow: 8192, maxOutputTokens: 1024 };
const IDS = ['x', 'y', 'a/b', 'x:latest', 'qwen3.8:27b'] as const;
const JOBS = ['compaction', 'reflection', 'analysis'] as const;
const KINDS = ['local', 'metered', 'plan'] as const;
const NO_MODEL = 'nowhere/nope';

const pick = <T>(random: Random, items: readonly T[]): T => items[random.int(0, items.length - 1)] as T;

const some = <T>(random: Random, items: readonly T[], most: number): T[] => Array.from({ length: random.int(0, most) }, () => pick(random, items));

const settingsOf = (random: Random): Record<string, unknown> => {
  const connections = Array.from({ length: random.int(1, 3) }, (_unused, index) => {
    const ids = [...new Set(Array.from({ length: random.int(1, 3) }, () => pick(random, IDS)))];
    return {
      adapter: 'chat-completions',
      ...(random.int(0, 1) === 0 ? {} : { provider: `named-${index}` }),
      baseUrl: `https://host-${index}.example.com/v1`,
      models: ids.map((id) => ({ id, capabilities: CAPABILITIES })),
    };
  });
  const canons = connections.flatMap((connection, index) => connection.models.map((entry) => `${'provider' in connection ? `named-${index}` : `srv-host-${index}.example.com-443`}/${entry.id}`));
  const roles = Object.fromEntries(JOBS.filter(() => random.int(0, 2) === 0).map((job) => [job, pick(random, canons)]));
  return {
    ...(random.int(0, 1) === 0 ? {} : { autoMode: { classifier: pick(random, canons) } }),
    models: {
      connections,
      ...(random.int(0, 1) === 0 ? {} : { start: pick(random, canons) }),
      ...(random.int(0, 1) === 0 ? {} : { fallback: some(random, canons, 3) }),
      ...(Object.keys(roles).length === 0 ? {} : { roles }),
      ...(random.int(0, 1) === 0 ? {} : { billingChanges: [{ from: 'local', to: 'metered', model: pick(random, canons) }, { from: 'metered', to: 'plan' }] }),
    },
  };
};

const viewsOf = async (home: Home): Promise<View[]> => [...((await loadUserSettings({ home: home.tree.home, signal: new AbortController().signal })).settings.models as unknown as { views: readonly View[] }).views];

const operationOf = (random: Random, views: readonly View[]): Operation => {
  const canons = [...views.map((view) => view.canon), NO_MODEL];
  const providers = [...new Set(views.map((view) => view.provider)), 'nowhere'];
  const model = pick(random, canons);
  switch (random.int(0, 10)) {
    case 0:
      return op('setStart', { model: random.int(0, 3) === 0 ? null : model });
    case 1:
      return op('setFallback', { models: some(random, canons, 3) });
    case 2:
      return op('setRole', { job: pick(random, JOBS), model: random.int(0, 3) === 0 ? null : model });
    case 3:
      return op('setClassifier', { model: random.int(0, 3) === 0 ? null : model });
    case 4:
      return op('allowBillingChange', { from: pick(random, KINDS), to: pick(random, KINDS), ...(random.int(0, 1) === 0 ? {} : { model }) });
    case 5:
      return op('removeModel', { model });
    case 6:
      return op('removeConnection', { provider: pick(random, providers) });
    case 7:
      return op('setModelField', { model, path: ['capabilities', 'contextWindow'], value: pick(random, [4096, 65536, -1, 'wide']) });
    case 8:
      return op('setProvider', { provider: pick(random, providers), name: pick(random, ['renamed', 'Bad Name', 'ollama', null, ...providers]) });
    case 9:
      return op('setTimeouts', { idleTimeoutMs: pick(random, [0, 60000, -5]) });
    default:
      return op('addModel', { choice: { connection: { adapter: 'chat-completions', baseUrl: `https://host-${random.int(0, 4)}.example.com/v1` }, model: { id: pick(random, [...IDS, 'new-model']), capabilities: CAPABILITIES } } });
  }
};

const walk = async (seed: number, onStep: (step: Step) => Promise<void>): Promise<void> => {
  const random = seeded(seed);
  const home = homeWith(settingsOf(random));
  for (let count = random.int(1, 6); count > 0; count -= 1) {
    const viewsBefore = await viewsOf(home);
    const before = textOf(home);
    const operation = operationOf(random, viewsBefore);
    const accepted = await editModels(home, [operation]).then(
      () => true,
      () => false,
    );
    await onStep({ operation, before, viewsBefore, accepted, home });
  }
};

const referencesOf = (document: Record<string, unknown>): string[] => {
  const models = (document['models'] ?? {}) as { start?: string; fallback?: string[]; roles?: Record<string, string>; billingChanges?: { model?: string }[] };
  const classifier = ((document['autoMode'] ?? {}) as { classifier?: string }).classifier;
  return [models.start, ...(models.fallback ?? []), ...Object.values(models.roles ?? {}), classifier, ...(models.billingChanges ?? []).map((change) => change.model)].filter((reference): reference is string => reference !== undefined);
};

const removedBy = (step: Step): string[] => {
  if (step.operation.kind === 'removeModel') return [step.operation['model'] as string];
  if (step.operation.kind === 'removeConnection') return step.viewsBefore.filter((view) => view.provider === step.operation['provider']).map((view) => view.canon);
  return [];
};

describe('the writer over generated settings and operations (I-N14)', () => {
  it(
    'after every accepted operation the file loads, and at least one operation of every walk is judged',
    async () => {
      let accepted = 0;
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        await walk(seed, async (step) => {
          if (!step.accepted) return;
          accepted += 1;
          await expect(viewsOf(step.home), `seed ${seed} ${JSON.stringify(step.operation)}`).resolves.toBeInstanceOf(Array);
        });
      }
      expect(accepted).toBeGreaterThan(SEEDS);
    },
  );

  it(
    'after an accepted removal no reference of the file names a removed model',
    async () => {
      let removals = 0;
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        await walk(seed, async (step) => {
          const removed = removedBy(step);
          if (!step.accepted || removed.length === 0) return;
          removals += 1;
          const left = referencesOf(documentOf(step.home));
          expect(left.filter((reference) => removed.includes(reference)), `seed ${seed} ${JSON.stringify(step.operation)}`).toEqual([]);
          expect((await viewsOf(step.home)).map((view) => view.canon).filter((canon) => removed.includes(canon)), `seed ${seed}`).toEqual([]);
        });
      }
      expect(removals).toBeGreaterThan(0);
    },
  );

  it(
    'a refused operation leaves the bytes of the file unchanged',
    async () => {
      let refused = 0;
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        await walk(seed, async (step) => {
          if (step.accepted) return;
          refused += 1;
          expect(textOf(step.home), `seed ${seed} ${JSON.stringify(step.operation)}`).toBe(step.before);
        });
      }
      expect(refused).toBeGreaterThan(0);
    },
  );
});
