import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORE_SETTING_KEYS } from '@momonga/config';
import {
  CONTEXT_DATASET_FORMAT,
  CONTEXT_REPORT_FORMAT,
  EvalError,
  TRANSCRIPT_FORMAT,
  TranscriptError,
  caseSettingsFor,
  compareContextReports,
  decodeTranscript,
  encodeContextReport,
  encodeTranscript,
  expandContextDataset,
  formatContextComparison,
  parseContextDataset,
  parseContextReport,
  parsePolicyOverlay,
  resolvePolicyOverlay,
  runContextDataset,
} from '@momonga/eval';
import type { ContextCaseHost, EvalRunApi, PolicyOverlay, Transcript } from '@momonga/eval';
import { POLICY_OVERLAY_SCHEMA } from '../src/context-policy.ts';
import { RECORDED_CODE_DIGEST, RESOLVED_OFF_POLICY, RESOLVED_ON_POLICY } from './fixtures.ts';
import { contextCase, recorded } from './context-fixtures.ts';
import { REAL_TARGET, buildReportAs } from './answered-fixtures.ts';

const CORE_OFF_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'policies', 'core-off.json');

const RESOLVED_ON = RESOLVED_ON_POLICY;
const RESOLVED_OFF = RESOLVED_OFF_POLICY;

const OVERLAY_KEYS = [
  'context.adaptiveBudget',
  'context.autoCompact',
  'context.cachePrefix',
  'context.loopGuidance',
  'context.observedCapacity',
  'context.outputFormatters',
  'context.unboundedOutputReserve',
  'memory.reflection.enabled',
  'memory.repositoryFacts',
  'tools.conciseDescriptions',
  'tools.deferral',
];

type SchemaNode = { type?: string; properties?: Record<string, SchemaNode> };

const leavesOf = (node: SchemaNode, prefix: string): string[] =>
  Object.entries(node.properties ?? {}).flatMap(([name, child]) => {
    const key = prefix === '' ? name : `${prefix}.${name}`;
    return child.type === 'object' && child.properties !== undefined ? leavesOf(child, key) : [key];
  });

const SCENARIOS = ['a', 'b'] as const;
const dataset = parseContextDataset(
  JSON.stringify({
    format: CONTEXT_DATASET_FORMAT,
    name: 'economy',
    cases: SCENARIOS.flatMap((scenario) => [contextCase(`${scenario}-on`, scenario, 'on'), contextCase(`${scenario}-off`, scenario, 'off')]),
  }),
  'economy.json',
);

const MAIN_CODE = 'a'.repeat(64);

const reportWith = (policy: unknown, codeDigest = MAIN_CODE) =>
  buildReportAs({
    dataset,
    transcripts: SCENARIOS.flatMap((scenario) => [recorded(`${scenario}-on`, 0, []), recorded(`${scenario}-off`, 0, [])]).map((transcript) => ({
      ...transcript,
      policy: policy as PolicyOverlay,
      codeDigest,
    })),
    model: 'real',
    seed: 1,
  });

describe('the overlay schema covers the core keys (design core-on 3.2, test 6)', () => {
  it('holds exactly the keys of the core list, autoCompact included', () => {
    const keys = leavesOf(POLICY_OVERLAY_SCHEMA as unknown as SchemaNode, '').sort();
    expect(keys).toEqual(OVERLAY_KEYS);
    expect([...CORE_SETTING_KEYS].sort()).toEqual(keys);
  });
});

