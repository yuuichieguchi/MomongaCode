import { resolveSandbox } from './sandbox.ts';

export type E2eCaseFile =
  | 'b1-model-call.test.ts'
  | 'b2-bash.test.ts'
  | 'b3-gateway-kill.test.ts'
  | 'c-cancel.test.ts'
  | 'mcp-orphan.test.ts'
  | 'supervisor.test.ts'
  | 'logs.test.ts';

export const E2E_CASES = [
  { id: 'b1-join', file: 'b1-model-call.test.ts', title: 'b1 join: restarted runtime joins the in-flight upstream call', needsBash: false },
  { id: 'b1-replay', file: 'b1-model-call.test.ts', title: 'b1 replay: the response arrived while the runtime was down', needsBash: false },
  { id: 'b2-seatbelt', file: 'b2-bash.test.ts', title: 'b2 seatbelt is applied: a write outside the project is denied', needsBash: true },
  { id: 'b2-recovery', file: 'b2-bash.test.ts', title: 'b2: recovery reaps the process, records unknown, and runs the side effect once', needsBash: true },
  { id: 'b3-gateway-kill', file: 'b3-gateway-kill.test.ts', title: 'b3: a gateway killed mid-call is restarted and the run completes', needsBash: false },
  { id: 'c1', file: 'c-cancel.test.ts', title: 'c1: cancel during sleep 30', needsBash: true },
  { id: 'c1b', file: 'c-cancel.test.ts', title: 'c1b: cancel when the command ignores SIGTERM', needsBash: true },
  { id: 'c2', file: 'c-cancel.test.ts', title: 'c2: cancel mid-stream cuts the upstream connection', needsBash: false },
  { id: 'c3', file: 'c-cancel.test.ts', title: 'c3: cancel of a queued run', needsBash: false },
  { id: 'mcp-orphan', file: 'mcp-orphan.test.ts', title: 'mcp: a live MCP server tree is gone after the runtime is killed and restarted', needsBash: true },
  { id: 's1', file: 'supervisor.test.ts', title: 'S1 supervisor SIGKILL: children close themselves, observably', needsBash: false },
  { id: 's1b', file: 'supervisor.test.ts', title: 'S1b wedged orphan is reaped by the next supervisor, observably', needsBash: false },
  { id: 's1c-phase1', file: 'supervisor.test.ts', title: 'S1c shutdown during the reap is bounded and spawns nothing', needsBash: false },
  { id: 's1c-phase2', file: 'supervisor.test.ts', title: 'S1c shutdown during phase 2 of the reap aborts the reap', needsBash: false },
  { id: 's2', file: 'supervisor.test.ts', title: 'S2 sandbox change restarts only the runtime', needsBash: true },
  { id: 's3', file: 'supervisor.test.ts', title: 'S3 models change restarts the gateway and the runtime', needsBash: false },
  { id: 's4', file: 'supervisor.test.ts', title: 'S4 irrelevant change restarts nothing', needsBash: false },
  { id: 's5', file: 'supervisor.test.ts', title: 'S5 exit 78 holds, a settings fix starts', needsBash: false },
  { id: 's5b', file: 'supervisor.test.ts', title: 'S5b held-config recovers from an environmental cause', needsBash: true },
  { id: 's6', file: 'supervisor.test.ts', title: 'S6 invalid settings at start: nothing is spawned', needsBash: false },
  { id: 's7', file: 'supervisor.test.ts', title: 'S7 exit 75 is not a loop', needsBash: false },
  { id: 's8', file: 'supervisor.test.ts', title: 'S8 ghost lock is taken over', needsBash: false },
  { id: 's9', file: 'supervisor.test.ts', title: 'S9 graceful shutdown order', needsBash: false },
  { id: 's10', file: 'supervisor.test.ts', title: 'S10 two supervisors', needsBash: false },
  { id: 'logs-layout', file: 'logs.test.ts', title: 'logs layout', needsBash: false },
  { id: 'logs-raw-output', file: 'logs.test.ts', title: 'raw child output goes to supervisor.log only', needsBash: false },
] as const satisfies readonly { id: string; file: E2eCaseFile; title: string; needsBash: boolean }[];

export type E2eCase = (typeof E2E_CASES)[number];

export type E2eCaseId = E2eCase['id'];

export const caseOf = (id: E2eCaseId): E2eCase => {
  const entry = E2E_CASES.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`unknown e2e case ${id}`);
  return entry;
};

export const titleOf = (id: E2eCaseId): string => caseOf(id).title;

export const skipCase = (id: E2eCaseId): boolean => resolveSandbox({ needsBash: caseOf(id).needsBash }).kind === 'skip';
