import { rmSync } from 'node:fs';
import type { EntryIo } from '@momonga/foundation';
import { INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import type { ReportPage, RunCostView, RunFactsView } from '@momonga/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_REPORT_DAYS, reliabilityText } from '../src/commands/reliability.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram, exitOfFailure } from '../src/program.ts';
import type { ProgramDeps } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { NO_HELPER } from './no-helper.ts';
import { createTempDir } from '@momonga/testkit';

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

let home: string;

beforeEach(() => {
  home = createTempDir();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const depsOf = (written: string[], completed: number[]): ProgramDeps => {
  const sink = { write: (text: string): boolean => (written.push(text), true) };
  const interrupt = new AbortController().signal;
  const ports = { version: '9.9.9', home, cwd: home, platform: process.platform, interrupt, terminal: undefined, stdout: sink, stderr: sink } as unknown as CliPorts;
  const entry = async (): Promise<number> => 0;
  return {
    ports,
    entries: { supervise: entry, gateway: entry, runtime: entry },
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: (code) => void completed.push(code),
  };
};

const exitOf = async (argv: readonly string[]): Promise<{ code: number | undefined; written: string }> => {
  const written: string[] = [];
  const completed: number[] = [];
  const deps = depsOf(written, completed);
  try {
    await buildProgram(deps).parseAsync([...argv], { from: 'user' });
  } catch (error) {
    return { code: exitOfFailure(error, deps.ports.stderr, deps.interrupt), written: written.join('') };
  }
  return { code: completed.at(-1), written: written.join('') };
};

const row = (runId: string, overrides: Partial<RunFactsView> = {}): RunFactsView => ({
  runId,
  rootRunId: runId,
  sessionId: 'sess',
  definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
  model: 'apple/fm',
  mode: 'manual',
  agent: 'build',
  origin: 'cli',
  status: 'COMPLETED',
  createdAt: T0,
  endedAt: T0 + 10,
  elapsedMs: 10,
  humanWaitMs: 0,
  tokensTotal: 0,
  costNano: 0,
  steps: 1,
  limits: {},
  asked: 0,
  elicited: 0,
  authorizationRequired: 0,
  sideEffectingCalls: 0,
  repeatedStarts: 0,
  reconciledAlreadyApplied: 0,
  reconciledNotApplied: 0,
  reconciledUnknown: 0,
  mutated: false,
  owed: false,
  verification: { rounds: 0, firstRoundPassed: null, failedRounds: 0, checkMs: 0, fixRoundTokens: 0 },
  answers: { allowOnce: 0, allowAlways: 0, rejectOnce: 0, rejectAlways: 0 },
  denials: { sandbox: 0, rule: 0, mode: 0, setting: 0, hook: 0, mandate: 0, superseded: 0, held: 0 },
  basis: { readOnly: 0, rule: 0, mode: 0, hook: 0, classifier: 0, person: 0 },
  declared: true,
  met: true,
  recoveries: [],
  ...overrides,
});

const clientOf = (rows: readonly RunFactsView[]) => ({
  reportFacts: async (): Promise<ReportPage> => ({ rows: [...rows], unavailable: [], nextCursor: null }),
  reportCost: async (runIds: readonly string[]): Promise<RunCostView[]> => runIds.map((runId) => ({ runId, calls: 0, retries: 0, notPriced: 0, legacyPrecisionCalls: 0, priced: [] })),
});

describe('momonga reliability --days is bounded where it is parsed', () => {
  it('refuses a day count whose period starts before the earliest representable instant, with the usage exit', async () => {
    const result = await exitOf(['reliability', '--days', '1e15']);
    expect(result.code).toBe(2);
    expect(result.written).toContain(String(MAX_REPORT_DAYS));
  });

  it('bounds the days to the largest count whose milliseconds are a valid date', () => {
    expect(new Date(-MAX_REPORT_DAYS * DAY).toISOString()).toMatch(/^-/);
    expect(Number.isNaN(new Date(-(MAX_REPORT_DAYS + 1) * DAY).getTime())).toBe(true);
  });

  it('prints the period of the largest day count it accepts', async () => {
    const text = await reliabilityText(clientOf([]), { groupBy: 'model', explain: false, days: MAX_REPORT_DAYS, json: false }, 0);
    expect(text).toContain(`the last ${MAX_REPORT_DAYS} days`);
  });
});

describe('momonga reliability: a name from a file reaches the terminal escaped', () => {
  it('prints an agent name holding a line break and an escape sequence on one line, escaped', async () => {
    const name = 'evil\n[agent=forged]\u001b[31m';
    const text = await reliabilityText(clientOf([row('run-1', { agent: name })]), { groupBy: 'agent', explain: false, days: 30, json: false }, T0 + DAY);
    const lines = text.split('\n');
    expect(lines).not.toContain('[agent=forged]\u001b[31m]');
    expect(lines.some((line) => line.startsWith('[agent=forged]'))).toBe(false);
    expect(text).not.toContain('\u001b');
    expect(lines.filter((line) => line.startsWith('[agent=evil'))).toHaveLength(1);
  });

  it('refuses a grouping by a task label, which a real run does not carry, with the usage exit', async () => {
    expect((await exitOf(['reliability', '--group-by', 'taskType'])).code).toBe(2);
    expect((await exitOf(['reliability', '--group-by', 'difficulty'])).code).toBe(2);
  });

  it('refuses --verify combined with an output option, with the usage exit', async () => {
    expect((await exitOf(['reliability', '--verify', '--json'])).code).toBe(2);
    expect((await exitOf(['reliability', '--json', '--explain'])).code).toBe(2);
  });
});
