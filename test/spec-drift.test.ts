import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKernelLockMechanism } from '@momonga/foundation';
import { EVENT_TYPES, RUN_STATUSES, TERMINAL_STATUSES } from '@momonga/protocol';
import { moduleOf, readManifest } from './formal/manifest.ts';
import { CLAIM_STATUSES, DEAD_LETTER_TRANSITIONS, SERVICE_TRANSITIONS, SWEEP_TRANSITIONS, WORKER_TRANSITIONS } from '@momonga/store';

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
  'agent.message.delta',
  'agent.thought.delta',
  'approval.rule.persisted',
  'context.compacted',
  'context.compaction_rejected',
  'context.contribution',
  'context.governing_loaded',
  'context.inherited',
  'context.memories_loaded',
  'context.truncated',
  'hook.completed',
  'instructions.loaded',
  'job.finished',
  'loop.warned',
  'mcp.authorization.required',
  'meter.observed',
  'mode.changed',
  'model.changed',
  'model.rejected',
  'model.stream.restarted',
  'notice',
  'plan.updated',
  'skill.activated',
  'tool.elicitation.cancelled',
  'tool.elicitation.requested',
  'tool.elicitation.resolved',
  'tool.loaded',
  'tool.offered',
  'tool.permission.classified',
  'tool.updated',
  'usage.charged',
  'usage.updated',
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
  ])('%s is the transition table of the store', (name, table) => {
    expect(tableOf(name)).toEqual(codeTable(table));
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

  it('emits only event kinds it declares as modelled', () => {
    const modelled = new Set(setOf('ModelledEvents'));
    const emitted = [...spec.matchAll(/\bE\("([a-z.]+)"/g)].map((match) => match[1] as string);
    expect(emitted.filter((kind) => !modelled.has(kind))).toEqual([]);
  });
});

const configDir = path.resolve(import.meta.dirname, '..', 'specs', 'tla');

const constantsOf = (name: string): Record<string, string> => {
  const text = fs.readFileSync(path.join(configDir, `${name}.cfg`), 'utf8');
  const block = text.slice(text.indexOf('CONSTANTS'), text.search(/^(SYMMETRY|INVARIANTS|PROPERTIES)/m));
  return Object.fromEntries([...block.matchAll(/^\s+(\w+)\s*=\s*(.+)$/gm)].map((match) => [match[1] as string, (match[2] as string).trim()]));
};

const manifest = readManifest(path.join(configDir, 'manifest.json'));
const recoveryEntries = manifest.entries.filter((entry) => entry.config.split('.')[0] === 'RunRecovery');
const checkNames = recoveryEntries.filter((entry) => entry.role === 'check').map((entry) => entry.config);
const evidenceNames = recoveryEntries
  .filter((entry) => entry.role === 'evidence' && !entry.config.startsWith('RunRecovery.uniformCancel') && !entry.config.startsWith('RunRecovery.liveTimeout'))
  .map((entry) => entry.config);
const configText = (name: string): string => fs.readFileSync(path.join(configDir, `${name}.cfg`), 'utf8');
const hasInvariantSection = (name: string): boolean => /^INVARIANTS$/m.test(configText(name));
const lists = (name: string, invariant: string): boolean => new RegExp(`^\\s+${invariant}$`, 'm').test(configText(name));

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
      const text = fs.readFileSync(path.join(configDir, file), 'utf8');
      const listed = text.slice(text.search(/^(INVARIANTS|PROPERTIES)/m)).split('\n').map((line) => line.trim()).filter((line) => /^[A-Z][A-Za-z]+$/.test(line) && line !== 'INVARIANTS' && line !== 'PROPERTIES');
      const moduleText = fs.readFileSync(path.join(configDir, `${moduleOf(file.slice(0, -'.cfg'.length))}.tla`), 'utf8');
      for (const name of listed) expect(moduleText, `${file} names ${name}`).toMatch(new RegExp(`^${name} ==`, 'm'));
    }
  });

  describe('the reasoning about the call lock', () => {
    const proseBetween = (from: string, to: string): string => {
      const prose = spec.replace(/\(\*|\*\)/g, ' ').replace(/\s+/g, ' ');
      const start = prose.indexOf(from);
      const end = prose.indexOf(to, start);
      if (start === -1 || end === -1) throw new Error(`no prose between "${from}" and "${to}"`);
      return prose.slice(start, end);
    };

    it('argues exclusion from the mechanism the code selects on each platform', () => {
      const argument = proseBetween('Whether the older worker', 'The lock covers Write');
      expect(createKernelLockMechanism('linux').name).toBe('sqlite-lock');
      expect(createKernelLockMechanism('win32').name).toBe('sqlite-lock');
      expect(argument).toMatch(/sqlite/i);
      expect(argument).not.toMatch(/EADDRINUSE|abstract socket|named pipe/);
    });

    it('derives the wait for a held lock from the heartbeat, the settle limit and the kill grace, not from the reconcile cap', () => {
      const argument = proseBetween('The wait for a held lock', 'When the wait expires');
      expect(argument).toMatch(/heartbeat/);
      expect(argument).toMatch(/settle/);
      expect(argument).toMatch(/kill grace/);
      expect(argument).not.toMatch(/reconcile cap/);
      expect(argument).not.toMatch(/10 s of the default/);
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
