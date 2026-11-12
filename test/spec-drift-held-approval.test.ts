import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, HELD_OUTCOMES, completionMutates, heldEndOf, reconciliationMutates } from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';
import { ITEM_EVENT_TYPES, itemCountOf } from '@momonga/store';
import { cfgNames } from './formal/cfg-names.ts';
import { readManifest } from './formal/manifest.ts';

const tlaDir = path.resolve(import.meta.dirname, '..', 'specs', 'tla');
const held = fs.readFileSync(path.join(tlaDir, 'HeldApproval.tla'), 'utf8');
const gate = fs.readFileSync(path.join(tlaDir, 'CompletionGate.tla'), 'utf8');
const manifest = readManifest(path.join(tlaDir, 'manifest.json'));

const definitionIn = (spec: string, name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined`);
  const end = spec.indexOf('\n\n', start);
  return spec.slice(start, end === -1 ? undefined : end);
};

const stringsIn = (text: string): string[] => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);

const setOf = (spec: string, name: string): string[] => [...new Set(stringsIn(definitionIn(spec, name)))].sort();

const modelEventKinds = (): string[] => [...new Set([...held.matchAll(/Ev\("([a-z_.]+)"/g)].map((match) => match[1] as string))].sort();

const link = { approvalId: 'approval-1' };

const sampleOf = (kind: string, outcome: string, linked: boolean): RunEventPayload => {
  const heldLink = linked ? { held: link } : {};
  switch (kind) {
    case 'user.message':
      return { type: 'user.message', text: 'go' };
    case 'model.responded':
      return { type: 'model.responded', step: 1, attempt: 1, response: { output: [{ type: 'function_call', call_id: 'p1', name: 'Write', arguments: '{}' }] } } as RunEventPayload;
    case 'tool.held':
      return { type: 'tool.held', callId: 'c1', approvalId: link.approvalId, reason: 'mandate', footprint: { reads: [], writes: [] } };
    case 'tool.started':
      return { type: 'tool.started', callId: 'c1', idemKey: 'k1' };
    case 'tool.completed':
      return { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'ok', ...heldLink } as RunEventPayload;
    case 'tool.reconciled':
      return { type: 'tool.reconciled', callId: 'c1', outcome: outcome as 'unknown', output: 'ok', ...heldLink } as RunEventPayload;
    case 'tool.held.resolved':
      return { type: 'tool.held.resolved', callId: 'c1', approvalId: link.approvalId, outcome: outcome as 'rejected', status: 'failed', output: 'no' };
    default:
      throw new Error(`the model writes an event the test cannot build: ${kind}`);
  }
};

describe('HeldApproval.tla against the tables of the code, in both directions', () => {
  it('writes only event types of the protocol, and models the unknown-effect ask as a separate step', () => {
    const kinds = modelEventKinds().filter((kind) => kind !== 'unknown_effect.asked');
    for (const kind of kinds) expect(EVENT_TYPES as readonly string[], kind).toContain(kind);
  });

  it('names exactly the one list of item-producing events that the fold and the reader of inherited history share', () => {
    expect(setOf(held, 'ItemEvents')).toEqual([...ITEM_EVENT_TYPES].sort());
  });

  it('produces one item for each item event the model writes and none for the others, through the producers of the store', () => {
    const items = setOf(held, 'ItemEvents');
    for (const kind of modelEventKinds().filter((name) => name !== 'unknown_effect.asked')) {
      expect(itemCountOf(sampleOf(kind, 'unknown', true)), kind).toBe(items.includes(kind) ? 1 : 0);
    }
  });

  it('ends a hold on exactly the events heldEndOf accepts: a linked completion or reconcile, or a closing resolution', () => {
    const ending = setOf(held, 'HoldEndingEvents');
    for (const kind of modelEventKinds().filter((name) => name !== 'unknown_effect.asked')) {
      expect(heldEndOf(sampleOf(kind, 'rejected', true)) !== undefined, kind).toBe(ending.includes(kind));
    }
    expect(heldEndOf(sampleOf('tool.completed', 'executed', false))).toBeUndefined();
  });

  it('names exactly the held outcomes and the reconcile outcomes of the protocol', () => {
    expect(setOf(held, 'HeldOutcomes')).toEqual([...HELD_OUTCOMES].sort());
    expect(setOf(held, 'ReconciledOutcomes')).toEqual(['already_applied', 'not_applied', 'unknown']);
  });

  it('counts a late mutation as the fold does, with the same outcomes the completion gate counts', () => {
    const write = { sideEffect: 'write' as const, rejected: false };
    const mutating = setOf(held, 'MutatingReconciled');
    expect(mutating).toEqual(setOf(gate, 'MutatingReconciled'));
    for (const outcome of ['already_applied', 'not_applied', 'unknown'] as const) expect(reconciliationMutates(write, outcome), outcome).toBe(mutating.includes(outcome));
    expect(completionMutates(write, {})).toBe(true);
  });

  it('lists one holding row, the deep row and one evidence row per dropped fact, each switch on only in its evidence', () => {
    const rows = manifest.entries.filter((entry) => entry.config.split('.')[0] === 'HeldApproval');
    expect(rows.map((entry) => [entry.config, entry.expect]).sort()).toEqual(
      [
        ['HeldApproval', 'holds'],
        ['HeldApproval.deep', 'holds'],
        ['HeldApproval.lateFactsDropped', { violates: 'LateMutationCounted', exitCode: 12 }],
        ['HeldApproval.lateNoItem', { violates: 'HistoryReadsAgree', exitCode: 12 }],
      ].sort(),
    );
    for (const row of rows) {
      const { constants } = cfgNames(tlaDir, row.config);
      expect(constants['LateFactsDropped'] === 'TRUE', row.config).toBe(row.config.endsWith('.lateFactsDropped'));
      expect(constants['LateNoItem'] === 'TRUE', row.config).toBe(row.config.endsWith('.lateNoItem'));
    }
  });
});