describe('parsing and resolving a policy overlay (design core-on 3.2, test 7)', () => {
  it('resolves an empty overlay to the on defaults with every core key present and the formatters sorted', () => {
    expect(resolvePolicyOverlay(parsePolicyOverlay('{}', 'policy.json'))).toEqual(RESOLVED_ON);
  });

  it('resolves the shipped core-off.json to every key off', () => {
    const text = fs.readFileSync(CORE_OFF_FILE, 'utf8');
    expect(resolvePolicyOverlay(parsePolicyOverlay(text, CORE_OFF_FILE))).toEqual(RESOLVED_OFF);
  });

  it('accepts an overlay that restates every default, which is the candidate of the gate', () => {
    const restated = JSON.stringify({ ...RESOLVED_ON, context: { ...RESOLVED_ON.context, outputFormatters: ['log', 'json', 'grep', 'identicalOutput'] } });
    expect(resolvePolicyOverlay(parsePolicyOverlay(restated, 'policy.json'))).toEqual(RESOLVED_ON);
  });

  it('keeps a key equal to its default instead of dropping it', () => {
    expect(parsePolicyOverlay(JSON.stringify({ tools: { deferral: false, conciseDescriptions: true } }), 'policy.json')).toEqual({ tools: { deferral: false, conciseDescriptions: true } });
  });

  it('turns off exactly the key an overlay turns off', () => {
    expect(resolvePolicyOverlay(parsePolicyOverlay(JSON.stringify({ memory: { reflection: { enabled: false } } }), 'policy.json'))).toEqual({
      ...RESOLVED_ON,
      memory: { reflection: { enabled: false }, repositoryFacts: true },
    });
  });

  it('refuses an unknown key, an unknown key inside reflection, a wrong type and a bad formatter name, each with its pointer', () => {
    const refused: [unknown, RegExp][] = [
      [{ context: { lazyPrefix: true } }, /policy\.json.*\/context\/lazyPrefix/],
      [{ memory: { reflection: { enabled: true, maxTokens: 9 } } }, /policy\.json.*\/memory\/reflection\/maxTokens/],
      [{ context: { adaptiveBudget: 'yes' } }, /policy\.json.*\/context\/adaptiveBudget/],
      [{ context: { outputFormatters: ['markdown'] } }, /policy\.json.*\/context\/outputFormatters\/0/],
    ];
    for (const [overlay, message] of refused) {
      expect(() => parsePolicyOverlay(JSON.stringify(overlay), 'policy.json')).toThrow(EvalError);
      expect(() => parsePolicyOverlay(JSON.stringify(overlay), 'policy.json')).toThrow(message);
    }
  });
});

describe('the report records the resolved policy (design core-on 3.2, test 8)', () => {
  it('records every core key in the stored report and reads it back', () => {
    const encoded = encodeContextReport(reportWith(RESOLVED_ON));
    expect((JSON.parse(encoded) as { policy: unknown }).policy).toEqual(RESOLVED_ON);
    expect(parseContextReport(encoded, 'r.json').policy).toEqual(RESOLVED_ON);
  });

  it('refuses a stored report whose policy is an overlay rather than the resolved policy', () => {
    const report = { ...reportWith(RESOLVED_ON), policy: { context: { cachePrefix: true } } };
    expect(() => parseContextReport(JSON.stringify(report), 'r.json')).toThrow(/not a context report/);
  });

  it('refuses equal resolved policies on equal code, and accepts reports that differ in one key and names that key in the detail', () => {
    expect(() => compareContextReports(reportWith(RESOLVED_ON), reportWith(RESOLVED_ON), { seed: 1, gate: 'token' })).toThrow(/identical policy and an identical code digest/);
    const base = reportWith({ ...RESOLVED_ON, tools: { conciseDescriptions: true, deferral: false } });
    const text = formatContextComparison(compareContextReports(base, reportWith(RESOLVED_ON), { seed: 1, gate: 'token' }));
    expect(text).toContain('policy differs in: tools.deferral');
  });

  it('names every differing key for the all-off base against the defaults', () => {
    const text = formatContextComparison(compareContextReports(reportWith(RESOLVED_OFF), reportWith(RESOLVED_ON), { seed: 1, gate: 'token' }));
    expect(text).toContain(`policy differs in: ${OVERLAY_KEYS.join(', ')}`);
  });

  it('is format 7, and refuses a format 6 report as retired with the base and candidate commands of the new procedure', () => {
    expect(CONTEXT_REPORT_FORMAT).toBe('momonga-eval-context-report/7');
    const retired = JSON.stringify({ ...reportWith(RESOLVED_ON), format: 'momonga-eval-context-report/6', policy: {} });
    expect(() => parseContextReport(retired, 'base.json')).toThrow(EvalError);
    expect(() => parseContextReport(retired, 'base.json')).toThrow(/base\.json.*momonga-eval-context-report\/6 .*retired.*momonga-eval-context-report\/7/);
    expect(() => parseContextReport(retired, 'base.json')).toThrow(/policy .*recorded relative to the old defaults/);
    expect(() => parseContextReport(retired, 'base.json')).toThrow(
      /momonga eval context <dataset> --alias <alias> --settings <base policy file> --report <base report>.*momonga eval context <dataset> --alias <alias> --report <candidate report>.*momonga eval compare <base report> <candidate report> --gate token/,
    );
  });
});

