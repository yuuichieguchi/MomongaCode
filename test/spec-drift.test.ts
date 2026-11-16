import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EVENT_TYPES, REFUSING_PROPERTIES, RUN_STATUSES, STOP_REASONS, TERMINAL_STATUSES, UNKNOWN_VALUE } from '@momonga/protocol';
import type { PinnedRuleVerdict, RuleVerdict } from '@momonga/protocol';
import { unknownGateDecision } from '../packages/runtime/src/worker/unknown-gate.ts';
import { policyRefusal } from '../packages/runtime/src/worker/rule-verdict.ts';
import { cfgNames } from './formal/cfg-names.ts';
import { moduleOf, readManifest } from './formal/manifest.ts';
import { CLAIM_STATUSES, DEAD_LETTER_TRANSITIONS, SERVICE_TRANSITIONS, SWEEP_TRANSITIONS, WORKER_TRANSITIONS } from '@momonga/store';
import { resolveKernelLock } from '../packages/foundation/src/platform/kernel-lock.ts';
import { fixedLockCapability, SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const specPath = path.resolve(import.meta.dirname, '..', 'specs', 'tla', 'RunRecovery.tla');
const spec = fs.readFileSync(specPath, 'utf8');

const definitionOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined in ${specPath}`);
  const end = spec.indexOf('\n\n', start);
  return spec.slice(start, end === -1 ? undefined : end);
};

const stringsIn = (text: string): string[] => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);

const setOf = (name: string): string[] => stringsIn(definitionOf(name)).sort();

const tableOf = (name: string): Record<string, string[]> =>
  Object.fromEntries(
    [...definitionOf(name).matchAll(/(\w+)\s*\|->\s*\{([^}]*)\}/g)].map((match) => [match[1] as string, stringsIn(match[2] as string).sort()]),
  );

const codeTable = (table: Record<string, readonly string[]>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(table).map(([status, targets]) => [status, [...targets].sort()]));

const UNMODELLED_EVENT_TYPES = [
  'user_shell',
  'agent.message.delta',
  'agent.thought.delta',
  'approval.rule.persisted',
  'attempt.failed',
  'attempt.lost',
  'context.compacted',
  'context.compacting',
  'context.compaction_rejected',
  'context.contribution',
  'context.governing_loaded',
  'context.inherited',
  'context.inherited_compacted',
  'context.memories_loaded',
  'context.truncated',
  'hook.completed',
  'hook.started',
  'instructions.loaded',
  'job.finished',
  'loop.warned',
  'budget.exhausted',
  'tool.held',
  'tool.held.resolved',
  'run.quiescent',
  'mcp.authorization.required',
  'meter.observed',
  'inbox.changed',
  'mode.changed',
  'model.changed',
  'model.rejected',
  'model.stream.restarted',
  'notice',
  'plan.updated',
  'skill.activated',
  'verification.started',
  'verification.completed',
  'tool.elicitation.cancelled',
  'tool.elicitation.requested',
  'tool.elicitation.resolved',
  'tool.loaded',
  'tool.offered',
  'tool.permission.classified',
  'tool.permission.classifying',
  'tool.updated',
  'usage.charged',
  'usage.updated',
  'user.compact',
];

describe('RunRecovery.tla against the implementation', () => {
  it('names exactly the run states of the protocol', () => {
    expect(setOf('Statuses')).toEqual([...RUN_STATUSES].sort());
  });

  it('names exactly the terminal states of the protocol', () => {
    expect(setOf('Terminal')).toEqual([...TERMINAL_STATUSES].sort());
  });

  it('names exactly the statuses a claim can hold', () => {
    expect(setOf('ClaimStatuses')).toEqual([...CLAIM_STATUSES].sort());
  });

  it.each([
    ['WorkerEdges', WORKER_TRANSITIONS],
    ['ServiceEdges', SERVICE_TRANSITIONS],
    ['SweepEdges', SWEEP_TRANSITIONS],
    ['DeadLetterEdges', DEAD_LETTER_TRANSITIONS],
  ])('%s is the transition table of the store, and a status this build does not know has no edge', (name, table) => {
    expect(codeTable(table)).toEqual({ ...tableOf(name), [UNKNOWN_VALUE]: [] });
  });

  it('ends a cancel of every non-terminal status through CANCELLING, in the model and in the store (O13): no service or sweep edge leads to CANCELLED', () => {
    expect(tableOf('ServiceEdges')['QUEUED']).toEqual(['CANCELLING']);
    expect(tableOf('ServiceEdges')['WAITING_HUMAN']).toEqual(['CANCELLING', 'QUEUED', 'STOPPED']);
    expect(tableOf('SweepEdges')['WAITING_HUMAN']).toEqual(['CANCELLING', 'QUEUED', 'STOPPED']);
    for (const table of [SERVICE_TRANSITIONS, SWEEP_TRANSITIONS]) {
      expect(Object.values(table).flat()).not.toContain('CANCELLED');
    }
    expect([...SERVICE_TRANSITIONS.QUEUED]).toEqual(['CANCELLING']);
    expect([...SERVICE_TRANSITIONS.WAITING_HUMAN].sort()).toEqual(['CANCELLING', 'QUEUED', 'STOPPED']);
    expect([...SWEEP_TRANSITIONS.WAITING_HUMAN].sort()).toEqual(['CANCELLING', 'QUEUED', 'STOPPED']);
  });

  it('keeps one cancel rule: the model has no UniformCancel switch, no second table and no cancel target that depends on the status', () => {
    expect(spec).not.toMatch(/\bUniformCancel\b/);
    expect(spec).not.toMatch(/^UniformServiceEdges ==|^UniformSweepEdges ==|^CancelTarget\(/m);
  });

  it('ties SweeperOwned of the model to the SQL predicate the store uses to keep sweeper-owned runs out of claim', () => {
    const modelOrigins = stringsIn(definitionOf('SweeperOwned').replace(/^.*?cancelOrigin \\in/s, '')).sort();
    expect(definitionOf('SweeperOwned')).toMatch(/x\.status = "CANCELLING" \/\\ x\.cancelOrigin \\in \{"QUEUED", "WAITING_HUMAN"\}/);
    expect(modelOrigins).toEqual(['QUEUED', 'WAITING_HUMAN']);
    const storeSource = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'packages', 'store', 'src', 'runtime-store.ts'), 'utf8');
    const predicate = /status = 'CANCELLING' AND (?:\w+\.)?cancel_origin IN \(([^)]*)\)/.exec(storeSource);
    expect(predicate, 'runtime-store.ts states the sweeper-owned predicate').not.toBeNull();
    const sqlOrigins = [...(predicate?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((match) => match[1] as string).sort();
    expect(sqlOrigins).toEqual(modelOrigins);
    const claimable = /const CLAIMABLE = `([^`]*)`/.exec(storeSource)?.[1] ?? '';
    expect(claimable).toMatch(/NOT \(\s*(?:\w+\.)?status = 'CANCELLING' AND (?:\w+\.)?cancel_origin IN \('QUEUED', 'WAITING_HUMAN'\)\s*\)/);
  });

  it('models only event kinds that the protocol defines', () => {
    const modelled = setOf('ModelledEvents');
    expect(modelled.filter((kind) => !(EVENT_TYPES as readonly string[]).includes(kind))).toEqual([]);
  });

  it('decides explicitly about every event kind it does not model', () => {
    const modelled = new Set(setOf('ModelledEvents'));
    const unmodelled = EVENT_TYPES.filter((kind) => !modelled.has(kind)).sort();
    expect(unmodelled).toEqual([...UNMODELLED_EVENT_TYPES].sort());
  });

  it('records attempt.failed as an observation outside the model: the protocol defines it and ModelledEvents does not', () => {
    expect(EVENT_TYPES as readonly string[]).toContain('attempt.failed');
    expect(setOf('ModelledEvents')).not.toContain('attempt.failed');
  });

  it('emits only event kinds it declares as modelled', () => {
    const modelled = new Set(setOf('ModelledEvents'));
    const emitted = [...spec.matchAll(/\bE\("([a-z.]+)"/g)].map((match) => match[1] as string);
    expect(emitted.filter((kind) => !modelled.has(kind))).toEqual([]);
  });
});

