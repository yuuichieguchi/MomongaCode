import { measureContribution } from '@momonga/memory';
import type { InjectedItem, RenderedWorkingState } from '@momonga/memory';
import type { RunEvent, WorkingFacts } from '@momonga/protocol';
import type { TerminalContribution } from '@momonga/store';

const WORKING_STATE_ID = 'working-state';

type Lookup = Parameters<TerminalContribution['measure']>[0];

type Shown = { kind: 'written' | 'command'; text: string; factSeq: number };

type WorkingStateTrace = { items: InjectedItem[]; rendered: RenderedWorkingState[] };

const shownFactsOf = (facts: WorkingFacts): Map<string, Shown> =>
  new Map<string, Shown>([
    ...facts.written.map((fact): [string, Shown] => [`written\n${fact.path}\n${fact.seq}`, { kind: 'written', text: fact.path, factSeq: fact.seq }]),
    ...facts.commands.map((fact): [string, Shown] => [`command\n${fact.command}\n${fact.seq}`, { kind: 'command', text: fact.command, factSeq: fact.seq }]),
  ]);

const renderedTextOf = (facts: WorkingFacts): string => [...facts.written.map((fact) => fact.path), ...facts.commands.map((fact) => fact.command)].join('\n');

const workingStateTrace = (firstCompactionSeq: number, replay: Lookup['replay']): WorkingStateTrace => {
  const items: InjectedItem[] = [{ kind: 'working_state', id: WORKING_STATE_ID, text: '', fromSeq: firstCompactionSeq }];
  const rendered: RenderedWorkingState[] = [];
  const open = new Map<string, Shown>();
  let seen: Pick<WorkingFacts, 'written' | 'commands'> | undefined;
  const close = (shown: Shown, untilSeq: number | undefined): void => {
    const fromSeq = Math.max(firstCompactionSeq, shown.factSeq);
    if (untilSeq !== undefined && untilSeq <= fromSeq) return;
    items.push({ kind: 'working_state', id: WORKING_STATE_ID, text: shown.text, fromSeq, ...(untilSeq === undefined ? {} : { untilSeq }) });
  };
  replay((state, event) => {
    const { workingFacts } = state;
    if (seen === undefined || seen.written !== workingFacts.written || seen.commands !== workingFacts.commands) {
      seen = { written: workingFacts.written, commands: workingFacts.commands };
      const current = shownFactsOf(workingFacts);
      for (const [key, shown] of open) {
        if (current.has(key)) continue;
        open.delete(key);
        close(shown, event.seq);
      }
      for (const [key, shown] of current) if (!open.has(key)) open.set(key, shown);
    }
    if (event.type === 'context.compacted') rendered.push({ seq: event.seq, text: renderedTextOf(workingFacts) });
  });
  for (const shown of open.values()) close(shown, undefined);
  return { items, rendered };
};

const injectedOf = (events: readonly RunEvent[], lookup: Lookup): WorkingStateTrace => {
  const known = new Set<string>();
  const injected: InjectedItem[] = [];
  const add = (item: InjectedItem): void => {
    const key = `${item.kind}\n${item.id}`;
    if (known.has(key)) return;
    known.add(key);
    injected.push(item);
  };
  for (const event of events) {
    if (event.type === 'context.memories_loaded') {
      for (const { id } of event.memories) {
        const memory = lookup.memories.get(id);
        if (memory !== undefined) add({ kind: 'memory', id, text: memory.text, fromSeq: event.seq });
      }
    } else if (event.type === 'tool.completed') {
      for (const id of event.memories ?? []) {
        const memory = lookup.memories.get(id);
        if (memory !== undefined) add({ kind: 'memory', id, text: memory.text, fromSeq: event.seq });
      }
    } else if (event.type === 'context.governing_loaded') {
      for (const { id } of event.active) {
        const fact = lookup.governing.get(id);
        if (fact !== undefined) add({ kind: 'governing', id, text: fact.text, fromSeq: event.seq });
      }
    } else if (event.type === 'context.compacted') {
      add({ kind: 'summary', id: `summary-${event.seq}`, text: event.summary, fromSeq: event.seq });
    }
  }
  const firstCompaction = events.find((event) => event.type === 'context.compacted');
  if (firstCompaction === undefined) return { items: injected, rendered: [] };
  const workingState = workingStateTrace(firstCompaction.seq, lookup.replay);
  return { items: [...injected, ...workingState.items], rendered: workingState.rendered };
};

export const contributionAtTerminal: TerminalContribution = {
  eventTypes: [
    'user.message',
    'model.responded',
    'tool.completed',
    'tool.reconciled',
    'context.compacted',
    'context.inherited',
    'context.memories_loaded',
    'context.governing_loaded',
    'model.requested',
  ],
  measure: (input) => {
    const { items, rendered } = injectedOf(input.events, input);
    if (items.length === 0) return undefined;
    const task = input.events.find((event) => event.type === 'user.message');
    if (task?.type !== 'user.message') throw new Error(`run ${input.run.id} injected context but has no user.message`);
    return {
      type: 'context.contribution',
      items: measureContribution({ events: input.events, task: task.text, injected: items, workingStates: rendered, ...(input.unit === undefined ? {} : { unit: input.unit }) }),
    };
  },
};
