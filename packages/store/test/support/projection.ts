import { inheritedWorkingFacts } from '@momonga/protocol';
import type { RunState } from '@momonga/protocol';
import { copyDigestOf, projectionOf } from '../../src/inherit.ts';
import type { InheritanceKind, InheritanceOutcome, InheritedPayload } from '../../src/inherit.ts';

export const projectInheritance = (previous: RunState, outcome: InheritanceOutcome, kind: InheritanceKind): InheritedPayload => {
  const { history, retracted, closures, markers, partial, nextItemSeq, mode, activatedSkills } = projectionOf(previous, outcome, kind, 'whole');
  const unsigned: Omit<InheritedPayload, 'digest'> = {
    type: 'context.inherited',
    fromRunId: previous.runId,
    fromLastSeq: previous.lastSeq,
    history,
    nextItemSeq,
    ...(previous.summary === undefined ? {} : { summary: previous.summary }),
    workingFacts: inheritedWorkingFacts(previous.workingFacts, !retracted),
    evicted: [...previous.evicted],
    closures,
    ...(partial === undefined ? {} : { partial }),
    markers,
    ...(previous.mode === undefined ? {} : { fromMode: previous.mode }),
    ...(mode === undefined ? {} : { mode }),
    ...(activatedSkills === undefined ? {} : { activatedSkills }),
  };
  return { ...unsigned, digest: copyDigestOf(unsigned) };
};
