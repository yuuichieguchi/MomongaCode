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
  | 'skills.test.ts'
  | 'eval-runner.test.ts'
  | 'eval-context.test.ts'
  | 'eval-context-kill.test.ts'
  | 'context-improve.test.ts'
  | 'otlp-export.test.ts'
  | 'open-responses-compliance.test.ts'
  | 'providers.test.ts'
  | 'mcp-remote.test.ts'
  | 'cli.test.ts'
  | 'cli-pty.test.ts'
  | 'product-cli.test.ts'
  | 'product-pty.test.ts'
  | 'memory.test.ts'
  | 'learning-loop.test.ts'
  | 'mcp-complete.test.ts'
  | 'agents.test.ts'
  | 'acp.test.ts'
  | 'hooks-auto.test.ts'
  | 'hooks-auto-cli.test.ts'
  | 'token-anatomy.test.ts'
  | 'roles.test.ts';

export const E2E_CASES = [
  { id: 'b1-join', file: 'b1-model-call.test.ts', title: 'b1 join: restarted runtime joins the in-flight upstream call', needsBash: false },
  { id: 'b1-replay', file: 'b1-model-call.test.ts', title: 'b1 replay: the response arrived while the runtime was down', needsBash: false },
  { id: 'b2-seatbelt', file: 'b2-bash.test.ts', title: 'b2 seatbelt is applied: a write outside the project is denied', needsBash: true },
  { id: 'b2-recovery', file: 'b2-bash.test.ts', title: 'b2: recovery reaps the process, records unknown, and runs the side effect once', needsBash: true },
  { id: 'b2-reap-group', file: 'b2-bash.test.ts', title: 'b2: after a runtime SIGKILL, recovery leaves no process of the Bash command alive: the shell, its background sleep and its foreground sleep share one group, and the group is gone', needsBash: true },
  { id: 'b2-reap-escapee', file: 'b2-bash.test.ts', title: 'b2: after a runtime SIGKILL, recovery also stops a child that left the group with setsid but still holds the call marker', needsBash: true },
  { id: 'b2-reap-escapee-dropped', file: 'b2-bash.test.ts', title: 'b2: after a runtime SIGKILL, a child that left the group and closed the call marker survives recovery, because nothing ties it to the call', needsBash: true },
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
  { id: 'mcp-remote-modern', file: 'mcp-remote.test.ts', title: 'mcp remote: a run calls tools of a 2026-07-28 streamable HTTP server, including a multi round-trip tool', needsBash: false },
  { id: 'mcp-remote-legacy', file: 'mcp-remote.test.ts', title: 'mcp remote: a run calls a tool of a 2025-11-25 streamable HTTP server over a session', needsBash: false },
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
  { id: 'a-constrained-tool-room', file: 'a-compaction.test.ts', title: 'a: constrained tool calling with every tool is offered only the tools that leave room and the run completes', needsBash: false },
  { id: 'g-skills', file: 'skills.test.ts', title: 'g: a skill in .agents/skills appears in the catalog, the model activates it and its body stays in context across a compaction', needsBash: false },
  { id: 'g-skills-explicit', file: 'skills.test.ts', title: 'g: the Run API lists the skills of a session and a run started with a skill has it active before the first model call', needsBash: false },
  { id: 'g-skills-resources', file: 'skills.test.ts', title: 'g: bundled resources of a user skill are read without approval in default mode and the rest of ~/.momonga stays denied', needsBash: false },
  { id: 'g-skills-bash-resource', file: 'skills.test.ts', title: 'g: under seatbelt a Bash command reads a resource of a user skill while the rest of ~/.momonga stays denied', needsBash: true },
  { id: 'g-skills-untrusted', file: 'skills.test.ts', title: 'g: an untrusted folder offers no project skills', needsBash: false },
  { id: 'eval-starter', file: 'eval-runner.test.ts', title: 'eval: momonga eval runs the starter dataset through the daemon against the fake upstream, records transcripts and replays them to the same report', needsBash: false },
  { id: 'eval-false-allow', file: 'eval-runner.test.ts', title: 'eval: momonga eval exits 1 and counts a write allowed by acceptEdits and labelled ask as a false allow, while a blocked read labelled deny is observed as deny', needsBash: false },
  { id: 'context-improve-adopt', file: 'context-improve.test.ts', title: 'context improve: a contrastive scenario, one improving candidate, a real improve that writes its outcome and stores nothing, an adopt of that outcome file under the operator declaration, a refused second adopt, and a following run whose compaction carries the guideline', needsBash: false },
  { id: 'eval-context-live', file: 'eval-context.test.ts', title: 'eval context: a live run through the real stack gives a Bash call the home of the case, compacts the on case only, loads the revised rule, sees the stale memory, reports the numbers and replays to the same report', needsBash: true },
  { id: 'eval-context-kill', file: 'eval-context-kill.test.ts', title: 'eval context: a case daemon stops when the CLI that started it is killed with SIGKILL, and the next eval context removes the home it left', needsBash: false },
  { id: 'otlp-export', file: 'otlp-export.test.ts', title: 'otlp: a run exports GenAI spans from the gateway and the runtime to a loopback collector when settings opt in', needsBash: false },
  { id: 'cost-report', file: 'otlp-export.test.ts', title: 'cost: per-run and per-session cost comes from the usage the gateway recorded in its trace store', needsBash: false },
  { id: 'open-responses-compliance', file: 'open-responses-compliance.test.ts', title: 'open responses: the official compliance suite runs against the gateway TCP debug listener and matches the declared support matrix', needsBash: false },
  { id: 'providers-anthropic', file: 'providers.test.ts', title: 'providers: a run with a tool call completes through the Anthropic adapter with a stored secret', needsBash: false },
  { id: 'providers-open-responses', file: 'providers.test.ts', title: 'providers: a run with a tool call completes through the Open Responses relay with a stored secret', needsBash: false },
  { id: 'providers-missing-secret', file: 'providers.test.ts', title: 'providers: a run fails with secret_unavailable when the stored secret is missing and the upstream is never called', needsBash: false },
  { id: 'cli-print', file: 'cli.test.ts', title: 'cli: momonga -p completes a Glob, Read and Edit task through an autostarted daemon and the file changes', needsBash: false },
  { id: 'cli-formats', file: 'cli.test.ts', title: 'cli: --output-format json prints one result object and stream-json prints init, every run event and the result', needsBash: false },
  { id: 'cli-approve', file: 'cli.test.ts', title: 'cli: a -p run in default mode waits for approval, momonga approve lists and resolves it, and the edit lands', needsBash: false },
  { id: 'cli-child-approval', file: 'cli.test.ts', title: 'cli: a -p run whose subagent asks for approval prints the request, momonga approve and momonga status show it under the child run, and resolving it lets both runs finish', needsBash: false },
  { id: 'cli-cancel', file: 'cli.test.ts', title: 'cli: momonga cancel ends a running -p run as CANCELLED', needsBash: false },
  { id: 'cli-attach', file: 'cli.test.ts', title: 'cli: attach replays a finished run, --after skips what was seen, and trace summarises it', needsBash: false },
  { id: 'cli-daemon', file: 'cli.test.ts', title: 'cli: daemon status and stop, and the next command autostarts a single daemon again', needsBash: false },
  { id: 'cli-version-restart', file: 'cli.test.ts', title: 'cli: an idle daemon of an older version is drained and replaced before a run is started', needsBash: false },
  { id: 'cli-older-daemon-active-run', file: 'cli.test.ts', title: 'cli: a newer client leaves an older daemon with an active run alone: status and a new run neither drain it, and the new run is served by it', needsBash: false },
  { id: 'cli-newer-daemon', file: 'cli.test.ts', title: 'cli: an older client never replaces a newer daemon', needsBash: false },
  { id: 'cli-long-home', file: 'cli.test.ts', title: 'cli: --version works under a home too long for a socket path, and other commands report the typed cause instead of a stack trace', needsBash: false },
  { id: 'cli-reconnect', file: 'cli.test.ts', title: 'cli: a runtime killed mid-run drops the event stream and the CLI resumes it with Last-Event-ID without a gap or a duplicate', needsBash: false },
  { id: 'cli-env', file: 'cli.test.ts', title: 'cli: the environment snapshot sent at session creation carries no credentials', needsBash: false },
  { id: 'cli-probe', file: 'cli.test.ts', title: 'cli: gateway probe fm records the measurement and reports the remedy when fm is unavailable', needsBash: false },
  { id: 'cli-probe-chat-completions', file: 'cli.test.ts', title: 'cli: gateway probe measures a chat-completions target and records it by endpoint, model and identity', needsBash: false },
  { id: 'cli-race', file: 'cli.test.ts', title: 'cli: two commands started together share one daemon', needsBash: false },
  { id: 'cli-interrupt', file: 'cli.test.ts', title: 'cli: ctrl+c during -p cancels the run and exits 130', needsBash: false },
  { id: 'cli-pty-exit-running', file: 'cli-pty.test.ts', title: 'cli pty: /exit while a task runs leaves the terminal at once and the task continues in the daemon', needsBash: false },
  { id: 'cli-pty-approval', file: 'cli-pty.test.ts', title: 'cli pty: first-run trust prompt, Edit approval with a diff, mode cycling and a clean exit through a real pty', needsBash: false },
  { id: 'cli-pty-child-approval', file: 'cli-pty.test.ts', title: 'cli pty: an approval raised inside a subagent run is shown in the terminal with the waiting status, and answering it lets the parent finish', needsBash: false },
  { id: 'cli-pty-session', file: 'cli-pty.test.ts', title: 'cli pty: slash commands, multi-line input, esc cancels a running task, history recall and /exit through a real pty', needsBash: false },
  { id: 'providers-secret-added-after-start', file: 'providers.test.ts', title: 'providers: a secret stored after the gateway started is used on the next run without a restart', needsBash: false },
  { id: 'memory-persist', file: 'memory.test.ts', title: 'memory: a memory saved after approval in one session reaches a later session with its provenance across a runtime restart, and a deleted one is gone', needsBash: false },
  { id: 'memory-project-trust', file: 'memory.test.ts', title: 'memory: project memories load only in a trusted folder and cannot be saved in an untrusted one', needsBash: false },
  { id: 'learning-loop', file: 'learning-loop.test.ts', title: 'learning loop: a verified run with reflection enabled yields a candidate that is charged and shown by momonga cost, is never recalled until memory review accept, then reaches the next run, and the sweeper of the started runtime also marks a duplicate and stops on shutdown', needsBash: false },
  { id: 'memory-secret-and-data', file: 'memory.test.ts', title: 'memory: a secret is refused before any approval and a recalled note cannot break out of its data block', needsBash: false },
  { id: 'mcp-oauth-login', file: 'mcp-complete.test.ts', title: 'mcp: a server that needs authorization surfaces a typed event, the client logs in through the Run API and the next run succeeds', needsBash: false },
  { id: 'mcp-elicitation', file: 'mcp-complete.test.ts', title: 'mcp: an elicitation reaches the Run API as an event, the answer resumes the multi round-trip request and the run completes', needsBash: false },
  { id: 'mcp-task-input', file: 'mcp-complete.test.ts', title: 'mcp: a task that needs input is answered through tasks/update and the run completes', needsBash: false },
  { id: 'mcp-task-input-cancel-after-crash', file: 'mcp-complete.test.ts', title: 'mcp: a runtime killed with SIGKILL while a task waits for input cancels the parked task when the run is cancelled after the restart', needsBash: false },
  { id: 'mcp-cancel-release-after-crash', file: 'mcp-complete.test.ts', title: 'mcp: a runtime killed with SIGKILL after a cancel committed but before the parked task was released releases it on the next start', needsBash: false },
  { id: 'mcp-task-recovery', file: 'mcp-complete.test.ts', title: 'mcp: a runtime killed with SIGKILL during a task resumes polling the recorded task and starts no second one', needsBash: false },
  { id: 'agent-run', file: 'agents.test.ts', title: 'agents: a subagent runs as a child run, the parent waits and receives its final text, and the Run API shows the hierarchy', needsBash: false },
  { id: 'agent-cancel', file: 'agents.test.ts', title: 'agents: cancelling the parent cancels the running child and cuts its upstream connection', needsBash: false },
  { id: 'agent-kill', file: 'agents.test.ts', title: 'agents: the runtime killed during the child model call recovers the child and the parent without a second child', needsBash: false },
  { id: 'bg-output', file: 'agents.test.ts', title: 'background bash: a run waits on a job with BashOutput block and receives its output after it ends', needsBash: true },
  { id: 'bg-kill', file: 'agents.test.ts', title: 'background bash: KillBash stops the job and its process group', needsBash: true },
  { id: 'bg-runtime-kill', file: 'agents.test.ts', title: 'background bash: the runtime killed while a run waits on a job leaves the job unknown, kills its process group and wakes the run', needsBash: true },
  { id: 'cli-job-list', file: 'agents.test.ts', title: 'cli: momonga jobs lists a running background job and then its exit, and momonga status shows the run waiting on it', needsBash: true },
  { id: 'cli-models', file: 'product-cli.test.ts', title: 'cli: momonga models lists the aliases with the capabilities the gateway declares, as text and as JSON', needsBash: false },
  { id: 'cli-policy-verify', file: 'product-cli.test.ts', title: 'cli: momonga policy verify proves a clean rule set and states what it does not prove, and exits non-zero with a counterexample when an allow rule admits a denied subcommand or reaches a secret', needsBash: false },
  { id: 'cli-cost', file: 'product-cli.test.ts', title: 'cli: momonga cost reports the calls and tokens of a run, of its session and of the folder, as text and as JSON', needsBash: false },
  {
    id: 'cost-breakdown',
    file: 'token-anatomy.test.ts',
    title: 'token anatomy: a two-step run against an upstream that reports cached and reasoning tokens, then momonga cost --breakdown shows its layers, billed tokens, cache hit ratio, timing and cost for the run and the session',
    needsBash: false,
  },
  { id: 'cli-memory', file: 'product-cli.test.ts', title: 'cli: momonga memory lists, shows and deletes a memory the agent saved, with its source', needsBash: false },
  { id: 'cli-skill-print', file: 'product-cli.test.ts', title: 'cli: momonga -p runs a skill through a leading /skill-name and through --skill, and sends any other slash text as plain text', needsBash: false },
  { id: 'cli-image-print', file: 'product-cli.test.ts', title: 'cli: momonga -p --image sends the image to a model that declares image input and fails with image_input_unsupported for one that does not', needsBash: false },
  { id: 'cli-elicit-print', file: 'product-cli.test.ts', title: 'cli: a -p run waiting for MCP input prints the request and the momonga elicit command, and the answer given with it resumes the run', needsBash: false },
  { id: 'cli-mcp-login', file: 'product-cli.test.ts', title: 'cli: momonga mcp list shows an unauthorized server, mcp login opens the browser through the port and authorizes it, and --no-browser prints the URL only', needsBash: false },
  { id: 'cli-mcp-notice', file: 'product-cli.test.ts', title: 'cli: a -p run that needs MCP authorization prints the momonga mcp login command', needsBash: false },
  { id: 'cli-secret', file: 'product-pty.test.ts', title: 'cli pty: momonga secret set reads the value hidden from the terminal twice and stores it through the secret store port', needsBash: false },
  { id: 'cli-skill-pty', file: 'product-pty.test.ts', title: 'cli pty: a /skill-name is completed with tab from the skills of the session and starts a run with the skill', needsBash: false },
  { id: 'cli-memory-pty', file: 'product-pty.test.ts', title: 'cli pty: /memory lists, shows and deletes the memories in the terminal', needsBash: false },
  { id: 'cli-image-pty', file: 'product-pty.test.ts', title: 'cli pty: pasting an image path attaches the image for a model that declares image input and sends it with the prompt', needsBash: false },
  { id: 'cli-startup-notices', file: 'product-pty.test.ts', title: 'cli pty: the startup screen lists the load warnings of the agents and the skills of the session', needsBash: false },
  { id: 'cli-elicit-pty', file: 'product-pty.test.ts', title: 'cli pty: an MCP form is filled and validated in the terminal, and a url request shows the full URL and opens it only after consent', needsBash: false },
  { id: 'acp-daemon-restart', file: 'acp.test.ts', title: 'acp: session/new starts the daemon again after it was stopped while the connection stayed open', needsBash: false },
  { id: 'acp-edit-task', file: 'acp.test.ts', title: 'acp: a prompt that globs, reads and edits a file streams tool calls with their kinds, a diff and a usage update while stdout carries protocol frames only', needsBash: false },
  { id: 'acp-permission', file: 'acp.test.ts', title: 'acp: in default mode the edit asks the client with the four options; allow_once applies it and reject_once leaves the file and tells the model', needsBash: false },
  { id: 'acp-child-permission', file: 'acp.test.ts', title: 'acp: an approval raised inside a subagent run reaches the client as session/request_permission, and the parent turn ends after it is answered', needsBash: false },
  { id: 'acp-cancel', file: 'acp.test.ts', title: 'acp: session/cancel ends a streaming prompt with the cancelled stop reason', needsBash: false },
  { id: 'acp-mode', file: 'acp.test.ts', title: 'acp: session/set_mode changes the permission mode of the Run API session and announces it, and a mode the session may not use is refused', needsBash: false },
  { id: 'acp-load', file: 'acp.test.ts', title: 'acp: session/load on a second connection replays the conversation before it answers and the session continues with its history', needsBash: false },
  { id: 'acp-mcp', file: 'acp.test.ts', title: 'acp: an MCP server passed with session/new is offered to the model and its tool runs, and an sse server is refused', needsBash: false },
  { id: 'acp-elicitation', file: 'acp.test.ts', title: 'acp: an MCP server that asks the user for input reaches the editor as an elicitation and the answer resumes the tool call', needsBash: false },
  { id: 'acp-commands', file: 'acp.test.ts', title: 'acp: the skills of the session are announced as commands and a slash prompt activates the skill', needsBash: false },
  { id: 'hook-pretooluse-block', file: 'hooks-auto.test.ts', title: 'hooks: a PreToolUse hook that exits 2 blocks the write, the denial is structured and the hook run is in the event stream', needsBash: true },
  { id: 'auto-allow', file: 'hooks-auto.test.ts', title: 'auto: a confident safe verdict from the classifier alias runs the write without an approval', needsBash: false },
  { id: 'auto-fallback', file: 'hooks-auto.test.ts', title: 'auto: an unsafe verdict and a malformed verdict each fall back to an approval request for the person', needsBash: false },
  { id: 'auto-eval-false-allow', file: 'hooks-auto.test.ts', title: 'auto eval: the auto-mode golden dataset reports the measured false-allow rate of the classifier against the fake upstream', needsBash: false },
  { id: 'cli-hook-denial', file: 'hooks-auto-cli.test.ts', title: 'cli: a -p run whose PreToolUse hook blocks a write prints the hook run and the denial by its source, and the file is not written', needsBash: true },
  { id: 'cli-auto-print', file: 'hooks-auto-cli.test.ts', title: 'cli: a -p run in auto mode prints the classifier verdict that allowed the write and the file changes', needsBash: false },
  { id: 'cli-auto-unavailable', file: 'hooks-auto-cli.test.ts', title: 'cli: a -p run in auto mode without a configured classifier fails with mode_unavailable stated plainly and never calls the model', needsBash: false },
  { id: 'roles-compaction', file: 'roles.test.ts', title: 'roles: with models.roles.compaction set, compaction goes to the target of the role alias, the steps of the run go to the target of the run alias, and the cost report shows both roles', needsBash: false },
  { id: 'cli-user-prompt-blocked', file: 'hooks-auto-cli.test.ts', title: 'cli: a -p run whose UserPromptSubmit hook blocks the prompt prints the hook run and states that the prompt was blocked', needsBash: true },
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
