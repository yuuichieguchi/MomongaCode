import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