describe('STOP_REASONS against RunRecovery.tla and the store', () => {
  const schemaSource = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'packages', 'store', 'src', 'schema.ts'), 'utf8');

  const NO_COMING_STOP_REASONS: readonly string[] = [];

  const widenedReasonsOf = (source: string): string[] => {
    const widened = [...source.matchAll(/stop_reason IS NULL OR stop_reason IN \(([^)]*)\)/g)].at(-1);
    return [...(widened?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1] as string);
  };

  const comingReasonsOf = (list: readonly string[]): string[] => list.filter((reason) => !(STOP_REASONS as readonly string[]).includes(reason)).sort();

  it('is a subset of the stop_reason CHECK of the widened runs table, each reason once, and the rest is exactly the coming reasons, none today (design-chatgpt-plan O-R5-6 L7)', () => {
    expect(schemaSource.indexOf('const RUNS_STOP_REASONS_WIDENED')).toBeLessThan(schemaSource.lastIndexOf('stop_reason IS NULL OR stop_reason IN ('));
    const list = widenedReasonsOf(schemaSource);
    expect(list.length, 'schema.ts states the widened stop_reason CHECK').toBeGreaterThan(0);
    expect(new Set(list).size).toBe(list.length);
    expect(STOP_REASONS.every((reason) => list.includes(reason))).toBe(true);
    expect(comingReasonsOf(list)).toEqual(NO_COMING_STOP_REASONS);
  });

  it('checks the coming reasons strictly: a reason in the CHECK that the protocol does not know is found', () => {
    const planted = `stop_reason IS NULL OR stop_reason IN (${[...STOP_REASONS, 'planted_reason'].map((reason) => `'${reason}'`).join(', ')})`;
    expect(comingReasonsOf(widenedReasonsOf(planted))).toEqual(['planted_reason']);
  });

  it('is one STOPPED terminal in the model: no stop reason is a variable, and STOPPED has no outgoing edge in any table', () => {
    expect(spec).not.toMatch(/stopReason|stop_reason/i);
    expect(setOf('Terminal')).toContain('STOPPED');
    for (const name of ['WorkerEdges', 'ServiceEdges', 'SweepEdges', 'DeadLetterEdges']) {
      expect(tableOf(name)['STOPPED'] ?? [], name).toEqual([]);
    }
    for (const table of [WORKER_TRANSITIONS, SERVICE_TRANSITIONS, SWEEP_TRANSITIONS, DEAD_LETTER_TRANSITIONS] as Array<Record<string, readonly string[]>>) {
      expect(table['STOPPED'] ?? []).toEqual([]);
    }
  });

  it('is reachable by a worker only as a stop at a step boundary: RUNNING may leave to STOPPED in the model and in the store', () => {
    expect(tableOf('WorkerEdges')['RUNNING']).toContain('STOPPED');
    expect([...WORKER_TRANSITIONS.RUNNING]).toContain('STOPPED');
  });
});

