import type { Command } from 'commander';
import { InvalidArgumentError, Option } from 'commander';
import { CONTEXT_MODELS, DEFAULT_DATASET_SEED, MAX_DATASET_SEED } from '@momonga/eval';
import type { ContextModel } from '@momonga/eval';
import { GOVERNING_KINDS, MEMORY_KINDS, MEMORY_SCOPES, PERMISSION_MODES } from '@momonga/protocol';
import type { GoverningEnforcement, GoverningKind, MemoryKind, MemoryScope, PermissionMode } from '@momonga/protocol';
import { pathsOf } from '../paths.ts';
import type { ProgramDeps } from '../program-deps.ts';
import { contextImprove, guidelineAdopt, guidelineList, guidelineRollback } from './context.ts';
import { showCost } from './cost.ts';
import { elicit } from './elicit.ts';
import { compareContext, evaluate, evaluateContext } from './evaluate.ts';
import { mcpList, mcpLogin } from './mcp.ts';
import { memoryAccept, memoryAdd, memoryDelete, memoryHistory, memoryList, memoryPromote, memoryReject, memoryRestore, memoryReview, memoryShow } from './memory.ts';
import { ruleAdd, ruleHistory, ruleList, ruleRetire } from './rule.ts';
import { listJobs } from './jobs.ts';
import { listModels } from './models.ts';
import { policyVerify } from './policy.ts';
import { showStatus } from './runs.ts';
import { secretSet } from './secret.ts';

export type CommandGroup = (program: Command, deps: ProgramDeps) => void;

const collect = (value: string, previous: readonly string[]): string[] => [...previous, value];

const seedArgument = (text: string): number => {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > MAX_DATASET_SEED) throw new InvalidArgumentError(`expected an integer from 0 to ${MAX_DATASET_SEED}`);
  return value;
};

const registerElicit: CommandGroup = (program, deps) => {
  program
    .command('elicit [input-id]')
    .description('list pending MCP input requests, show one, or answer it with --accept, --decline, --cancel or --responses')
    .option('--accept', 'accept the request')
    .option('--decline', 'decline the request')
    .option('--cancel', 'cancel the request')
    .option('--set <name=value>', 'a field of the form to accept with; repeat for several fields', collect, [])
    .option('--responses <json>', 'the complete answer as JSON keyed by request key')
    .action(async (inputId: string | undefined, options: { accept?: true; decline?: true; cancel?: true; set: string[]; responses?: string }) => {
      deps.complete(
        await elicit(
          deps.ports,
          pathsOf(deps.ports),
          inputId,
          { accept: options.accept === true, decline: options.decline === true, cancel: options.cancel === true, set: options.set, ...(options.responses === undefined ? {} : { responses: options.responses }) },
          deps.interrupt,
        ),
      );
    });
};

const registerMcp: CommandGroup = (program, deps) => {
  const mcp = program.command('mcp').description('inspect and authorize the MCP servers of this folder');
  mcp
    .command('list')
    .description('list the MCP servers with their transport and authorization state')
    .option('--json', 'print the servers as JSON')
    .action(async (options: { json?: true }) => {
      deps.complete(await mcpList(deps.ports, pathsOf(deps.ports), options.json === true));
    });
  mcp
    .command('login <server>')
    .description('authorize a remote MCP server in the browser')
    .option('--no-browser', 'print the authorization URL without opening the browser')
    .action(async (server: string, options: { browser: boolean }) => {
      deps.complete(await mcpLogin(deps.ports, pathsOf(deps.ports), server, { openBrowser: options.browser, interrupt: deps.interrupt }));
    });
};

const memoryScopeOption = (): Option => new Option('--scope <scope>', 'only memories of this scope').choices(MEMORY_SCOPES);

