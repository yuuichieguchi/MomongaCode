import type { ContextArrival } from '@momonga/context';
import type { RunState } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';

type Positioned = { seq: number; arrival: ContextArrival };

export const arrivalsOf = (store: Pick<RuntimeStore, 'readRunEventsOfTypes'>, runId: string, state: RunState): ContextArrival[] => {
  const instructions = new Map<string, Positioned>();
  for (const event of store.readRunEventsOfTypes(runId, ['instructions.loaded'])) {
    if (event.type !== 'instructions.loaded') continue;
    const first = instructions.get(event.path);
    instructions.set(event.path, { seq: first?.seq ?? event.seq, arrival: { kind: 'instructions', path: event.path, content: event.content } });
  }
  const skills: Positioned[] = state.activatedSkills.map((skill) => ({ seq: skill.seq, arrival: { kind: 'skill', name: skill.name, content: skill.content } }));
  return [...instructions.values(), ...skills].toSorted((left, right) => left.seq - right.seq).map((entry) => entry.arrival);
};
