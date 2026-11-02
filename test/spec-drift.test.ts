import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKernelLockMechanism } from '@momonga/foundation';
import { EVENT_TYPES, RUN_STATUSES, TERMINAL_STATUSES } from '@momonga/protocol';
import { CLAIM_STATUSES, DEAD_LETTER_TRANSITIONS, SERVICE_TRANSITIONS, SWEEP_TRANSITIONS, WORKER_TRANSITIONS } from '@momonga/store';

const specPath = path.resolve(import.meta.dirname, '..', 'specs', 'tla', 'RunRecovery.tla');
const spec = fs.readFileSync(specPath, 'utf8');

const definitionOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name} ==`, 'm'));
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
  'context.inherited',
  'context.truncated',
  'hook.completed',
  'instructions.loaded',
  'job.finished',
  'mcp.authorization.required',
  'mode.changed',
  'model.stream.restarted',
  'notice',
  'plan.updated',
  'skill.activated',
  'tool.elicitation.cancelled',
  'tool.elicitation.requested',
  'tool.elicitation.resolved',
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

describe('the checked configurations against the repaired recovery design', () => {
  const repairs = (name: string): [string, string, string] => {
    const constants = constantsOf(name);
    return [constants['UnfencedEffect'] as string, constants['NoCallLock'] as string, constants['NoReapBeforeReconcile'] as string];
  };

  it('checks the code with all three repairs in every configuration that is not evidence', () => {
    for (const name of ['RunRecovery', 'RunRecovery.children', 'RunRecovery.liveNone', 'RunRecovery.liveSpawn']) {
      expect(repairs(name)).toEqual(['FALSE', 'FALSE', 'FALSE']);
    }
  });

  it('keeps one configuration per missing repair, the ones with a single repair, and one with none as evidence', () => {
    expect(repairs('RunRecovery.unlocked')).toEqual(['FALSE', 'TRUE', 'FALSE']);
    expect(repairs('RunRecovery.noReap')).toEqual(['FALSE', 'FALSE', 'TRUE']);
    expect(repairs('RunRecovery.lockOnly')).toEqual(['FALSE', 'FALSE', 'TRUE']);
    expect(repairs('RunRecovery.fenceOnly')).toEqual(['FALSE', 'TRUE', 'TRUE']);
    expect(repairs('RunRecovery.reapOnly')).toEqual(['TRUE', 'TRUE', 'FALSE']);
    expect(repairs('RunRecovery.unfixed')).toEqual(['TRUE', 'TRUE', 'TRUE']);
  });

  it('checks the reconcile and lock invariants in the configurations that check the code', () => {
    for (const name of ['RunRecovery', 'RunRecovery.children']) {
      const text = fs.readFileSync(path.join(configDir, `${name}.cfg`), 'utf8');
      for (const invariant of ['AtMostOnceEffect', 'ReconcileSeesStoppedEffect', 'NoEffectDuringReconcile', 'LockIsExclusive']) {
        expect(text).toMatch(new RegExp(`^\\s+${invariant}$`, 'm'));
      }
    }
  });

  it('names only invariants and properties that the spec defines', () => {
    const configs = fs.readdirSync(configDir).filter((file) => file.endsWith('.cfg'));
    expect(configs.length).toBeGreaterThan(0);
    for (const file of configs) {
      const text = fs.readFileSync(path.join(configDir, file), 'utf8');
      const listed = text.slice(text.search(/^(INVARIANTS|PROPERTIES)/m)).split('\n').map((line) => line.trim()).filter((line) => /^[A-Z][A-Za-z]+$/.test(line) && line !== 'INVARIANTS' && line !== 'PROPERTIES');
      for (const name of listed) expect(spec, `${file} names ${name}`).toMatch(new RegExp(`^${name} ==`, 'm'));
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
    for (const name of ['RunRecovery', 'RunRecovery.children']) {
      expect(constantsOf(name)['StatusEdgesRecorded']).toBe('TRUE');
    }
  });
});
