import type { ContextArrival } from '@momonga/context';
import type { RunState } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';

type Positioned = { seq: number; arrival: ContextArrival };

export const arrivalsOf = (store: Pick<RuntimeStore, 'readRunEventsOfTypes'>, runId: string, state: RunState): ContextArrival[] => {
  const latestContent = new Map<string, string>();
  if (state.loadedInstructions.length > 0) {
    for (const event of store.readRunEventsOfTypes(runId, ['instructions.loaded'])) {
      if (event.type === 'instructions.loaded') latestContent.set(event.path, event.content);
    }
  }
  const instructions = state.loadedInstructions.map((entry): Positioned => {
    const content = latestContent.get(entry.path);
    if (content === undefined) throw new Error(`run ${runId} folded the instruction file ${entry.path} that its journal does not hold`);
    return { seq: entry.seq, arrival: { kind: 'instructions', path: entry.path, content } };
  });
  const skills: Positioned[] = state.activatedSkills.map((skill) => ({ seq: skill.seq, arrival: { kind: 'skill', name: skill.name, content: skill.content } }));
  return [...instructions, ...skills].toSorted((left, right) => left.seq - right.seq).map((entry) => entry.arrival);
};
