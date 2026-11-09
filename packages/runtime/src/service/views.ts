import { readAgentPin } from '@momonga/agents';
import type { AgentDefinition } from '@momonga/agents';
import { TERMINAL_STATUSES } from '@momonga/protocol';
import type { AgentView, JobView, RunStatus, SkillView, Stored } from '@momonga/protocol';
import type { Skill } from '@momonga/skills';
import type { Job, Run, RuntimeStore, Session } from '@momonga/store';

const agentNameOf = (run: Run): { agent?: string } => {
  const pin = readAgentPin(run.pins);
  return pin === undefined ? {} : { agent: pin.name };
};

export const isTerminalStatus = (status: Stored<RunStatus>): boolean => TERMINAL_STATUSES.some((terminal) => terminal === status);

export const toJobView = (job: Job): JobView => ({
  id: job.id,
  sessionId: job.sessionId,
  runId: job.runId,
  callId: job.callId,
  command: job.command,
  status: job.status,
  ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
  ...(job.signal === undefined ? {} : { signal: job.signal }),
  startedAt: job.startedAt,
  ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
});

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
  parentRunId: run.parentRunId,
  parentCallId: run.parentCallId,
  origin: run.origin,
  ...agentNameOf(run),
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
    lastEventId: store.sessionMaxEventId(session.id),
  };
};

export const toSkillView = (skill: Skill): SkillView => ({
  name: skill.name,
  description: skill.description,
  scope: skill.scope,
  location: skill.location,
});

export const toAgentView = (agent: AgentDefinition): AgentView => ({
  name: agent.name,
  description: agent.description,
  scope: agent.scope,
  location: agent.location,
});
