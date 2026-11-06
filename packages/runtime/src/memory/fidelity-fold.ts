import { textOfItem } from '@momonga/context';
import { isRecord } from '@momonga/foundation';
import { createCallRunTracker } from '@momonga/memory';
import { tokenMatcherOf } from '@momonga/protocol';
import type { ClaimedToken, FidelityClaim, RunEvent } from '@momonga/protocol';

export const FIDELITY_EVENT_TYPES = [
  'tool.call',
  'tool.started',
  'tool.completed',
  'tool.reconciled',
  'user.message',
  'plan.updated',
  'instructions.loaded',
  'context.inherited',
] as const satisfies readonly RunEvent['type'][];

export type FidelityFold = {
  add(event: RunEvent): void;
  finish(): void;
  readonly handles: ReadonlySet<string>;
  readonly unresolved: number;
  readonly span: number;
  scan(text: string, complete: boolean): void;
  attested(): string[];
};

type Source = 'executed' | 'stated';

const stringLeavesOf = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeavesOf);
  if (isRecord(value)) return Object.values(value).flatMap(stringLeavesOf);
  return [];
};

const claimsSatisfiedBy = (source: Source, claim: FidelityClaim): boolean => source === 'executed' || claim === 'any';

export const createFidelityFold = (tokens: readonly ClaimedToken[], cwd: string): FidelityFold => {
  const entries = tokens.map((entry) => ({ ...entry, matcher: tokenMatcherOf(entry.token, cwd), found: false }));
  const handles = new Set<string>();
  const calls = new Map<string, string[]>();
  const ran = createCallRunTracker();
  let unresolved = entries.length;

  const offer = (text: string, source: Source, complete: boolean): void => {
    if (unresolved === 0) return;
    for (const entry of entries) {
      if (entry.found || !claimsSatisfiedBy(source, entry.claim)) continue;
      if (!entry.matcher.matches(text, complete)) continue;
      entry.found = true;
      unresolved -= 1;
    }
  };

  const executed = (text: string): void => offer(text, 'executed', true);
  const stated = (text: string): void => offer(text, 'stated', true);

  const add = (event: RunEvent): void => {
    ran.observe(event);
    switch (event.type) {
      case 'tool.call':
        calls.set(event.callId, stringLeavesOf(event.rawInput));
        return;
      case 'tool.completed': {
        const leaves = calls.get(event.callId);
        calls.delete(event.callId);
        if (event.denial !== undefined) return;
        if (ran.ran(event)) for (const leaf of leaves ?? []) executed(leaf);
        executed(event.output);
        for (const file of event.files ?? []) executed(file.path);
        if (event.handle !== undefined) handles.add(event.handle);
        return;
      }
      case 'tool.reconciled':
        executed(event.output);
        return;
      case 'user.message':
        stated(event.text);
        return;
      case 'plan.updated':
        for (const entry of event.entries) stated(entry.content);
        return;
      case 'instructions.loaded':
        executed(event.content);
        return;
      case 'context.inherited':
        for (const entry of event.history) {
          if (entry.handle !== undefined) handles.add(entry.handle);
          if (entry.item.type === 'message') {
            if (entry.item.role === 'user') stated(textOfItem(entry.item));
          } else if (entry.item.type === 'function_call' || entry.item.type === 'function_call_output') {
            executed(textOfItem(entry.item));
          }
        }
        return;
      default:
        return;
    }
  };

  const finish = (): void => {
    for (const [callId, leaves] of calls) {
      if (ran.started(callId)) for (const leaf of leaves) executed(leaf);
    }
    calls.clear();
  };

  return {
    add,
    finish,
    handles,
    get unresolved() {
      return unresolved;
    },
    get span() {
      return Math.max(0, ...entries.filter((entry) => !entry.found).map((entry) => entry.matcher.span));
    },
    scan: (text, complete) => offer(text, 'executed', complete),
    attested: () => entries.filter((entry) => entry.found).map((entry) => entry.token),
  };
};
