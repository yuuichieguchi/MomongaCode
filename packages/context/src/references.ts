import type { ReferenceKind, RunState } from '@momonga/protocol';
import { retainedHistoryOf } from './levels.ts';
import type { BuildContextInput } from './types.ts';

type OutputCarrier = { readonly handle?: string; readonly item: { readonly type: string } };

const carriesOutput = (entries: readonly OutputCarrier[]): boolean => entries.some((entry) => entry.handle !== undefined || entry.item.type === 'function_call_output');

const kindsOf = (holdsHandles: boolean, holdsRange: boolean): ReadonlySet<ReferenceKind> =>
  new Set<ReferenceKind>([...(holdsHandles ? (['output_handle'] as const) : []), ...(holdsRange ? (['history_range'] as const) : [])]);

export const referenceKindsOf = (subject: RunState | BuildContextInput): ReadonlySet<ReferenceKind> => {
  if ('sources' in subject) {
    const { sources, evicted } = subject;
    return kindsOf(evicted.size > 0 || carriesOutput(retainedHistoryOf(sources.history, sources.summary)), sources.summary !== undefined);
  }
  return kindsOf(subject.evicted.length > 0 || carriesOutput(subject.history), subject.summary !== undefined);
};

export const readersOffered = (declared: Readonly<Record<string, string>>, offered: readonly { readonly name: string }[]): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(declared).filter(([, name]) => offered.some((tool) => tool.name === name)));

export const readerNamesOf = (readers: Readonly<Record<string, string>>, subject: RunState | BuildContextInput): string[] =>
  [...referenceKindsOf(subject)].flatMap((kind) => readers[kind] ?? []);