const registerMemory: CommandGroup = (program, deps) => {
  const memory = program.command('memory').description('add, review and delete the memories of this folder and of all folders');
  memory
    .command('add <text...>')
    .description('add a memory as a person; --path binds it to a file of this folder, so it shows as stale once the file changes')
    .addOption(new Option('--kind <kind>', 'the kind of memory').choices(MEMORY_KINDS))
    .option('--path <path>', 'a file of this folder the memory is about; repeat for several', collect, [])
    .option('--user', 'add a memory for every folder instead of this one')
    .option('--json', 'print the memory as JSON')
    .action(async (text: string[], options: { kind?: MemoryKind; path: string[]; user?: true; json?: true }) => {
      deps.complete(
        await memoryAdd(deps.ports, pathsOf(deps.ports), text.join(' '), {
          ...(options.kind === undefined ? {} : { kind: options.kind }),
          user: options.user === true,
          paths: options.path,
          json: options.json === true,
        }),
      );
    });
  memory
    .command('list')
    .description('list the memories')
    .addOption(memoryScopeOption())
    .option('--project <path>', 'only memories of this project folder')
    .option('--json', 'print the memories as JSON')
    .action(async (options: { scope?: MemoryScope; project?: string; json?: true }) => {
      deps.complete(
        await memoryList(deps.ports, pathsOf(deps.ports), {
          ...(options.scope === undefined ? {} : { scope: options.scope }),
          ...(options.project === undefined ? {} : { project: options.project }),
          json: options.json === true,
        }),
      );
    });
  memory
    .command('show <id>')
    .description('show a memory with its source')
    .option('--json', 'print the memory as JSON')
    .action(async (id: string, options: { json?: true }) => {
      deps.complete(await memoryShow(deps.ports, pathsOf(deps.ports), id, options.json === true));
    });
  memory
    .command('history <id>')
    .description('show a memory with the notes it replaced and the ones that replaced it, and their validity')
    .option('--json', 'print the memories as JSON')
    .action(async (id: string, options: { json?: true }) => {
      deps.complete(await memoryHistory(deps.ports, pathsOf(deps.ports), id, options.json === true));
    });
  memory
    .command('delete <id>')
    .description('delete a memory')
    .action(async (id: string) => {
      deps.complete(await memoryDelete(deps.ports, pathsOf(deps.ports), id));
    });
  const review = memory
    .command('review')
    .description('list the memories the agent proposed in this folder and wait for your decision')
    .option('--json', 'print the memories as JSON')
    .action(async (options: { json?: true }) => {
      deps.complete(await memoryReview(deps.ports, pathsOf(deps.ports), { json: options.json === true }));
    });
  review
    .command('accept <id>')
    .description('accept a proposed memory, so later sessions recall it')
    .action(async (id: string) => {
      deps.complete(await memoryAccept(deps.ports, pathsOf(deps.ports), id));
    });
  review
    .command('reject <id>')
    .description('reject a proposed memory, so it is never recalled and never proposed again')
    .action(async (id: string) => {
      deps.complete(await memoryReject(deps.ports, pathsOf(deps.ports), id));
    });
  memory
    .command('restore <id>')
    .description('bring an archived memory back')
    .action(async (id: string) => {
      deps.complete(await memoryRestore(deps.ports, pathsOf(deps.ports), id));
    });
  memory
    .command('promote <id>')
    .description('write an accepted procedure memory as a skill')
    .requiredOption('--skill <name>', 'the name of the skill to write')
    .action(async (id: string, options: { skill: string }) => {
      deps.complete(await memoryPromote(deps.ports, pathsOf(deps.ports), id, options.skill));
    });
};

type RuleAddFlags = { kind: GoverningKind; user?: true; path: string[]; deny?: string; ask?: string; supersedes: string[]; until?: string; json?: true };

const enforcementOf = (flags: RuleAddFlags): GoverningEnforcement | null => {
  if (flags.deny !== undefined && flags.ask !== undefined) throw new InvalidArgumentError('use either --deny or --ask, not both');
  if (flags.deny !== undefined) return { behavior: 'deny', rule: flags.deny };
  if (flags.ask !== undefined) return { behavior: 'ask', rule: flags.ask };
  return null;
};

const untilOf = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new InvalidArgumentError(`--until ${JSON.stringify(text)} is not a date`);
  return parsed;
};

const registerRule: CommandGroup = (program, deps) => {
  const rule = program.command('rule').description('standing rules that bind every run of a folder or of all folders');
  rule
    .command('add <target> <text...>')
    .description('add a rule; --deny or --ask makes it enforced by the permission system')
    .addOption(new Option('--kind <kind>', 'the kind of rule').choices(GOVERNING_KINDS).default('constraint'))
    .option('--user', 'apply in every folder instead of this one')
    .option('--path <glob>', 'apply only when this path pattern is touched; repeat for several', collect, [])
    .option('--deny <rule>', 'a permission rule to deny, for example "Bash(rm:*)"')
    .option('--ask <rule>', 'a permission rule to ask about, for example "Bash(git push:*)"')
    .option('--supersedes <id>', 'the id of the rule this one replaces; repeat for several', collect, [])
    .option('--until <date>', 'the date after which the rule no longer applies')
    .option('--json', 'print the result as JSON')
    .action(async (target: string, text: string[], flags: RuleAddFlags) => {
      const until = untilOf(flags.until);
      deps.complete(
        await ruleAdd(deps.ports, pathsOf(deps.ports), target, text.join(' '), {
          kind: flags.kind,
          user: flags.user === true,
          paths: flags.path,
          enforcement: enforcementOf(flags),
          supersedes: flags.supersedes,
          ...(until === undefined ? {} : { until }),
          json: flags.json === true,
        }),
      );
    });
  rule
    .command('list')
    .description('list the rules of this folder and the rules for every folder, enforced or text-only')
    .option('--json', 'print the rules as JSON')
    .action(async (options: { json?: true }) => {
      deps.complete(await ruleList(deps.ports, pathsOf(deps.ports), options.json === true));
    });
  rule
    .command('retire <id>')
    .description('retire a rule; a retired rule stays in the history')
    .action(async (id: string) => {
      deps.complete(await ruleRetire(deps.ports, pathsOf(deps.ports), id));
    });
  rule
    .command('history <id>')
    .description('show the rules a rule replaced and the ones that replaced it, with their validity')
    .option('--json', 'print the rules as JSON')
    .action(async (id: string, options: { json?: true }) => {
      deps.complete(await ruleHistory(deps.ports, pathsOf(deps.ports), id, options.json === true));
    });
};