describe('the transcript format (design core-on 3.2)', () => {
  it('is format 8 and refuses a format 7 transcript as retired', () => {
    expect(TRANSCRIPT_FORMAT).toBe('momonga-transcript/8');
    const transcript = { ...recorded('a-on', 0, []), policy: RESOLVED_ON as unknown as PolicyOverlay, codeDigest: RECORDED_CODE_DIGEST };
    const lines = encodeTranscript(transcript).split('\n');
    const header = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    const old = [JSON.stringify({ ...header, format: 'momonga-transcript/7' }), ...lines.slice(1)].join('\n');
    expect(() => decodeTranscript(old, 't.jsonl')).toThrow(TranscriptError);
    expect(() => decodeTranscript(old, 't.jsonl')).toThrow(/momonga-transcript\/7.*momonga-transcript\/8/);
    expect(() => decodeTranscript(old, 't.jsonl')).toThrow(/policy .*recorded relative to the old defaults/);
    expect(() => decodeTranscript(old, 't.jsonl')).toThrow(
      /momonga eval context <dataset> --alias <alias> --settings <base policy file> --report <base report>.*momonga eval context <dataset> --alias <alias> --report <candidate report>/,
    );
  });
});

const liveHarness = () => {
  const openCase = async (entry: { id: string }): Promise<ContextCaseHost> => {
    const api: EvalRunApi = {
      createSession: async () => ({ id: `s-${entry.id}` }),
      createRun: async () => ({ id: `r-${entry.id}` }),
      events: async function* () {},
      reflectionOf: async () => ({ state: 'none' }),
      answeredBy: async () => [REAL_TARGET],
      getRun: async (runId) => ({ id: runId, status: 'COMPLETED', step: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 10 }, modelAlias: 'gamma' }),
      resolveApproval: async () => undefined,
      cancelRun: async () => undefined,
    };
    return {
      cwd: `/w/${entry.id}`,
      api,
      rules: { add: async () => ({ fact: { id: 'fact-1' } }), retire: async () => undefined },
      seedMemory: async () => undefined,
      applyStep: async () => undefined,
      close: async () => undefined,
    } as unknown as ContextCaseHost;
  };
  return (policy: PolicyOverlay) => ({
    policy,
    codeDigest: RECORDED_CODE_DIGEST,
    openCase,
    modelAlias: 'gamma',
    deadline: (_caseId: string, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    bounds: { datasetTokens: 1_000_000, caseDeadlineMs: {} },
  });
};

describe('a live run records the resolved policy and passes only the overlay to the cases (design core-on 3.3, test 9)', () => {
  it('records the on policy when no --settings is given, and the case settings carry nothing for the core sections', async () => {
    const portsFor = liveHarness();
    const { transcripts } = await runContextDataset(expandContextDataset(dataset, 1), portsFor({}));
    for (const transcript of transcripts) expect(transcript.policy).toEqual(RESOLVED_ON);
    expect(caseSettingsFor({ sandbox: 'none' }, { policy: {} })).toEqual({ sandbox: 'none' });
  });

  it('records every key off under core-off.json, and the case settings carry exactly that overlay', async () => {
    const overlay = parsePolicyOverlay(fs.readFileSync(CORE_OFF_FILE, 'utf8'), CORE_OFF_FILE);
    const portsFor = liveHarness();
    const { transcripts } = await runContextDataset(expandContextDataset(dataset, 1), portsFor(overlay));
    for (const transcript of transcripts) expect(transcript.policy).toEqual(RESOLVED_OFF);
    expect(caseSettingsFor({ sandbox: 'none' }, { policy: overlay })).toEqual({ sandbox: 'none', ...overlay });
  });

  it('lets a case that declares its own compaction keep it over the overlay of core-off.json', () => {
    const overlay = parsePolicyOverlay(fs.readFileSync(CORE_OFF_FILE, 'utf8'), CORE_OFF_FILE);
    const settings = caseSettingsFor({ sandbox: 'none' }, { compaction: 'on', policy: overlay }) as { context: Record<string, unknown> };
    expect(settings.context).toEqual({ ...RESOLVED_OFF.context, autoCompact: true });
  });
});