const configDir = path.resolve(import.meta.dirname, '..', 'specs', 'tla');

const constantsOf = (name: string): Readonly<Record<string, string>> => cfgNames(configDir, name).constants;

const manifest = readManifest(path.join(configDir, 'manifest.json'));
const recoveryEntries = manifest.entries.filter((entry) => entry.config.split('.')[0] === 'RunRecovery');
const checkNames = recoveryEntries.filter((entry) => entry.role === 'check').map((entry) => entry.config);
const evidenceNames = recoveryEntries
  .filter((entry) => entry.role === 'evidence' && !entry.config.startsWith('RunRecovery.uniformCancel') && !entry.config.startsWith('RunRecovery.liveTimeout'))
  .map((entry) => entry.config);
const configText = (name: string): string => fs.readFileSync(path.join(configDir, `${name}.cfg`), 'utf8');
const hasInvariantSection = (name: string): boolean => cfgNames(configDir, name).invariants.length > 0;
const lists = (name: string, checked: string): boolean => {
  const names = cfgNames(configDir, name);
  return [...names.invariants, ...names.properties].includes(checked);
};

describe('the checked configurations against the repaired recovery design', () => {
  const repairs = (name: string): [string, string, string] => {
    const constants = constantsOf(name);
    return [constants['UnfencedEffect'] as string, constants['NoCallLock'] as string, constants['NoReapBeforeReconcile'] as string];
  };

  it('declares no UniformCancel constant in any RunRecovery configuration, since the uniform cancel is the only rule', () => {
    expect(recoveryEntries.length).toBeGreaterThan(0);
    for (const entry of recoveryEntries) {
      expect(constantsOf(entry.config), entry.config).not.toHaveProperty('UniformCancel');
    }
  });

  it('checks the code with all three repairs in every configuration that is not evidence', () => {
    expect(checkNames.length).toBeGreaterThan(0);
    for (const name of checkNames) {
      expect(repairs(name), name).toEqual(['FALSE', 'FALSE', 'FALSE']);
    }
  });

  it('keeps one configuration per missing repair, the ones with a single repair, and one with none as evidence', () => {
    const switchesOf: Record<string, [string, string, string]> = {
      'RunRecovery.unlocked': ['FALSE', 'TRUE', 'FALSE'],
      'RunRecovery.noReap': ['FALSE', 'FALSE', 'TRUE'],
      'RunRecovery.lockOnly': ['FALSE', 'FALSE', 'TRUE'],
      'RunRecovery.fenceOnly': ['FALSE', 'TRUE', 'TRUE'],
      'RunRecovery.reapOnly': ['TRUE', 'TRUE', 'FALSE'],
      'RunRecovery.unfixed': ['TRUE', 'TRUE', 'TRUE'],
      'RunRecovery.abortDropsLock': ['FALSE', 'FALSE', 'FALSE'],
      'RunRecovery.unknownUngated': ['FALSE', 'FALSE', 'FALSE'],
      'RunRecovery.ungatedRules': ['FALSE', 'FALSE', 'FALSE'],
      'RunRecovery.refusesNote': ['FALSE', 'FALSE', 'FALSE'],
    };
    expect([...evidenceNames].sort()).toEqual(Object.keys(switchesOf).sort());
    for (const name of evidenceNames) expect(repairs(name), name).toEqual(switchesOf[name]);
  });

  it('checks the reconcile and lock invariants in the configurations that check the code with an invariant section', () => {
    const invariantChecks = checkNames.filter(hasInvariantSection);
    expect(invariantChecks.length).toBeGreaterThan(0);
    for (const name of invariantChecks) {
      for (const invariant of ['AtMostOnceEffect', 'ReconcileSeesStoppedEffect', 'NoEffectDuringReconcile', 'LockIsExclusive']) {
        expect(lists(name, invariant), `${name} lists ${invariant}`).toBe(true);
      }
    }
  });

  it('names only invariants and properties that the spec defines', () => {
    const configs = fs.readdirSync(configDir).filter((file) => file.endsWith('.cfg'));
    expect(configs.length).toBeGreaterThan(0);
    for (const file of configs) {
      const names = cfgNames(configDir, file.slice(0, -'.cfg'.length));
      const listed = [...names.invariants, ...names.properties];
      const moduleText = fs.readFileSync(path.join(configDir, `${moduleOf(file.slice(0, -'.cfg'.length))}.tla`), 'utf8');
      for (const name of listed) expect(moduleText, `${file} names ${name}`).toMatch(new RegExp(`^${name} ==`, 'm'));
    }
  });

  describe('the call lock of the model, against the code', () => {
    it('takes exclusion from the kernel lock mechanism the proof of the directory selects, and the model holds the lock in Held', () => {
      expect(resolveKernelLock('/unused', { capability: fixedLockCapability('proved') }).name).toBe('file-lock');
      expect(resolveKernelLock('/unused', { capability: fixedLockCapability('unenforced') }).name).toBe('sqlite-lock');
      expect(resolveKernelLock('/unused', { capability: fixedLockCapability('unmeasured') }).name).toBe('sqlite-lock');
      expect(definitionOf('Held')).toContain('wlock[x]');
    });

    it('derives the wait for a held lock from the heartbeat, the settle limit and the kill grace, in the code the model names', () => {
      const executor = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'packages', 'tools', 'src', 'executor.ts'), 'utf8');
      expect(executor).toMatch(/heldCallWaitMs = \(heartbeatMs: number\): number => heartbeatMs \+ ABORT_SETTLE_LIMIT_MS \+ SANDBOX_STOP_BOUND_MS/);
      expect(definitionOf('LockWaitExpired')).toContain('Held(KeyOf(w))');
    });
  });

  it('records the edges of run.status events in every configuration that checks OnlyDeclaredEdges', () => {
    const checkingEdges = checkNames.filter((name) => lists(name, 'OnlyDeclaredEdges'));
    expect(checkingEdges.length).toBeGreaterThan(0);
    for (const name of checkingEdges) {
      expect(constantsOf(name)['StatusEdgesRecorded'], name).toBe('TRUE');
    }
  });
});