const registerCost: CommandGroup = (program, deps) => {
  program
    .command('cost [run-id]')
    .description('show the model cost of a run, of a session, or of the sessions of this folder')
    .option('--session <id>', 'the cost of one session')
    .option('--all', 'the cost of every session')
    .option('--breakdown', 'show what the requests were made of, the billed tokens by kind, the cache hit ratio, the timing and the cost')
    .option('--json', 'print the report as JSON')
    .action(async (runId: string | undefined, options: { session?: string; all?: true; breakdown?: true; json?: true }) => {
      deps.complete(
        await showCost(deps.ports, pathsOf(deps.ports), {
          ...(runId === undefined ? {} : { runId }),
          ...(options.session === undefined ? {} : { session: options.session }),
          all: options.all === true,
          json: options.json === true,
          breakdown: options.breakdown === true,
        }),
      );
    });
};

const registerEvaluate: CommandGroup = (program, deps) => {
  const evaluation = program
    .command('eval <dataset>')
    .enablePositionalOptions()
    .description('run a golden dataset against the daemon and report the pass rates')
    .option('--record <directory>', 'save the transcript of every run in this directory')
    .option('--replay <directory>', 'grade recorded transcripts instead of running the dataset')
    .action(async (dataset: string, options: { record?: string; replay?: string }) => {
      deps.complete(
        await evaluate(deps.ports, pathsOf(deps.ports), dataset, {
          interrupt: deps.interrupt,
          ...(options.record === undefined ? {} : { record: options.record }),
          ...(options.replay === undefined ? {} : { replay: options.replay }),
        }),
      );
    });
  evaluation
    .command('context <dataset>')
    .description(
      'run a context dataset live, each case in its own temporary home with its own daemon, or measure recorded transcripts with --replay, and report the metrics of Evidence-Based Context',
    )
    .option('--replay <directory>', 'the recorded transcripts to measure instead of running the dataset')
    .option('--record <directory>', 'save the transcript of every measured run of a live run in this directory')
    .addOption(new Option('--model <model>', 'which kind of model produced the runs; a fake model proves only that the machinery works').choices(CONTEXT_MODELS))
    .option('--alias <alias>', 'the model alias every session of a live run is pinned to')
    .option('--seed <n>', 'the seed of the noise turns of a live run; 0 when omitted', seedArgument)
    .option('--report <file>', 'store the report as JSON for eval compare')
    .action(async (dataset: string, options: { replay?: string; record?: string; model?: ContextModel; alias?: string; seed?: number; report?: string }) => {
      deps.complete(
        await evaluateContext(deps.ports, dataset, {
          interrupt: deps.interrupt,
          ...(options.replay === undefined ? {} : { replay: options.replay }),
          ...(options.record === undefined ? {} : { record: options.record }),
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.alias === undefined ? {} : { alias: options.alias }),
          ...(options.seed === undefined ? {} : { seed: options.seed }),
          ...(options.report === undefined ? {} : { report: options.report }),
        }),
      );
    });
  evaluation
    .command('compare <baseline> <candidate>')
    .description('print the paired differences of two context reports and pass or fail the candidate against the gate')
    .option('--gate <name>', 'the terms the candidate is judged on: context (the default) or token', 'context')
    .action(async (baseline: string, candidate: string, options: { gate: string }) => {
      deps.complete(await compareContext(deps.ports, baseline, candidate, options.gate));
    });
};

const versionArgument = (text: string): number => {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) throw new InvalidArgumentError('expected an integer of at least 1');
  return value;
};

