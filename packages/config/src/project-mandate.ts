import path from 'node:path';
import { defineProductSchema, isRecord } from '@momonga/foundation';
import { MAX_COST_USD } from '@momonga/protocol';
import { ConfigError } from './config-error.ts';
import { readJsonFile } from './json-file.ts';
import { RuleParseError, checkRuleText } from './rule.ts';

export const PROJECT_MANDATE_FILE = path.join('.momonga', 'mandate.json');

export const PROJECT_MANDATE_USER_ONLY_KEYS = ['allow', 'onQuiescent'] as const;

export type ProjectMandate = {
  ask?: string[];
  deny?: string[];
  until?: string[];
  require?: string[];
  steps?: number;
  tokens?: number;
  costUsd?: number;
  timeMs?: number;
  retries?: number;
};

const RULES = { type: 'array', items: { type: 'string', minLength: 1 } } as const;

const PROJECT_MANDATE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    ask: RULES,
    deny: RULES,
    until: RULES,
    require: RULES,
    steps: { type: 'integer', minimum: 1, maximum: 1000 },
    tokens: { type: 'integer', minimum: 1, maximum: 100_000_000 },
    costUsd: { type: 'number', minimum: 0, maximum: MAX_COST_USD },
    timeMs: { type: 'integer', minimum: 1000, maximum: 604_800_000 },
    retries: { type: 'integer', minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
} as const;

const validateProjectMandate = defineProductSchema<ProjectMandate>('config/project-mandate', PROJECT_MANDATE_SCHEMA);

export const parseProjectMandate = (value: unknown, source: string): ProjectMandate => {
  if (isRecord(value)) {
    const widening = PROJECT_MANDATE_USER_ONLY_KEYS.find((key) => Object.hasOwn(value, key));
    if (widening !== undefined) {
      throw new ConfigError(`${source}: ${widening} can only be declared in the user settings (mandates); a project file may add ask and deny rules, completion conditions and smaller budgets, and never widens a mandate`);
    }
  }
  const verdict = validateProjectMandate(value);
  if (!verdict.valid) {
    const first = verdict.errors[0];
    throw new ConfigError(`${source}: ${first?.instancePath === undefined || first.instancePath === '' ? 'the file' : first.instancePath} ${first?.message ?? 'does not match the schema of a project mandate'}`);
  }
  for (const effect of ['ask', 'deny'] as const) {
    for (const rule of verdict.value[effect] ?? []) {
      try {
        checkRuleText(rule);
      } catch (error) {
        if (error instanceof RuleParseError) throw new ConfigError(`${source}: the ${effect} rule ${JSON.stringify(rule)} is not a permission rule: ${error.message}`);
        throw error;
      }
    }
  }
  return verdict.value;
};

export type ProjectMandateInput = { projectDir: string; trusted: boolean };

export const loadProjectMandate = async ({ projectDir, trusted }: ProjectMandateInput): Promise<ProjectMandate | undefined> => {
  if (!trusted) return undefined;
  const file = path.join(projectDir, PROJECT_MANDATE_FILE);
  const read = await readJsonFile(file, { confineTo: projectDir });
  return read.found ? parseProjectMandate(read.value, file) : undefined;
};