describe('the generation actors of RunRecovery.tla', () => {
  it('keeps the call lock while the child of a stopped worker lives, in the abort and in the stale ledger, as the executor holds it until the tool settles', () => {
    expect(definitionOf('Abort')).toContain('KeepsLockWhileChild');
    expect(definitionOf('StaleLedger')).toContain('KeepsLockWhileChild');
    expect(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'packages', 'tools', 'src', 'executor.ts'), 'utf8')).toContain('callLockDir');
  });

  it('states the retiring-child invariant, and checks it with the lock and the generations in the generation configurations', () => {
    expect(spec).toMatch(/^RetiringChildNeverReaped == ~flags\.reapedLive$/m);
    for (const name of ['RunRecovery', 'RunRecovery.generations', 'RunRecovery.genDies']) {
      expect(lists(name, 'RetiringChildNeverReaped'), name).toBe(true);
      expect(constantsOf(name)['KeepsLockWhileChild'], name).toBe('TRUE');
    }
  });

  it('declares the generation constants in every configuration, with the legacy values in the single-generation ones', () => {
    for (const entry of recoveryEntries) {
      const constants = constantsOf(entry.config);
      for (const name of ['Gen2Workers', 'Promotes', 'GenDies', 'KeepsLockWhileChild']) expect(constants, `${entry.config} ${name}`).toHaveProperty(name);
    }
    expect(constantsOf('RunRecovery.generations')['Promotes']).toBe('TRUE');
    expect(constantsOf('RunRecovery.genDies')['GenDies']).toBe('TRUE');
  });

  it('keeps the generation configurations free of symmetry, since their workers belong to different generations', () => {
    for (const name of ['RunRecovery.generations', 'RunRecovery.genDies']) expect(configText(name), name).not.toMatch(/^SYMMETRY/m);
  });
});


