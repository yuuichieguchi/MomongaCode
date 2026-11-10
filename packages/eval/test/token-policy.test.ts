import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import {
  CONTEXT_DATASET_FORMAT,
  CONTEXT_REPORT_FORMAT,
  EvalError,
  caseSettingsFor,
  compareContextReports,
  encodeContextReport,
  formatContextComparison,
  parseContextDataset,
  parseContextReport,
  parsePolicyOverlay,
  resolvePolicyOverlay,
} from '@momonga/eval';
import type { PolicyOverlay, Transcript } from '@momonga/eval';
import { contextCase, recorded } from './context-fixtures.ts';
import { buildReportAs } from './answered-fixtures.ts';
import { RESOLVED_OFF_POLICY, RESOLVED_ON_POLICY } from './fixtures.ts';

const SCENARIOS = ['a', 'b'] as const;

const dataset = parseContextDataset(
  JSON.stringify({
    format: CONTEXT_DATASET_FORMAT,
    name: 'economy',
    cases: SCENARIOS.flatMap((scenario) => [contextCase(`${scenario}-on`, scenario, 'on'), contextCase(`${scenario}-off`, scenario, 'off')]),
  }),
  'economy.json',
);

const transcripts: Transcript[] = SCENARIOS.flatMap((scenario) => [recorded(`${scenario}-on`, 0, []), recorded(`${scenario}-off`, 0, [])]);

const MAIN_CODE = 'a'.repeat(64);
const HEAD_CODE = 'b'.repeat(64);

const reportWith = (policy: unknown = RESOLVED_ON_POLICY, codeDigest = MAIN_CODE) =>
  buildReportAs({ dataset, transcripts: transcripts.map((transcript) => ({ ...transcript, policy: policy as PolicyOverlay, codeDigest })), model: 'real', seed: 1 });

const EVERY_KEY: PolicyOverlay = {
  context: { cachePrefix: true, outputFormatters: ['log', 'json', 'grep', 'identicalOutput'], loopGuidance: true, observedCapacity: true },
  tools: { deferral: true, conciseDescriptions: true },
  memory: { repositoryFacts: true },
};

describe('parsePolicyOverlay', () => {
  it('accepts every token key and resolves the formatters sorted', () => {
    expect(resolvePolicyOverlay(parsePolicyOverlay(JSON.stringify(EVERY_KEY), 'policy.json'))).toEqual(RESOLVED_ON_POLICY);
  });

  it('accepts an empty overlay', () => {
    expect(parsePolicyOverlay('{}', 'policy.json')).toEqual({});
  });

  it.each([
    ['a memory key outside the token design', { memory: { forgetAfterDays: 3 } }],
    ['a section outside the token design', { models: { aliases: {} } }],
    ['an unknown tools key', { tools: { lazy: true } }],
    ['a value of the wrong type', { context: { cachePrefix: 'yes' } }],
    ['an unknown formatter', { context: { outputFormatters: ['markdown'] } }],
  ])('refuses %s and names the file', (_label, overlay) => {
    expect(() => parsePolicyOverlay(JSON.stringify(overlay), 'policy.json')).toThrow(EvalError);
    expect(() => parsePolicyOverlay(JSON.stringify(overlay), 'policy.json')).toThrow(/policy\.json/);
  });

  it('refuses text that is not JSON', () => {
    expect(() => parsePolicyOverlay('{', 'policy.json')).toThrow(EvalError);
  });
});

describe('caseSettingsFor with a policy', () => {
  const base = { sandbox: 'none', context: { adaptiveBudget: true }, memory: { forgetAfterDays: 30 } };

  it('merges the policy into the nested sections and keeps the rest', () => {
    const policy = { context: { cachePrefix: true }, tools: { deferral: true }, memory: { repositoryFacts: true } };
    expect(caseSettingsFor(base, { compaction: 'on', policy })).toEqual({
      sandbox: 'none',
      context: { adaptiveBudget: true, cachePrefix: true, autoCompact: true },
      tools: { deferral: true },
      memory: { forgetAfterDays: 30, repositoryFacts: true },
    });
  });

  it('leaves the settings as before with an empty policy', () => {
    expect(caseSettingsFor(base, { compaction: 'off', policy: {} })).toEqual({ ...base, context: { adaptiveBudget: true, autoCompact: false } });
  });

  it('lets the policy win over a value the operator set', () => {
    expect(caseSettingsFor({ context: { cachePrefix: false } }, { compaction: 'on', policy: { context: { cachePrefix: true } } })).toEqual({
      context: { cachePrefix: true, autoCompact: true },
    });
  });
});

const CACHE_PREFIX_OFF = { ...RESOLVED_ON_POLICY, context: { ...RESOLVED_ON_POLICY.context, cachePrefix: false } };

describe('the policy recorded in a context report', () => {
  it('records the resolved policy of its transcripts', () => {
    expect(reportWith(CACHE_PREFIX_OFF).policy).toEqual(CACHE_PREFIX_OFF);
  });

  it('round-trips through the stored report', () => {
    const report = reportWith(RESOLVED_OFF_POLICY);
    expect(parseContextReport(encodeContextReport(report), 'r.json')).toEqual(report);
  });

  it('refuses a stored report whose policy holds a key outside the core list', () => {
    const report = { ...reportWith(), policy: { ...RESOLVED_ON_POLICY, context: { ...RESOLVED_ON_POLICY.context, lazyPrefix: false } } };
    expect(() => parseContextReport(JSON.stringify(report), 'r.json')).toThrow(/not a context report/);
  });

  it('refuses a stored report without a policy', () => {
    const { policy: _policy, ...withoutPolicy } = reportWith();
    expect(() => parseContextReport(JSON.stringify(withoutPolicy), 'r.json')).toThrow(/not a context report/);
  });
});

