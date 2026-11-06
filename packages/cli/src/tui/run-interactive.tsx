import { render } from 'ink';
import path from 'node:path';
import type { MomongaPaths } from '@momonga/foundation';
import { TARGET_NOT_READY } from '@momonga/protocol';
import { RunApiError } from '../client/runtime-client.ts';
import { describeFailure } from '../failure.ts';
import { noTargetLines } from '../readiness.ts';
import { createHistoryStore } from '../history-store.ts';
import type { CliPorts, Terminal } from '../ports.ts';
import type { SessionOptions } from '../run/open-session.ts';
import type { UpdateWiring } from '../update/background.ts';
import { App } from './app.tsx';
import type { TuiOutcome } from './app.tsx';
import type { AutoModePort, ShellPort } from './slash.ts';
import { autoModeCheck, autoModeCheckPortsOf, autoModeStatus, autoModeStatusPortsOf } from '../commands/auto-mode.ts';
import { createTuiBackend } from './backend.ts';
import { createBackgroundTasks } from './background-tasks.ts';
import { defaultNoticeSources } from './notices.ts';

export type InteractiveOptions = SessionOptions & { prompt?: string; skill?: string; images?: readonly string[] };

export const runInteractive = async (ports: CliPorts, paths: MomongaPaths, terminal: Terminal, options: InteractiveOptions, update: UpdateWiring, shell: ShellPort): Promise<number> => {
  const backend = createTuiBackend(ports, paths, options, createHistoryStore(ports.files, path.join(paths.state, 'history.jsonl')), defaultNoticeSources(ports, update));
  const tasks = createBackgroundTasks();
  const autoMode: AutoModePort = {
    check: async (checkOptions, write) => autoModeCheck(await autoModeCheckPortsOf(ports, write), checkOptions),
    status: async (statusOptions, write) => autoModeStatus(autoModeStatusPortsOf(ports, write), statusOptions),
  };
  let outcome: TuiOutcome = {};
  const onExit = (result: TuiOutcome): void => {
    outcome = result;
  };
  const instance = render(
    <App backend={backend} initialMode={options.permissionMode} startup={{ version: ports.version, home: ports.home, color: (ports.env['NO_COLOR'] ?? '') === '' }} {...(options.prompt === undefined ? {} : { initialPrompt: options.prompt })}
      {...(options.skill === undefined ? {} : { initialSkill: options.skill })}
      {...(options.images === undefined ? {} : { initialImages: options.images })}
      tasks={tasks}
      autoMode={autoMode}
      shell={shell}
      onExit={onExit}
    />,
    { stdin: terminal.stdin, stdout: terminal.stdout, exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  await tasks.settle();
  await backend.close();
  return exitCodeOf(ports, refusalOf(outcome, paths));
};

const refusalOf = (outcome: TuiOutcome, paths: MomongaPaths): TuiOutcome =>
  outcome.error instanceof RunApiError && outcome.error.code === TARGET_NOT_READY ? { ...outcome, error: new Error(noTargetLines(outcome.error.reason, paths).join('\n')) } : outcome;

export const exitCodeOf = (ports: Pick<CliPorts, 'stderr'>, outcome: TuiOutcome): number => {
  if (outcome.error === undefined) return 0;
  ports.stderr.write(`momonga: ${describeFailure(outcome.error)}\n`);
  return 1;
};
