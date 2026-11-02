import { TERMINAL_STATUSES } from '@momonga/protocol';
import type { RunStatus, SkillView } from '@momonga/protocol';
import type { Skill } from '@momonga/skills';
import type { Run, RuntimeStore, Session } from '@momonga/store';

export const isTerminalStatus = (status: RunStatus): boolean => (TERMINAL_STATUSES as readonly RunStatus[]).includes(status);

export const toRunView = (run: Run) => ({
  id: run.id,
  sessionId: run.sessionId,
  ordinal: run.ordinal,
  status: run.status,
  ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
  ...(run.error === undefined ? {} : { error: run.error }),
  usage: run.usage,
  step: run.step,
  limits: run.limits,
  createdAt: run.createdAt,
  deadlineAt: run.deadlineAt,
  cancelRequested: run.cancelRequested,
  lastSeq: run.lastSeq,
  previousRunId: run.previousRunId,
  history: run.history,
});

export const toSessionView = (store: RuntimeStore, session: Session) => {
  const runs = store.listRuns(session.id);
  return {
    id: session.id,
    cwd: session.cwd,
    permissionMode: session.permissionMode,
    modelAlias: session.modelAlias,
    bypassAllowed: session.bypassAllowed,
    createdAt: session.createdAt,
    envKeys: Object.keys(session.env),
    additionalDirectories: [...session.additionalDirectories],
    activeRunId: runs.find((run) => !isTerminalStatus(run.status))?.id ?? null,
    latestRunId: runs.at(-1)?.id ?? null,
  };
};

export const toSkillView = (skill: Skill): SkillView => ({
  name: skill.name,
  description: skill.description,
  scope: skill.scope,
  location: skill.location,
});
