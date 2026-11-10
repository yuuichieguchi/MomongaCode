import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import * as protocol from '@momonga/protocol';
import { EVENT_TYPES, RUN_API_SCHEMAS, STOP_REASONS } from '@momonga/protocol';

const schemas = RUN_API_SCHEMAS as unknown as Record<string, Record<string, unknown>>;

const ajv = (() => {
  const built = new Ajv2020.default({ strict: true, allErrors: true });
  addFormats.default(built);
  for (const schema of Object.values(schemas)) if (typeof schema['$id'] === 'string') built.addSchema(schema);
  return built;
})();

const validator = (name: string): ValidateFunction => {
  const schema = schemas[name];
  if (schema === undefined) throw new Error(`RUN_API_SCHEMAS has no ${name}`);
  return typeof schema['$id'] === 'string' ? (ajv.getSchema(schema['$id']) as ValidateFunction) : ajv.compile(schema);
};

const accepts = (name: string, value: unknown): boolean => validator(name)(value) === true;

const exported = (name: string): unknown => {
  const found = (protocol as Record<string, unknown>)[name];
  if (found === undefined) throw new Error(`@momonga/protocol does not export ${name}`);
  return found;
};

const RUN_VIEW = {
  id: 'run-1',
  sessionId: 'sess-1',
  ordinal: 1,
  status: 'STOPPED',
  stopReason: 'conditions_unmet',
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  step: 2,
  limits: { maxSteps: 50, maxTotalTokens: 1_000_000, approvalTtlMs: 1_800_000, loopThreshold: 3 },
  createdAt: 1_800_000_000_000,
  deadlineAt: 1_800_021_600_000,
  cancelRequested: false,
  lastSeq: 9,
  previousRunId: null,
  history: 'fresh',
  parentRunId: null,
  parentCallId: null,
  origin: 'trusted',
};

describe('the conditions_unmet stop reason', () => {
  it('is a stop reason, so an unmet declared condition is a distinct STOPPED outcome', () => {
    expect(STOP_REASONS).toContain('conditions_unmet');
  });

  it('is accepted on a RunView', () => {
    expect(accepts('RunView', RUN_VIEW)).toBe(true);
  });
});

describe('the verification events', () => {
  it('are journal event types', () => {
    expect(EVENT_TYPES).toEqual(expect.arrayContaining(['verification.started', 'verification.completed']));
  });

  it('name the outcomes a check can have', () => {
    expect(exported('VERIFICATION_OUTCOMES')).toEqual(['passed', 'failed', 'timed_out', 'cancelled', 'spawn_error']);
  });

  it('name the when values of a condition', () => {
    expect(exported('CONDITION_WHENS')).toEqual(['always', 'after_mutation']);
  });

  it('build the feedback message to the model from a fixed prefix', () => {
    expect(typeof exported('VERIFICATION_FEEDBACK_PREFIX')).toBe('string');
    expect(exported('VERIFICATION_FEEDBACK_PREFIX')).not.toBe('');
  });
});

describe('CreateRunRequest.mandate.completion', () => {
  const request = (completion: unknown) => ({ input: 'make the tests pass', mandate: { completion } });

  it('has no top-level completion field, because the completion declaration lives in the mandate', () => {
    expect(accepts('CreateRunRequest', { input: 'make the tests pass', completion: { conditions: [{ command: 'npm test' }] } })).toBe(false);
  });

  it('accepts conditions as data with an optional id, timeout and when, plus unchecked requirements and inherit', () => {
    expect(
      accepts(
        'CreateRunRequest',
        request({
          conditions: [{ command: 'npm test' }, { id: 'lint', command: 'npm run lint', timeoutMs: 60_000, when: 'after_mutation' }],
          requirements: ['the changelog mentions the fix'],
          inherit: false,
        }),
      ),
    ).toBe(true);
  });

  it('rejects a condition that is not a command, so no model-judged condition can be declared', () => {
    expect(accepts('CreateRunRequest', request({ conditions: [{ kind: 'judge', prompt: 'is it done?' }] }))).toBe(false);
    expect(accepts('CreateRunRequest', request({ conditions: [{ command: 'npm test', judge: 'model' }] }))).toBe(false);
  });

  it('rejects an empty command, an unknown when and a non-positive timeout', () => {
    expect(accepts('CreateRunRequest', request({ conditions: [{ command: '' }] }))).toBe(false);
    expect(accepts('CreateRunRequest', request({ conditions: [{ command: 'npm test', when: 'sometimes' }] }))).toBe(false);
    expect(accepts('CreateRunRequest', request({ conditions: [{ command: 'npm test', timeoutMs: 0 }] }))).toBe(false);
  });
});

describe('RunView.report', () => {
  const report = {
    runId: 'run-1',
    status: 'STOPPED',
    stopReason: 'conditions_unmet',
    durationMs: 10,
    declaration: { conditions: [{ id: 'abc', command: 'npm test', when: 'always', source: 'request' }], requirements: [] },
    changes: { files: [], mutatingCalls: 0 },
    conditions: [{ id: 'abc', command: 'npm test', state: 'failed', rounds: 2 }],
    notRun: [],
    residualRisk: [],
    modelChecks: [],
  };

  it('carries the run report computed on read', () => {
    expect(accepts('RunView', { ...RUN_VIEW, report })).toBe(true);
  });

  it('rejects a condition state outside the report vocabulary', () => {
    expect(accepts('RunView', { ...RUN_VIEW, report: { ...report, conditions: [{ id: 'abc', command: 'npm test', state: 'model_says_done', rounds: 1 }] } })).toBe(false);
  });
});
