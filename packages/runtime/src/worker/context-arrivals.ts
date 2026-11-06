import type { ContextArrival } from '@momonga/context';
import type { RunState } from '@momonga/protocol';

type Positioned = { seq: number; arrival: ContextArrival };

export const arrivalsOf = (state: RunState): ContextArrival[] => {
  const instructions = state.loadedInstructions.map((entry): Positioned => ({ seq: entry.seq, arrival: { kind: 'instructions', path: entry.path, content: entry.content } }));
  const skills: Positioned[] = state.activatedSkills.map((skill) => ({ seq: skill.seq, arrival: { kind: 'skill', name: skill.name, content: skill.content } }));
  return [...instructions, ...skills].toSorted((left, right) => left.seq - right.seq).map((entry) => entry.arrival);
};