describe('the code digest recorded in a context report', () => {
  it('records the digest of the code that produced the runs', () => {
    expect(reportWith(undefined, HEAD_CODE).codeDigest).toBe(HEAD_CODE);
  });

  it('round-trips through the stored report and refuses one without a digest or with a malformed one', () => {
    const report = reportWith();
    expect(parseContextReport(encodeContextReport(report), 'r.json').codeDigest).toBe(MAIN_CODE);
    const { codeDigest: _digest, ...withoutDigest } = report;
    expect(() => parseContextReport(JSON.stringify(withoutDigest), 'r.json')).toThrow(/not a context report/);
    expect(() => parseContextReport(JSON.stringify({ ...report, codeDigest: 'main' }), 'r.json')).toThrow(/not a context report/);
  });
});

describe('compare --gate token, the policies and the code digests', () => {
  it('refuses two reports with the same resolved policy on the same code', () => {
    expect(() => compareContextReports(reportWith(), reportWith(), { seed: 1, gate: 'token' })).toThrow(EvalError);
    expect(() => compareContextReports(reportWith(), reportWith(), { seed: 1, gate: 'token' })).toThrow(/identical policy and an identical code digest/);
  });

  it('accepts the same policy on different code, the main-versus-head gate', () => {
    expect(() => compareContextReports(reportWith(RESOLVED_ON_POLICY, MAIN_CODE), reportWith(RESOLVED_ON_POLICY, HEAD_CODE), { seed: 1, gate: 'token' })).not.toThrow();
  });

  it('accepts different policies on the same code, which were equal under the old defaults', () => {
    expect(() => compareContextReports(reportWith(RESOLVED_OFF_POLICY), reportWith(RESOLVED_ON_POLICY), { seed: 1, gate: 'token' })).not.toThrow();
  });

  it('prints both resolved policies and both code digests', () => {
    const text = formatContextComparison(compareContextReports(reportWith(CACHE_PREFIX_OFF, MAIN_CODE), reportWith(RESOLVED_ON_POLICY, HEAD_CODE), { seed: 1, gate: 'token' }));
    expect(text).toContain(`baseline policy: ${canonicalJson(CACHE_PREFIX_OFF)}`);
    expect(text).toContain(`candidate policy: ${canonicalJson(RESOLVED_ON_POLICY)}`);
    expect(text).toContain(`baseline codeDigest: ${MAIN_CODE}`);
    expect(text).toContain(`candidate codeDigest: ${HEAD_CODE}`);
    expect(text).toContain('policy differs in: context.cachePrefix');
  });

  it('still compares identical policies on identical code under the context gate, which judges guidelines', () => {
    expect(() => compareContextReports(reportWith(), reportWith(), { seed: 1, gate: 'context' })).not.toThrow();
  });
});

describe('the context report format', () => {
  it('is version 7, which records the resolved policy', () => {
    expect(CONTEXT_REPORT_FORMAT).toBe('momonga-eval-context-report/7');
    expect(reportWith().format).toBe('momonga-eval-context-report/7');
  });

  it('refuses a version 1 report as retired, naming the formats, the file and the base and candidate commands of the gate', () => {
    const { policy: _policy, codeDigest: _digest, ...rest } = reportWith();
    const retired = JSON.stringify({ ...rest, format: 'momonga-eval-context-report/1' });
    expect(() => parseContextReport(retired, 'base.json')).toThrow(EvalError);
    expect(() => parseContextReport(retired, 'base.json')).toThrow(/base\.json.*momonga-eval-context-report\/1 .*retired.*momonga-eval-context-report\/7/);
    expect(() => parseContextReport(retired, 'base.json')).not.toThrow(/required property/);
    expect(() => parseContextReport(retired, 'base.json')).toThrow(/policy .*recorded relative to the old defaults/);
    expect(() => parseContextReport(retired, 'base.json')).toThrow(
      /momonga eval context <dataset> --alias <alias> --settings <base policy file> --report <base report>.*momonga eval context <dataset> --alias <alias> --report <candidate report>.*momonga eval compare <base report> <candidate report> --gate token/,
    );
  });

  it('writes version 7 today, with the resolved policy and the code digest of the runs', () => {
    const stored = JSON.parse(encodeContextReport(reportWith(CACHE_PREFIX_OFF, HEAD_CODE))) as Record<string, unknown>;
    expect(stored['format']).toBe('momonga-eval-context-report/7');
    expect(stored['policy']).toEqual(CACHE_PREFIX_OFF);
    expect(stored['codeDigest']).toBe(HEAD_CODE);
  });
});

describe('the token gate base: one head, the feature off against the defaults', () => {
  it('accepts the all-off base against the defaults, from the same code digest', () => {
    const base = parseContextReport(encodeContextReport(reportWith(RESOLVED_OFF_POLICY, HEAD_CODE)), 'base.json');
    const head = parseContextReport(encodeContextReport(reportWith(RESOLVED_ON_POLICY, HEAD_CODE)), 'head.json');
    expect(() => compareContextReports(base, head, { seed: 1, gate: 'token' })).not.toThrow();
  });
});