const registerContext: CommandGroup = (program, deps) => {
  const context = program.command('context').description('improve how the context is compacted, from the failures a benchmark shows');
  context
    .command('improve')
    .description(
      'analyse the scenarios that pass without compaction and fail with it, sample candidate guidelines for the compaction summary, benchmark each against the guideline in force, print the winner and its full text, and write the outcome to a file; nothing is stored',
    )
    .requiredOption('--dataset <file>', 'the context dataset to benchmark')
    .addOption(new Option('--model <model>', 'which kind of model produced the runs; a fake model proves only that the machinery works, and no candidate can pass the gate with it').choices(CONTEXT_MODELS).makeOptionMandatory())
    .requiredOption('--alias <alias>', 'the model alias of the benchmark sessions and of the analysis and candidate calls')
    .option('--seed <n>', 'the seed of the noise turns and of the candidate draws; 0 when omitted', seedArgument)
    .requiredOption('--outcome <file>', 'the file the outcome is written to: the candidates, the text of the winner, its report, the dataset digest, the parent version and a digest of the whole')
    .action(async (options: { dataset: string; model: ContextModel; alias: string; seed?: number; outcome: string }) => {
      deps.complete(
        await contextImprove(deps.ports, pathsOf(deps.ports), {
          dataset: options.dataset,
          model: options.model,
          alias: options.alias,
          seed: options.seed ?? DEFAULT_DATASET_SEED,
          outcome: options.outcome,
          interrupt: deps.interrupt,
        }),
      );
    });
  const guideline = context.command('guideline').description('inspect, adopt and roll back the compaction guideline');
  guideline
    .command('adopt')
    .description('store the winner of an outcome file that context improve wrote, after checking its digest and its parent and showing its full text')
    .argument('<outcome-file>', 'the outcome file written by context improve --outcome')
    .action(async (outcomeFile: string) => {
      deps.complete(await guidelineAdopt(deps.ports, pathsOf(deps.ports), outcomeFile));
    });
  guideline
    .command('list')
    .description('list the adopted guidelines, oldest first')
    .action(async () => {
      deps.complete(await guidelineList(deps.ports, pathsOf(deps.ports)));
    });
  guideline
    .command('rollback')
    .description('return to the text of an earlier version, recorded as a new version')
    .argument('<version>', 'the version to return to', versionArgument)
    .action(async (version: number) => {
      deps.complete(await guidelineRollback(deps.ports, pathsOf(deps.ports), version));
    });
};

const registerSecret: CommandGroup = (program, deps) => {
  const secret = program.command('secret').description('store the secrets that model targets refer to');
  secret
    .command('set <name>')
    .description('store a secret in the platform secret store; the value is read from the terminal')
    .action(async (name: string) => {
      deps.complete(await secretSet(deps.ports, pathsOf(deps.ports), name, deps.interrupt));
    });
};

const registerModels: CommandGroup = (program, deps) => {
  program
    .command('models')
    .description('list the model aliases with the capabilities their targets declare')
    .option('--json', 'print the models as JSON')
    .action(async (options: { json?: true }) => {
      deps.complete(await listModels(deps.ports, pathsOf(deps.ports), options.json === true));
    });
};

const registerPolicy: CommandGroup = (program, deps) => {
  const policy = program.command('policy').description('check the permission rules of this folder');
  policy
    .command('verify')
    .description('prove that no allow rule gets around a deny rule, that no rule leaves a route to secrets, and that every rule can take effect; states what is proved and what is not')
    .option('--json', 'print the report as JSON')
    .addOption(new Option('--mode <mode>', 'the permission mode to check; the default mode of the settings when omitted').choices(PERMISSION_MODES))
    .option('--secret <path>', 'a further secret location to keep out of reach; repeat for several', collect, [])
    .action(async (options: { json?: true; mode?: PermissionMode; secret: string[] }) => {
      deps.complete(
        await policyVerify(deps.ports, pathsOf(deps.ports), deps.policyVerify(), {
          json: options.json === true,
          secrets: options.secret,
          ...(options.mode === undefined ? {} : { mode: options.mode }),
        }),
      );
    });
};

const registerRunTree: CommandGroup = (program, deps) => {
  program
    .command('status [run-id]')
    .description('show a run, the subagent runs under it and the approvals waiting in them; the latest run of this directory when no id is given')
    .option('--json', 'print the runs and approvals as JSON')
    .action(async (runId: string | undefined, options: { json?: true }) => {
      deps.complete(await showStatus(deps.ports, pathsOf(deps.ports), runId, options.json === true));
    });
  program
    .command('jobs [session-id]')
    .description('list the background jobs of a session, including those of its subagents; the newest session of this directory when no id is given')
    .option('--json', 'print the jobs as JSON')
    .action(async (sessionId: string | undefined, options: { json?: true }) => {
      deps.complete(await listJobs(deps.ports, pathsOf(deps.ports), sessionId, options.json === true));
    });
};

export const PRODUCT_COMMAND_GROUPS: readonly CommandGroup[] = [registerElicit, registerMcp, registerRunTree, registerMemory, registerRule, registerCost, registerEvaluate, registerContext, registerSecret, registerModels, registerPolicy];

export const registerProductCommands = (program: Command, deps: ProgramDeps): void => {
  for (const group of PRODUCT_COMMAND_GROUPS) group(program, deps);
};