describe('the failed listing of ProcessStop.tla', () => {
  const processStopChecks = manifest.entries.filter((entry) => entry.config.split('.')[0] === 'ProcessStop' && entry.role === 'check' && constantsOf(entry.config)['Escape'] === 'TRUE').map((entry) => entry.config);

  it('checks that a failed listing says unlisted and no stop word in every check configuration where a listing can fail', () => {
    expect(processStopChecks.length).toBeGreaterThan(0);
    for (const name of processStopChecks) {
      expect(lists(name, 'ListFailureSaysUnlisted'), name).toBe(true);
      expect(lists(name, 'NoWordFromFailedListing'), name).toBe(true);
    }
  });

  it.each([
    ['ProcessStop.listFailAsUnconfirmed', 'ListFailureSaysUnlisted'],
    ['ProcessStop.listFailAsEmpty', 'NoWordFromFailedListing'],
  ])('keeps %s as the every-run evidence that violates %s', (config, property) => {
    expect(manifest.entries.find((entry) => entry.config === config)).toMatchObject({ role: 'evidence', tier: 'every-run', expect: { violates: property, exitCode: 13 } });
    expect(lists(config, property)).toBe(true);
  });
});

describe('the unknown-effect gate of RunRecovery.tla, against the gate of the code', () => {
  it('sends a worker whose step ended in an unknown outcome to the gate, after the journal write and after a crash before the ask', () => {
    expect(definitionOf('JournalOut')).toContain('"unknownGate"');
    expect(definitionOf('DispatchTarget')).toContain('"unknownGate"');
    expect(definitionOf('UnknownGate')).toContain('E("tool.unknown.requested"');
  });

  it('answers each case of the model as the code does: an unresolved unknown outcome waits for a person, an asked one waits without a second ask, an answered one continues', () => {
    const cases: { model: string; effects: Parameters<typeof unknownGateDecision>[0]; decision: ReturnType<typeof unknownGateDecision> }[] = [
      { model: 'no unknown outcome: loop', effects: {}, decision: { kind: 'continue' } },
      { model: 'unknown, not asked: UnknownGate appends tool.unknown.requested and yields', effects: { call_1: { acknowledged: false } }, decision: { kind: 'wait', ask: ['call_1'] } },
      { model: 'unknown, asked and pending: UnknownGate yields without a second ask', effects: { call_1: { approvalId: 'a1', acknowledged: false } }, decision: { kind: 'wait', ask: [] } },
      { model: 'unknown, resolved: DispatchTarget gives loop', effects: { call_1: { approvalId: 'a1', acknowledged: true } }, decision: { kind: 'continue' } },
    ];
    for (const { model, effects, decision } of cases) expect(unknownGateDecision(effects), model).toEqual(decision);
  });
});

