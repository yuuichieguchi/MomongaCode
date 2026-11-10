import { describe, expect, it } from 'vitest';
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
} from '@momonga/eval';
import type { PolicyOverlay, Transcript } from '@momonga/eval';
import { contextCase, recorded } from './context-fixtures.ts';
import { buildReportAs } from './answered-fixtures.ts';

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

const reportWith = (policy: PolicyOverlay = {}, codeDigest = MAIN_CODE) =>
  buildReportAs({ dataset, transcripts: transcripts.map((transcript) => ({ ...transcript, policy, codeDigest })), model: 'real', seed: 1 });

const EVERY_KEY: PolicyOverlay = {
  context: { cachePrefix: true, outputFormatters: ['log', 'json', 'grep', 'identicalOutput'], loopGuidance: true, observedCapacity: true },
  tools: { deferral: true, conciseDescriptions: true },
  memory: { repositoryFacts: true },
};

describe('parsePolicyOverlay', () => {
  it('accepts every token key', () => {
    expect(parsePolicyOverlay(JSON.stringify(EVERY_KEY), 'policy.json')).toEqual({
      ...EVERY_KEY,
      context: { ...EVERY_KEY.context, outputFormatters: ['grep', 'identicalOutput', 'json', 'log'] },
    });
  });

  it('accepts an empty overlay', () => {
    expect(parsePolicyOverlay('{}', 'policy.json')).toEqual({});
  });

  it.each([
    ['a context key outside the token design', { context: { autoCompact: false } }],
    ['a memory key outside the token design', { memory: { forgetAfterDays: 3 } }],
    ['a section outside the token design', { models: { fallback: [] } }],
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

describe('the policy recorded in a context report', () => {
  it('records the overlay as policy', () => {
    expect(reportWith({ context: { cachePrefix: true } }).policy).toEqual({ context: { cachePrefix: true } });
  });

  it('records an empty policy when no overlay was given', () => {
    expect(reportWith().policy).toEqual({});
  });

  it('round-trips through the stored report', () => {
    const report = reportWith(EVERY_KEY);
    expect(parseContextReport(encodeContextReport(report), 'r.json')).toEqual(report);
  });

  it('refuses a stored report whose policy holds a key outside the token design', () => {
    const report = { ...reportWith(), policy: { context: { autoCompact: false } } };
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
  it('refuses two reports with the same policy on the same code', () => {
    const policy = { context: { cachePrefix: true } };
    expect(() => compareContextReports(reportWith(policy), reportWith(policy), { seed: 1, gate: 'token' })).toThrow(EvalError);
    expect(() => compareContextReports(reportWith(), reportWith(), { seed: 1, gate: 'token' })).toThrow(/identical policy and an identical code digest/);
  });

  it('treats policies that differ only in key order as identical', () => {
    const left = { context: { cachePrefix: true, loopGuidance: true }, tools: { deferral: true } };
    const right = { tools: { deferral: true }, context: { loopGuidance: true, cachePrefix: true } };
    expect(() => compareContextReports(reportWith(left), reportWith(right), { seed: 1, gate: 'token' })).toThrow(/identical/);
  });

  it('accepts the same policy on different code, the main-versus-head gate', () => {
    expect(() => compareContextReports(reportWith({}, MAIN_CODE), reportWith({}, HEAD_CODE), { seed: 1, gate: 'token' })).not.toThrow();
  });

  it('accepts different policies on the same code', () => {
    expect(() => compareContextReports(reportWith({}), reportWith({ context: { cachePrefix: true } }), { seed: 1, gate: 'token' })).not.toThrow();
  });

  it('prints both policies and both code digests', () => {
    const text = formatContextComparison(compareContextReports(reportWith({}, MAIN_CODE), reportWith({ context: { cachePrefix: true } }, HEAD_CODE), { seed: 1, gate: 'token' }));
    expect(text).toContain('baseline policy: {}');
    expect(text).toContain('candidate policy: {"context":{"cachePrefix":true}}');
    expect(text).toContain(`baseline codeDigest: ${MAIN_CODE}`);
    expect(text).toContain(`candidate codeDigest: ${HEAD_CODE}`);
  });

  it('still compares identical policies on identical code under the context gate, which judges guidelines', () => {
    expect(() => compareContextReports(reportWith(), reportWith(), { seed: 1, gate: 'context' })).not.toThrow();
  });
});

describe('policies are compared by their effect', () => {
  it('refuses an empty overlay against one that sets deferral to its default false, on the same code', () => {
    expect(() => compareContextReports(reportWith({}), reportWith({ tools: { deferral: false } }), { seed: 1, gate: 'token' })).toThrow(/identical/);
  });

  it('refuses an empty overlay against one that sets every key to its default, on the same code', () => {
    const allDefaults: PolicyOverlay = {
      context: { cachePrefix: false, outputFormatters: [], loopGuidance: false, observedCapacity: false },
      tools: { deferral: false, conciseDescriptions: false },
      memory: { repositoryFacts: false },
    };
    expect(() => compareContextReports(reportWith({}), reportWith(allDefaults), { seed: 1, gate: 'token' })).toThrow(/identical/);
  });

  it('refuses two overlays whose formatters differ only in order, on the same code', () => {
    const left: PolicyOverlay = { context: { outputFormatters: ['log', 'json'] } };
    const right: PolicyOverlay = { context: { outputFormatters: ['json', 'log'] } };
    expect(() => compareContextReports(reportWith(left), reportWith(right), { seed: 1, gate: 'token' })).toThrow(/identical/);
  });

  it('still accepts an overlay that turns a key on against one that leaves it at its default', () => {
    expect(() => compareContextReports(reportWith({ tools: { deferral: false } }), reportWith({ tools: { deferral: true } }), { seed: 1, gate: 'token' })).not.toThrow();
  });

  it('records the same policy in a report for an empty overlay and for an overlay of defaults', () => {
    expect(reportWith({ tools: { deferral: false }, context: { outputFormatters: [] } }).policy).toEqual(reportWith({}).policy);
  });

  it('records the same policy in a report for formatters given in either order', () => {
    expect(reportWith({ context: { outputFormatters: ['json', 'log'] } }).policy).toEqual(reportWith({ context: { outputFormatters: ['log', 'json'] } }).policy);
  });

  it('builds one report from transcripts whose overlays differ only by defaults', () => {
    const mixed = transcripts.map((transcript, index) => ({ ...transcript, policy: index === 0 ? {} : { tools: { deferral: false } }, codeDigest: MAIN_CODE }));
    expect(() => buildReportAs({ dataset, transcripts: mixed, model: 'real', seed: 1 })).not.toThrow();
  });
});

describe('the context report format', () => {
  it('is version 7, which records the policy, the code digest, what answered, which calls reported their cache reads and the price outcome of the calls', () => {
    expect(CONTEXT_REPORT_FORMAT).toBe('momonga-eval-context-report/7');
    expect(reportWith().format).toBe('momonga-eval-context-report/7');
  });

  it('refuses a version 1 report, naming the retired format, the required one and the file, not a schema path', () => {
    const { policy: _policy, codeDigest: _digest, ...rest } = reportWith();
    const retired = JSON.stringify({ ...rest, format: 'momonga-eval-context-report/1' });
    expect(() => parseContextReport(retired, 'base.json')).toThrow(EvalError);
    expect(() => parseContextReport(retired, 'base.json')).toThrow(/base\.json.*momonga-eval-context-report\/1 .*momonga-eval-context-report\/7/);
    expect(() => parseContextReport(retired, 'base.json')).not.toThrow(/required property/);
  });

  it('says a version 1 report is retired and names the off-against-on pair that produces a version 7 base', () => {
    const { policy: _policy, codeDigest: _digest, ...rest } = reportWith();
    const retired = JSON.stringify({ ...rest, format: 'momonga-eval-context-report/1' });
    expect(() => parseContextReport(retired, 'base.json')).toThrow(/retired/);
    expect(() => parseContextReport(retired, 'base.json')).toThrow(/momonga eval context .*--report/);
    expect(() => parseContextReport(retired, 'base.json')).toThrow(/--settings/);
    expect(() => parseContextReport(retired, 'base.json')).toThrow(/momonga eval compare .*--gate token/);
  });

  it('writes version 7 today, with the policy and the code digest of the runs', () => {
    const stored = JSON.parse(encodeContextReport(reportWith({ context: { cachePrefix: true } }, HEAD_CODE))) as Record<string, unknown>;
    expect(stored['format']).toBe('momonga-eval-context-report/7');
    expect(stored['policy']).toEqual({ context: { cachePrefix: true } });
    expect(stored['codeDigest']).toBe(HEAD_CODE);
  });
});

describe('the token gate base: one head, the policy off against on', () => {
  it('accepts the defaults against a policy turned on, from the same code digest', () => {
    const base = parseContextReport(encodeContextReport(reportWith({}, HEAD_CODE)), 'base.json');
    const head = parseContextReport(encodeContextReport(reportWith({ context: { cachePrefix: true } }, HEAD_CODE)), 'head.json');
    expect(() => compareContextReports(base, head, { seed: 1, gate: 'token' })).not.toThrow();
  });
});
