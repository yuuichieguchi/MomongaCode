import { measureContribution } from '@momonga/memory';
import type { InjectedItem } from '@momonga/memory';
import type { RunEvent } from '@momonga/protocol';
import type { TerminalContribution } from '@momonga/store';

const WORKING_STATE_ID = 'working-state';

const injectedOf =(events: readonly RunEvent[], lookup: Parameters<TerminalContribution['measure']>[0]): InjectedItem[] => {
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
  if (firstCompaction !== undefined) {
    const { written, commands } = lookup.state().workingFacts;
    add({ kind: 'working_state', id: WORKING_STATE_ID, text: [...written.map((fact) => fact.path), ...commands.map((fact) => fact.command)].join('\n'), fromSeq: firstCompaction.seq });
  }
  return injected;
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
  ],
  measure: (input) => {
    const injected = injectedOf(input.events, input);
    if (injected.length === 0) return undefined;
    const task = input.events.find((event) => event.type === 'user.message');
    if (task?.type !== 'user.message') throw new Error(`run ${input.run.id} injected context but has no user.message`);
    return { type: 'context.contribution', items: measureContribution({ events: input.events, task: task.text, injected }) };
  },
};
