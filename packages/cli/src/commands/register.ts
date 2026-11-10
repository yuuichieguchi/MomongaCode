import type { Command } from 'commander';
import { InvalidArgumentError, Option } from 'commander';
import { DEFAULT_DATASET_SEED, MAX_DATASET_SEED } from '@momonga/eval';
import { GROUP_KEYS } from '@momonga/reliability';
import type { GroupKey } from '@momonga/reliability';
import { GOVERNING_KINDS, MEMORY_KINDS, MEMORY_SCOPES, PERMISSION_MODES } from '@momonga/protocol';
import type { GoverningEnforcement, GoverningKind, MemoryKind, MemoryScope, PermissionMode } from '@momonga/protocol';
import { pathsOf } from '../paths.ts';
import type { ProgramDeps } from '../program-deps.ts';
import { runAuthLogin, runAuthLogout, runAuthResetHost, runAuthResume, runAuthStatus, runModelsCatalog } from './auth-wiring.ts';
import { contextImprove, guidelineAdopt, guidelineList, guidelineRollback } from './context.ts';
import { showCost } from './cost.ts';
import { elicit } from './elicit.ts';
import { autoModeCheck, autoModeCheckPortsOf, autoModeStatus, autoModeStatusPortsOf } from './auto-mode.ts';
import { compareContext, evaluate, evaluateContext } from './evaluate.ts';
import { mcpList, mcpLogin } from './mcp.ts';
import { memoryAccept, memoryAdd, memoryDelete, memoryHistory, memoryList, memoryPromote, memoryReject, memoryRestore, memoryReview, memoryShow } from './memory.ts';
import { ruleAdd, ruleHistory, ruleList, ruleRetire } from './rule.ts';
import { listJobs } from './jobs.ts';
import { checkModels, detectModels, listModels, modelsShellOf, runModelsForm } from './models.ts';
import type { FormOption, ModelsForm, ModelsShell } from './models.ts';
import { policyVerify } from './policy.ts';
import { showReliability } from './reliability.ts';
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
          await pathsOf(deps.ports),
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
      deps.complete(await mcpList(deps.ports, await pathsOf(deps.ports), options.json === true));
    });
  mcp
    .command('login <server>')
    .description('authorize a remote MCP server in the browser')
    .option('--no-browser', 'print the authorization URL without opening the browser')
    .action(async (server: string, options: { browser: boolean }) => {
      deps.complete(await mcpLogin(deps.ports, await pathsOf(deps.ports), server, { openBrowser: options.browser, interrupt: deps.interrupt }));
    });
};

const registerAuth: CommandGroup = (program, deps) => {
  const auth = program.command('auth').description('sign in to a subscription provider, sign out, and show the saved accounts');
  auth
    .command('login [provider]')
    .description('sign in to a subscription provider in the browser')
    .option('--account <label>', 'the label of the account; the first free label by default')
    .option('--no-browser', 'print the authorization URL without opening the browser')
    .option('--reconsent', 'sign in again to enable plan use for the account')
    .action(async (provider: string | undefined, options: { account?: string; browser: boolean; reconsent?: true }) => {
      deps.complete(
        await runAuthLogin(
          deps.ports,
          await pathsOf(deps.ports),
          {
            ...(provider === undefined ? {} : { provider }),
            ...(options.account === undefined ? {} : { account: options.account }),
            browser: options.browser,
            reconsent: options.reconsent === true,
          },
          deps.interrupt,
        ),
      );
    });
  auth
    .command('logout [account]')
    .description('sign out a saved account; without a terminal the account is required')
    .action(async (account: string | undefined) => {
      deps.complete(await runAuthLogout(deps.ports, await pathsOf(deps.ports), account, deps.interrupt));
    });
  auth
    .command('status [model]')
    .description('show the saved accounts, their state, where to manage usage, and the model new sessions start with or the model named')
    .option('--json', 'print the accounts and the model as JSON')
    .action(async (model: string | undefined, options: { json?: true }) => {
      deps.complete(await runAuthStatus(deps.ports, await pathsOf(deps.ports), { json: options.json === true, ...(model === undefined ? {} : { model }) }));
    });
  auth
    .command('resume <account>')
    .description('resume plan use of an account paused by a usage limit')
    .action(async (account: string) => {
      deps.complete(await runAuthResume(deps.ports, await pathsOf(deps.ports), account));
    });
  auth
    .command('reset-host')
    .description('register this computer as a new host; asks first, or needs --yes without a terminal')
    .option('--yes', 'reset without asking')
    .action(async (options: { yes?: true }) => {
      deps.complete(await runAuthResetHost(deps.ports, await pathsOf(deps.ports), options.yes === true, deps.interrupt));
    });
};