describe('the rule verdict of RunRecovery.tla, against the refusal of the code', () => {
  const verdictOf = (verdict: RuleVerdict['verdict'], refuted: readonly string[]): PinnedRuleVerdict => ({
    fingerprint: 'f',
    solver: 's',
    verdict,
    refuted: refuted.map((property) => ({ property, subject: 'Read(~/.ssh/**)', message: 'opened by an allow rule' })),
    unknown: verdict === 'unknown' ? [{ property: 'verification', reason: 'budget' }] : [],
    notProved: [],
  });

  it('refuses exactly when the model refuses: a refutation of a refusing property, never a consistency finding, never unknown, never proved', () => {
    expect(definitionOf('Refuses')).toContain('vref');
    const consistency = 'deny-precedence';
    expect(REFUSING_PROPERTIES as readonly string[]).not.toContain(consistency);
    const cases: { model: string; verdict: PinnedRuleVerdict; refuses: boolean }[] = [
      { model: 'vstate refuted, vref TRUE', verdict: verdictOf('refuted', [REFUSING_PROPERTIES[0]]), refuses: true },
      { model: 'vstate refuted, vref FALSE', verdict: verdictOf('refuted', [consistency]), refuses: false },
      { model: 'vstate unknown', verdict: verdictOf('unknown', []), refuses: false },
      { model: 'vstate proved', verdict: verdictOf('proved', []), refuses: false },
    ];
    for (const { model, verdict, refuses } of cases) expect(policyRefusal(verdict) !== undefined, model).toBe(refuses);
    for (const property of REFUSING_PROPERTIES) expect(policyRefusal(verdictOf('refuted', [property])), property).toBeDefined();
  });

  it('never stores unknown as a final verdict, in the model and in the code', () => {
    expect(spec).toMatch(/^UnknownNotFinal == stored # "unknown"$/m);
  });
});
