import { defineProductSchema } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import { RUN_STATUSES, STOP_REASONS } from '@momonga/protocol';
import { DatasetError, describeFirstError, jsonOf } from './dataset.ts';

export const INJECT_FORMAT = 'momonga-inject/1';

export const INJECTION_FAULTS = [
  'kill_at_step',
  'kill_after_effect',
  'network_down',
  'upstream_stall',
  'disk_full',
  'rate_limit',
  'duplicate_start',
  'concurrent_workers',
  'budget',
  'external_state_changed',
] as const;

export type InjectionFault = (typeof INJECTION_FAULTS)[number];

export const INJECTION_REQUIREMENTS = ['any', 'linux-container'] as const;

export const EPISODE_OUTCOMES = ['recovered', 'unknown_effect', 'failed', 'stopped'] as const;

export const RECONCILE_OUTCOMES = ['already_applied', 'not_applied', 'unknown'] as const;

export const POINT_EVENT_TYPES = ['model.requested', 'tool.started'] as const;

export type InjectionStep = { call: { name: string; input: Record<string, unknown> } } | { text: string };

export type InjectionExpect = {
  status: (typeof RUN_STATUSES)[number];
  stopReason?: (typeof STOP_REASONS)[number];
  episodeOutcomes?: (typeof EPISODE_OUTCOMES)[number][];
  minEpisodes?: number;
  reconciled?: (typeof RECONCILE_OUTCOMES)[number][];
  files?: { path: string; content: string }[];
  attemptFailed?: boolean;
  budgetStops?: number;
  runStarted?: number;
};

export type InjectionParams = {
  points?: (typeof POINT_EVENT_TYPES)[number][];
  idleTimeoutMs?: number;
  maxTotalTokens?: number;
  retryAfterWindow?: 'inside' | 'beyond';
  change?: 'applied' | 'removed';
  workerCount?: number;
};

export type InjectionScenario = {
  id: string;
  fault: InjectionFault;
  requires: (typeof INJECTION_REQUIREMENTS)[number];
  trials: number;
  task: { prompt: string; steps: InjectionStep[] };
  effect?: string;
  params?: InjectionParams;
  expect: InjectionExpect;
  pointExpect?: Partial<Record<(typeof POINT_EVENT_TYPES)[number], Partial<InjectionExpect>>>;
};

export type InjectionScenarios = { format: typeof INJECT_FORMAT; name: string; scenarios: InjectionScenario[] };

const text = { type: 'string', minLength: 1 } as const;
const count = { type: 'integer', minimum: 1 } as const;

const EXPECT_PROPERTIES = {
  status: { enum: [...RUN_STATUSES] },
  stopReason: { enum: [...STOP_REASONS] },
  episodeOutcomes: { type: 'array', minItems: 1, items: { enum: [...EPISODE_OUTCOMES] } },
  minEpisodes: { type: 'integer', minimum: 0 },
  reconciled: { type: 'array', items: { enum: [...RECONCILE_OUTCOMES] } },
  files: {
    type: 'array',
    minItems: 1,
    items: { type: 'object', properties: { path: text, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
  },
  attemptFailed: { type: 'boolean' },
  budgetStops: { type: 'integer', minimum: 0 },
  runStarted: count,
} as const;

export const INJECT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    format: { const: INJECT_FORMAT },
    name: text,
    scenarios: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
          fault: { enum: [...INJECTION_FAULTS] },
          requires: { enum: [...INJECTION_REQUIREMENTS] },
          trials: count,
          task: {
            type: 'object',
            properties: {
              prompt: text,
              steps: {
                type: 'array',
                minItems: 1,
                items: {
                  oneOf: [
                    {
                      type: 'object',
                      properties: {
                        call: { type: 'object', properties: { name: text, input: { type: 'object' } }, required: ['name', 'input'], additionalProperties: false },
                      },
                      required: ['call'],
                      additionalProperties: false,
                    },
                    { type: 'object', properties: { text }, required: ['text'], additionalProperties: false },
                  ],
                },
              },
            },
            required: ['prompt', 'steps'],
            additionalProperties: false,
          },
          effect: text,
          params: {
            type: 'object',
            properties: {
              points: { type: 'array', minItems: 1, items: { enum: [...POINT_EVENT_TYPES] } },
              idleTimeoutMs: count,
              maxTotalTokens: count,
              retryAfterWindow: { enum: ['inside', 'beyond'] },
              change: { enum: ['applied', 'removed'] },
              workerCount: count,
            },
            additionalProperties: false,
          },
          expect: { type: 'object', properties: EXPECT_PROPERTIES, required: ['status'], additionalProperties: false },
          pointExpect: {
            type: 'object',
            properties: Object.fromEntries(POINT_EVENT_TYPES.map((type) => [type, { type: 'object', properties: EXPECT_PROPERTIES, additionalProperties: false }])),
            additionalProperties: false,
          },
        },
        required: ['id', 'fault', 'requires', 'trials', 'task', 'expect'],
        additionalProperties: false,
      },
    },
  },
  required: ['format', 'name', 'scenarios'],
  additionalProperties: false,
} as const;

const validateShape: ProductValidator<InjectionScenarios> = defineProductSchema('eval/inject', INJECT_SCHEMA);

const REQUIRED_PARAMS: Readonly<Record<InjectionFault, readonly (keyof InjectionParams)[]>> = {
  kill_at_step: ['points'],
  kill_after_effect: [],
  network_down: [],
  upstream_stall: ['idleTimeoutMs'],
  disk_full: [],
  rate_limit: ['retryAfterWindow'],
  duplicate_start: [],
  concurrent_workers: ['workerCount'],
  budget: ['maxTotalTokens'],
  external_state_changed: ['change'],
};

const assertConsistent = (file: InjectionScenarios, source: string): void => {
  const seen = new Set<string>();
  for (const scenario of file.scenarios) {
    if (seen.has(scenario.id)) throw new DatasetError(`${source}: duplicate scenario id ${scenario.id}`);
    seen.add(scenario.id);
    for (const key of REQUIRED_PARAMS[scenario.fault]) {
      if (scenario.params?.[key] === undefined) throw new DatasetError(`${source}: scenario ${scenario.id} has the fault ${scenario.fault}, which needs the parameter ${key}`);
    }
    const last = scenario.task.steps.at(-1);
    if (last === undefined || !('text' in last)) throw new DatasetError(`${source}: scenario ${scenario.id} must end its steps with a text reply`);
  }
};

export const parseInjectionScenarios = (fileText: string, source: string): InjectionScenarios => {
  const value = jsonOf(fileText, source);
  const format = typeof value === 'object' && value !== null ? (value as { format?: unknown }).format : undefined;
  if (format !== INJECT_FORMAT) throw new DatasetError(`${source}: the file declares format ${JSON.stringify(format)}, which is not supported; this build reads ${INJECT_FORMAT}`);
  const verdict = validateShape(value);
  if (!verdict.valid) throw new DatasetError(`${source}: invalid injection scenarios at ${describeFirstError(verdict.errors)}`);
  assertConsistent(verdict.value, source);
  return verdict.value;
};