const memoryScopeOption = (): Option => new Option('--scope <scope>', 'only memories of this scope').choices(MEMORY_SCOPES);

const registerMemory: CommandGroup = (program, deps) => {
  const memory = program.command('memory').description('add, review and retire the memories of this folder and of all folders');
  memory
    .command('add <text...>')
    .description('add a memory as a person; --path binds it to a file of this folder, so it shows as stale once the file changes')
    .addOption(new Option('--kind <kind>', 'the kind of memory').choices(MEMORY_KINDS))
    .option('--path <path>', 'a file of this folder the memory is about; repeat for several', collect, [])
    .option('--user', 'add a memory for every folder instead of this one')
    .option('--json', 'print the memory as JSON')
    .action(async (text: string[], options: { kind?: MemoryKind; path: string[]; user?: true; json?: true }) => {
      deps.complete(
        await memoryAdd(deps.ports, await pathsOf(deps.ports), text.join(' '), {
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
        await memoryList(deps.ports, await pathsOf(deps.ports), {
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
      deps.complete(await memoryShow(deps.ports, await pathsOf(deps.ports), id, options.json === true));
    });
  memory
    .command('history <id>')
    .description('show a memory with the notes it replaced and the ones that replaced it, and their validity')
    .option('--json', 'print the memories as JSON')
    .action(async (id: string, options: { json?: true }) => {
      deps.complete(await memoryHistory(deps.ports, await pathsOf(deps.ports), id, options.json === true));
    });
  memory
    .command('delete <id>')
    .description('retire a memory: it is no longer recalled or listed and stays in momonga memory history')
    .action(async (id: string) => {
      deps.complete(await memoryDelete(deps.ports, await pathsOf(deps.ports), id));
    });
  const review = memory
    .command('review')
    .description('list the memories the agent proposed in this folder and wait for your decision')
    .option('--json', 'print the memories as JSON')
    .action(async (options: { json?: true }) => {
      deps.complete(await memoryReview(deps.ports, await pathsOf(deps.ports), { json: options.json === true }));
    });
  review
    .command('accept <id>')
    .description('accept a proposed memory, so later sessions recall it')
    .action(async (id: string) => {
      deps.complete(await memoryAccept(deps.ports, await pathsOf(deps.ports), id));
    });
  review
    .command('reject <id>')
    .description('reject a proposed memory, so it is never recalled and never proposed again')
    .action(async (id: string) => {
      deps.complete(await memoryReject(deps.ports, await pathsOf(deps.ports), id));
    });
  memory
    .command('restore <id>')
    .description('bring an archived memory back')
    .action(async (id: string) => {
      deps.complete(await memoryRestore(deps.ports, await pathsOf(deps.ports), id));
    });
  memory
    .command('promote <id>')
    .description('write an accepted procedure memory as a skill')
    .requiredOption('--skill <name>', 'the name of the skill to write')
    .action(async (id: string, options: { skill: string }) => {
      deps.complete(await memoryPromote(deps.ports, await pathsOf(deps.ports), id, options.skill));
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
        await ruleAdd(deps.ports, await pathsOf(deps.ports), target, text.join(' '), {
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
      deps.complete(await ruleList(deps.ports, await pathsOf(deps.ports), options.json === true));
    });
  rule
    .command('retire <id>')
    .description('retire a rule; a retired rule stays in the history')
    .action(async (id: string) => {
      deps.complete(await ruleRetire(deps.ports, await pathsOf(deps.ports), id));
    });
  rule
    .command('history <id>')
    .description('show the rules a rule replaced and the ones that replaced it, with their validity')
    .option('--json', 'print the rules as JSON')
    .action(async (id: string, options: { json?: true }) => {
      deps.complete(await ruleHistory(deps.ports, await pathsOf(deps.ports), id, options.json === true));
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
        await showCost(deps.ports, await pathsOf(deps.ports), {
          ...(runId === undefined ? {} : { runId }),
          ...(options.session === undefined ? {} : { session: options.session }),
          all: options.all === true,
          json: options.json === true,
          breakdown: options.breakdown === true,
        }),
      );
    });
};

const registerReliability: CommandGroup = (program, deps) => {
  program
    .command('reliability')
    .description('report the completion, recovery, duplicate, intervention, budget and time indicators of the terminal tasks in the record')
    .addOption(new Option('--group-by <key>', 'the key the indicators are grouped by').choices(GROUP_KEYS).default('model'))
    .option('--explain', 'list the run ids behind each count')
    .action(async (options: { groupBy: GroupKey; explain?: true }) => {
      deps.complete(await showReliability(deps.ports, await pathsOf(deps.ports), { groupBy: options.groupBy, explain: options.explain === true }));
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
        await evaluate(deps.ports, await pathsOf(deps.ports), dataset, {
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
    .option('--model <model>', 'the model every session of a live run uses')
    .option('--seed <n>', 'the seed of the noise turns of a live run; 0 when omitted', seedArgument)
    .option('--report <file>', 'store the report as JSON for eval compare')
    .option('--settings <file>', 'a token policy overlay over the defaults, every core key on unless the file turns it off (context.adaptiveBudget, context.autoCompact, context.cachePrefix, context.outputFormatters, context.loopGuidance, context.observedCapacity, context.unboundedOutputReserve, tools.deferral, tools.conciseDescriptions, memory.repositoryFacts, memory.reflection.enabled), merged into the settings of every case of a live run; the report records the resolved policy')
    .action(async (dataset: string, options: { replay?: string; record?: string; model?: string; seed?: number; report?: string; settings?: string }) => {
      deps.complete(
        await evaluateContext(deps.ports, dataset, {
          interrupt: deps.interrupt,
          ...(options.replay === undefined ? {} : { replay: options.replay }),
          ...(options.record === undefined ? {} : { record: options.record }),
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.seed === undefined ? {} : { seed: options.seed }),
          ...(options.report === undefined ? {} : { report: options.report }),
          ...(options.settings === undefined ? {} : { settings: options.settings }),
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

const registerAutoMode: CommandGroup = (program, deps) => {
  const group = program.command('auto-mode').description('measure how well a model judges approvals for auto mode, or show the stored measurement');
  group
    .command('check [model]')
    .description('run the auto-mode dataset against a classifier model in temporary homes and store the measurement; auto mode stays selectable whatever it shows')
    .option('--agent <model>', 'the model that drives the runs and proposes the calls the classifier judges')
    .action(async (model: string | undefined, options: { agent?: string }) => {
      const outcome = await autoModeCheck(await autoModeCheckPortsOf(deps.ports, (text) => deps.ports.stdout.write(text)), {
        signal: deps.interrupt,
        ...(options.agent === undefined ? {} : { agent: options.agent }),
        ...(model === undefined ? {} : { classifier: model }),
      });
      deps.complete(outcome.measurement === 'unmeasurable' ? 1 : 0);
    });
  group
    .command('status [model]')
    .description('show the stored measurement of a classifier model for this version')
    .action(async (model: string | undefined) => {
      await autoModeStatus(autoModeStatusPortsOf(deps.ports, (text) => deps.ports.stdout.write(text)), { surface: 'cli', ...(model === undefined ? {} : { classifier: model }) });
      deps.complete(0);
    });
};

const versionArgument = (text: string): number => {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) throw new InvalidArgumentError('expected an integer of at least 1');
  return value;
};

const tokenCapArgument = (text: string): number => {
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
    .requiredOption('--model <model>', 'the model of the benchmark sessions and of the analysis and candidate calls')
    .requiredOption('--token-cap <n>', 'the most tokens the command may spend on benchmark runs and model calls together; the number of candidates is what this cap affords after the baseline and the analyses', tokenCapArgument)
    .option('--seed <n>', 'the seed of the noise turns and of the candidate draws; 0 when omitted', seedArgument)
    .requiredOption('--outcome <file>', 'the file the outcome is written to: the candidates, the text of the winner, its report, the dataset digest, the parent version and a digest of the whole')
    .action(async (options: { dataset: string; model: string; tokenCap: number; seed?: number; outcome: string }) => {
      deps.complete(
        await contextImprove(deps.ports, await pathsOf(deps.ports), {
          dataset: options.dataset,
          model: options.model,
          tokenCap: options.tokenCap,
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
      deps.complete(await guidelineAdopt(deps.ports, await pathsOf(deps.ports), outcomeFile));
    });
  guideline
    .command('list')
    .description('list the adopted guidelines, oldest first')
    .action(async () => {
      deps.complete(await guidelineList(deps.ports, await pathsOf(deps.ports)));
    });
  guideline
    .command('rollback')
    .description('return to the text of an earlier version, recorded as a new version')
    .argument('<version>', 'the version to return to', versionArgument)
    .action(async (version: number) => {
      deps.complete(await guidelineRollback(deps.ports, await pathsOf(deps.ports), version));
    });
};

const registerSecret: CommandGroup = (program, deps) => {
  const secret = program.command('secret').description('store the secrets that model servers refer to');
  secret
    .command('set <name>')
    .description('store a secret in the platform secret store; the value is read from the terminal')
    .action(async (name: string) => {
      deps.complete(await secretSet(deps.ports, await pathsOf(deps.ports), name, deps.interrupt));
    });
};

const YES_FLAG = '--yes';
const YES_HELP = 'write the change; without it the change is only shown';

const shellOf = async (deps: ProgramDeps): Promise<ModelsShell> => modelsShellOf(deps.ports, await pathsOf(deps.ports), deps.interrupt);

const formOf = (command: Command, deps: ProgramDeps, form: ModelsForm): Command =>
  command.action(async (...received: unknown[]) => {
    const args = received.slice(0, -2).filter((value): value is string => typeof value === 'string');
    deps.complete(await runModelsForm(await shellOf(deps), form, { args, options: command.opts<Record<string, FormOption>>() }));
  });

const registerModels: CommandGroup = (program, deps) => {
  const models = program
    .command('models')
    .enablePositionalOptions()
    .description('list the configured models with the capabilities they declare')
    .option('--json', 'print the models as JSON')
    .action(async (options: { json?: true }) => {
      deps.complete(await listModels(await shellOf(deps), { json: options.json === true }));
    });
  models
    .command('detect [url...]')
    .description('ask the usual local addresses, and any address you name, what model server answers there; nothing is written')
    .option('--json', 'print the servers as JSON')
    .action(async (typed: string[], options: { json?: true }) => {
      deps.complete(await detectModels(await shellOf(deps), { typed, json: options.json === true }));
    });
  models
    .command('check')
    .description('ask each configured server once whether it still lists its configured models, and list the models with the result')
    .option('--json', 'print the models as JSON')
    .action(async (options: { json?: true }) => {
      deps.complete(await checkModels(await shellOf(deps), { json: options.json === true }));
    });
  models
    .command('catalog [account]')
    .description('list the models of a signed-in subscription account, read again from the provider; the active account when only one could answer')
    .option('--json', 'print the catalog as JSON')
    .action(async (account: string | undefined, options: { json?: true }) => {
      deps.complete(await runModelsCatalog(deps.ports, await pathsOf(deps.ports), { json: options.json === true, ...(account === undefined ? {} : { account }) }));
    });
  formOf(
    models
      .command('add')
      .description('add a model of a model server found on this computer, of a server at an address, or of a signed-in subscription account')
      .option('--address <url>', 'the address of the model server; without it this computer is searched')
      .option('--model <own name>', 'the model, as the server calls it')
      .option('--window <tokens>', 'the context window of the model, when the server reports none')
      .option('--api <api>', 'the API of a server that is not recognised: ollama, openai, anthropic or responses')
      .option('--api-key-env <NAME>', 'the environment variable that holds the key of the server')
      .option('--api-key-secret <name>', 'the secret of momonga secret set that holds the key of the server')
      .option('--service <name>', 'the name of the service, used for prices (for example openai)')
      .option('--plan <profile>', 'add a model of a signed-in subscription account of this provider')
      .option('--account <label>', 'the account of --plan')
      .option(YES_FLAG, YES_HELP),
    deps,
    'add',
  );
  formOf(models.command('remove [model]').description('remove a model from the settings, with every setting that names it').option(YES_FLAG, YES_HELP), deps, 'remove');
  formOf(
    models
      .command('remove-server [server]')
      .description('remove a server and its models from the settings, with every setting that names them')
      .option('--forget-program', 'also forget the program the server runs')
      .option(YES_FLAG, YES_HELP),
    deps,
    'remove-server',
  );
  formOf(
    models.command('start [model]').description('choose the model new sessions start with').option('--clear', 'start with the first model in the settings').option(YES_FLAG, YES_HELP),
    deps,
    'start',
  );
  const fallback = models.command('fallback').description('the models tried in order when the model cannot answer');
  formOf(fallback.command('list').description('list the fallback models in order'), deps, 'fallback list');
  formOf(fallback.command('add [model]').description('add a fallback model').option('--position <n>', 'the position in the order; the end when omitted').option(YES_FLAG, YES_HELP), deps, 'fallback add');
  formOf(fallback.command('remove [model]').description('remove a fallback model').option(YES_FLAG, YES_HELP), deps, 'fallback remove');
  formOf(fallback.command('move [model]').description('move a fallback model to another position').option('--to <n>', 'the new position').option(YES_FLAG, YES_HELP), deps, 'fallback move');
  const billing = models.command('billing').description('the billing changes a request may make when it falls back');
  formOf(billing.command('list').description('list the allowed billing changes'), deps, 'billing list');
  formOf(billing.command('allow [from] [to]').description('allow requests to fall from one billing kind to another').option('--model <model>', 'only for this model').option(YES_FLAG, YES_HELP), deps, 'billing allow');
  formOf(billing.command('forbid [from] [to]').description('no longer allow requests to fall from one billing kind to another').option('--model <model>', 'only the rule for this model').option(YES_FLAG, YES_HELP), deps, 'billing forbid');
  const role = models.command('role').description('the model for summaries, reflection, analysis and the auto-mode classifier');
  formOf(role.command('list').description('list the model of each job'), deps, 'role list');
  formOf(role.command('set [job] [model]').description('choose the model of a job: compaction, reflection, analysis or classifier').option(YES_FLAG, YES_HELP), deps, 'role set');
  formOf(role.command('clear [job]').description('let a job use the model of the session').option(YES_FLAG, YES_HELP), deps, 'role clear');
  formOf(models.command('set [model] [field] [value]').description('set a field of a model, for example capabilities.contextWindow').option(YES_FLAG, YES_HELP), deps, 'set');
  formOf(models.command('unset [model] [field]').description('clear a field of a model').option(YES_FLAG, YES_HELP), deps, 'unset');
  formOf(models.command('set-server [server] [field] [value]').description('set a field of a server, for example billing').option(YES_FLAG, YES_HELP), deps, 'set-server');
  formOf(models.command('unset-server [server] [field]').description('clear a field of a server').option(YES_FLAG, YES_HELP), deps, 'unset-server');
  formOf(models.command('name [server] [name]').description('name a server').option('--clear', 'remove the name, so the server is named by what it is').option(YES_FLAG, YES_HELP), deps, 'name');
  formOf(
    models
      .command('add-program')
      .description('declare a program that MomongaCode starts as a model server, and add the model it serves')
      .option('--command <path>', 'the full path of the program')
      .option('--arg <text>', 'an argument of the program; repeat for several, and write {socket} where the program takes the path of its socket', collect, [])
      .option('--ready-path <path>', 'the path that answers when the program is ready, for example /health')
      .option('--name <name>', 'the name of the server; taken from the program when omitted')
      .option('--model <own name>', 'the model, as the server calls it; read from the server when omitted')
      .option(YES_FLAG, YES_HELP),
    deps,
    'add-program',
  );
  formOf(models.command('set-program [id] [field] [value]').description('change the command, args or readyPath of a declared program').option(YES_FLAG, YES_HELP), deps, 'set-program');
  formOf(models.command('forget-program [id]').description('forget a declared program that no server uses').option(YES_FLAG, YES_HELP), deps, 'forget-program');
  formOf(
    models
      .command('timeouts')
      .description('how long a request waits for the first reply and without any data; 0 never cuts')
      .option('--headers <minutes>', 'wait for the first reply')
      .option('--idle <minutes>', 'wait without any data')
      .option(YES_FLAG, YES_HELP),
    deps,
    'timeouts',
  );
  const dialects = models.command('dialects').description('the declared schema dialects');
  formOf(dialects.command('show').description('print the declared schema dialects as JSON'), deps, 'dialects show');
  formOf(dialects.command('set').description('replace the declared schema dialects with the object of a JSON file').option('--file <path>', 'the JSON file').option(YES_FLAG, YES_HELP), deps, 'dialects set');
};

const registerPolicy: CommandGroup = (program, deps) => {
  const policy = program.command('policy').description('check the permission rules of this folder');
  policy
    .command('verify')
    .description('prove that no allow rule gets around a deny rule, that no rule leaves a route to secrets, and that every rule can take effect; states what is proved and what is not')
    .option('--json', 'print the report as JSON')
    .addOption(new Option('--mode <mode>', 'the permission mode to check; the starting mode of the settings when omitted').choices(PERMISSION_MODES))
    .option('--secret <path>', 'a further secret location to keep out of reach; repeat for several', collect, [])
    .action(async (options: { json?: true; mode?: PermissionMode; secret: string[] }) => {
      deps.complete(
        await policyVerify(deps.ports, await pathsOf(deps.ports), await deps.policyVerify(), {
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
      deps.complete(await showStatus(deps.ports, await pathsOf(deps.ports), runId, options.json === true));
    });
  program
    .command('jobs [session-id]')
    .description('list the background jobs of a session, including those of its subagents; the newest session of this directory when no id is given')
    .option('--json', 'print the jobs as JSON')
    .action(async (sessionId: string | undefined, options: { json?: true }) => {
      deps.complete(await listJobs(deps.ports, await pathsOf(deps.ports), sessionId, options.json === true));
    });
};

export const PRODUCT_COMMAND_GROUPS: readonly CommandGroup[] = [registerElicit, registerMcp, registerAuth, registerRunTree, registerMemory, registerRule, registerCost, registerReliability, registerEvaluate, registerAutoMode, registerContext, registerSecret, registerModels, registerPolicy];

export const registerProductCommands = (program: Command, deps: ProgramDeps): void => {
  for (const group of PRODUCT_COMMAND_GROUPS) group(program, deps);
};
