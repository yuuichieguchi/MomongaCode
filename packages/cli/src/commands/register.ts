import type { Command } from 'commander';
import { Option } from 'commander';
import { MEMORY_SCOPES } from '@momonga/protocol';
import type { MemoryScope } from '@momonga/protocol';
import { pathsOf } from '../paths.ts';
import type { ProgramDeps } from '../program-deps.ts';
import { showCost } from './cost.ts';
import { elicit } from './elicit.ts';
import { evaluate } from './evaluate.ts';
import { mcpList, mcpLogin } from './mcp.ts';
import { memoryDelete, memoryList, memoryShow } from './memory.ts';
import { listJobs } from './jobs.ts';
import { listModels } from './models.ts';
import { showStatus } from './runs.ts';
import { secretSet } from './secret.ts';

export type CommandGroup = (program: Command, deps: ProgramDeps) => void;

const collect = (value: string, previous: readonly string[]): string[] => [...previous, value];

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
  const memory = program.command('memory').description('review and delete the memories the agent saved');
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
    .command('delete <id>')
    .description('delete a memory')
    .action(async (id: string) => {
      deps.complete(await memoryDelete(deps.ports, pathsOf(deps.ports), id));
    });
};

const registerCost: CommandGroup = (program, deps) => {
  program
    .command('cost [run-id]')
    .description('show the model cost of a run, of a session, or of the sessions of this folder')
    .option('--session <id>', 'the cost of one session')
    .option('--all', 'the cost of every session')
    .option('--json', 'print the report as JSON')
    .action(async (runId: string | undefined, options: { session?: string; all?: true; json?: true }) => {
      deps.complete(
        await showCost(deps.ports, pathsOf(deps.ports), {
          ...(runId === undefined ? {} : { runId }),
          ...(options.session === undefined ? {} : { session: options.session }),
          all: options.all === true,
          json: options.json === true,
        }),
      );
    });
};

const registerEvaluate: CommandGroup = (program, deps) => {
  program
    .command('eval <dataset>')
    .description('run a golden dataset against the daemon and report the pass rates')
    .option('--record <directory>', 'save the transcript of every run in this directory')
    .option('--replay <directory>', 'grade recorded transcripts instead of running the dataset')
    .action(async (dataset: string, options: { record?: string; replay?: string }) => {
      deps.complete(
        await evaluate(deps.ports, pathsOf(deps.ports), dataset, {
          ...(options.record === undefined ? {} : { record: options.record }),
          ...(options.replay === undefined ? {} : { replay: options.replay }),
        }),
      );
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

export const PRODUCT_COMMAND_GROUPS: readonly CommandGroup[] = [registerElicit, registerMcp, registerRunTree, registerMemory, registerCost, registerEvaluate, registerSecret, registerModels];

export const registerProductCommands = (program: Command, deps: ProgramDeps): void => {
  for (const group of PRODUCT_COMMAND_GROUPS) group(program, deps);
};
