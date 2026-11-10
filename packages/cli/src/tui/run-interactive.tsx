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
import { MAX_FPS, SCREEN_SETTINGS } from './screen/constants.ts';
import { createScreenInput } from './screen/input.ts';
import { TerminalFrame } from './terminal/frame.tsx';
import { hostProcess, hostTerminalOutput } from './terminal/host.ts';
import { inkInputOf } from './terminal/ink-bridge.ts';
import { createInkStdin } from './terminal/ink-stdin.ts';
import { createTerminalLayer } from './terminal/layer.ts';

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
  const inkStdin = createInkStdin();
  const input = createScreenInput((events) => inkStdin.push(inkInputOf(events)));
  const layer = createTerminalLayer({
    input: terminal.stdin,
    output: hostTerminalOutput(terminal.stdout),
    process: hostProcess,
    screen: SCREEN_SETTINGS.screen,
    screenSetByUser: false,
    mouse: SCREEN_SETTINGS.mouse,
    onEvents: input.push,
  });
  layer.start();
  try {
    const instance = render(
      <TerminalFrame layer={layer}>
        <App backend={backend} terminal={{ state: layer.state, subscribe: layer.subscribe, subscribeScreen: layer.subscribeScreen, setScreen: layer.setScreen, input }} copyOnSelect={SCREEN_SETTINGS.copyOnSelect} now={() => ports.clock.now()} initialMode={options.permissionMode} startup={{ version: ports.version, home: ports.home, color: (ports.env['NO_COLOR'] ?? '') === '' }} {...(options.prompt === undefined ? {} : { initialPrompt: options.prompt })}
          {...(options.skill === undefined ? {} : { initialSkill: options.skill })}
          {...(options.images === undefined ? {} : { initialImages: options.images })}
          tasks={tasks}
          autoMode={autoMode}
          shell={shell}
          onExit={onExit}
        />
      </TerminalFrame>,
      { stdin: inkStdin.stream, stdout: terminal.stdout, exitOnCtrlC: false, maxFps: MAX_FPS, incrementalRendering: true },
    );
    await instance.waitUntilExit();
  } finally {
    layer.close();
  }
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
