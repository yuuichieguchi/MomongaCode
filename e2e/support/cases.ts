import { resolveSandbox } from './sandbox.ts';

export type E2eCaseFile =
  | 'b1-model-call.test.ts'
  | 'b2-bash.test.ts'
  | 'b3-gateway-kill.test.ts'
  | 'c-cancel.test.ts'
  | 'mcp-orphan.test.ts'
  | 'multi-turn.test.ts'
  | 'supervisor.test.ts'
  | 'logs.test.ts'
  | 'd-approvals.test.ts'
  | 'e-sse-reconnect.test.ts'
  | 'a-compaction.test.ts'
  | 'cli.test.ts'
  | 'cli-pty.test.ts';

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
  { id: 'mt1', file: 'multi-turn.test.ts', title: 'mt1: two sequential runs share the conversation', needsBash: false },
  { id: 'mt1b', file: 'multi-turn.test.ts', title: 'mt1b: the same upstream call id in two runs reaches the model as two different ids', needsBash: false },
  { id: 'mt2-join', file: 'multi-turn.test.ts', title: 'mt2 join: runtime killed during the first model call of an inheriting run', needsBash: false },
  { id: 'mt2-replay', file: 'multi-turn.test.ts', title: 'mt2 replay: the inheriting run response arrived while the runtime was down', needsBash: false },
  { id: 'mt3', file: 'multi-turn.test.ts', title: 'mt3: a cancelled predecessor with partial text is inherited with a merged marker', needsBash: false },
  { id: 'mt4', file: 'multi-turn.test.ts', title: 'mt4: history fresh starts a new conversation that later runs inherit', needsBash: false },
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
  { id: 'd-reject-once', file: 'd-approvals.test.ts', title: 'd: reject_once returns the rejection to the model; an unoffered option is 400 and a second resolve is 409', needsBash: false },
  { id: 'd-allow-always', file: 'd-approvals.test.ts', title: 'd: allow_always persists an allow rule and the next run in the project is not prompted', needsBash: false },
  { id: 'd-reject-always', file: 'd-approvals.test.ts', title: 'd: reject_always persists a deny rule and the next run in the project is denied without a prompt', needsBash: false },
  { id: 'e-replay', file: 'e-sse-reconnect.test.ts', title: 'e: Last-Event-ID k replays k+1 to the end once, after=k matches, a cursor past the end is 400, a late attach replays all', needsBash: false },
  { id: 'e-resume', file: 'e-sse-reconnect.test.ts', title: 'e: a stream dropped mid-run and resumed with Last-Event-ID has no gap and no duplicate', needsBash: false },
  { id: 'a-compaction', file: 'a-compaction.test.ts', title: 'a: one long turn truncates a tool output, evicts it and compacts within the turn (full tools, native)', needsBash: false },
  { id: 'a-compaction-lean', file: 'a-compaction.test.ts', title: 'a: lean tool set, the gain rule decides the first compaction at the default protection level (native)', needsBash: false },
  { id: 'a-compaction-constrained', file: 'a-compaction.test.ts', title: 'a: constrained tool calling counts the duplicated schemas and compacts within the turn', needsBash: false },
  { id: 'a-constrained-pinned-overflow', file: 'a-compaction.test.ts', title: 'a: constrained tool calling with every tool fails pinned_overflow before any upstream request', needsBash: false },
  { id: 'cli-print', file: 'cli.test.ts', title: 'cli: momonga -p completes a Glob, Read and Edit task through an autostarted daemon and the file changes', needsBash: false },
  { id: 'cli-formats', file: 'cli.test.ts', title: 'cli: --output-format json prints one result object and stream-json prints init, every run event and the result', needsBash: false },
  { id: 'cli-approve', file: 'cli.test.ts', title: 'cli: a -p run in default mode waits for approval, momonga approve lists and resolves it, and the edit lands', needsBash: false },
  { id: 'cli-cancel', file: 'cli.test.ts', title: 'cli: momonga cancel ends a running -p run as CANCELLED', needsBash: false },
  { id: 'cli-attach', file: 'cli.test.ts', title: 'cli: attach replays a finished run, --after skips what was seen, and trace summarises it', needsBash: false },
  { id: 'cli-daemon', file: 'cli.test.ts', title: 'cli: daemon status and stop, and the next command autostarts a single daemon again', needsBash: false },
  { id: 'cli-version-restart', file: 'cli.test.ts', title: 'cli: a daemon of another version is drained and replaced before the run', needsBash: false },
  { id: 'cli-reconnect', file: 'cli.test.ts', title: 'cli: a runtime killed mid-run drops the event stream and the CLI resumes it with Last-Event-ID without a gap or a duplicate', needsBash: false },
  { id: 'cli-env', file: 'cli.test.ts', title: 'cli: the environment snapshot sent at session creation carries no credentials', needsBash: false },
  { id: 'cli-probe', file: 'cli.test.ts', title: 'cli: gateway probe fm records the measurement and reports the remedy when fm is unavailable', needsBash: false },
  { id: 'cli-race', file: 'cli.test.ts', title: 'cli: two commands started together share one daemon', needsBash: false },
  { id: 'cli-interrupt', file: 'cli.test.ts', title: 'cli: ctrl+c during -p cancels the run and exits 130', needsBash: false },
  { id: 'cli-pty-exit-running', file: 'cli-pty.test.ts', title: 'cli pty: /exit while a task runs leaves the terminal at once and the task continues in the daemon', needsBash: false },
  { id: 'cli-pty-approval', file: 'cli-pty.test.ts', title: 'cli pty: first-run trust prompt, Edit approval with a diff, mode cycling and a clean exit through a real pty', needsBash: false },
  { id: 'cli-pty-session', file: 'cli-pty.test.ts', title: 'cli pty: slash commands, multi-line input, esc cancels a running task, history recall and /exit through a real pty', needsBash: false },
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
