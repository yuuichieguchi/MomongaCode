import { render } from 'ink';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { systemTiming } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { loadUserSettings, writeTuiSetting } from '@momonga/config';
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
import { createExternalEditor } from './external-editor.ts';
import { defaultNoticeSources } from './notices.ts';
import { MAX_FPS, SCREEN_SETTINGS } from './screen/constants.ts';
import { createScreenInput } from './screen/input.ts';
import { colorLevelOfDepth, noColorAsked } from './screen/theme.ts';
import { TerminalFrame } from './terminal/frame.tsx';
import { hostProcess, hostTerminalOutput } from './terminal/host.ts';
import { createInkStdin } from './terminal/ink-stdin.ts';
import { createTerminalLayer } from './terminal/layer.ts';
import type { TuiSettingsPort } from './screen/notify.ts';

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
  const tuiSettings: TuiSettingsPort = {
    initial: (await loadUserSettings({ home: paths.home })).settings.tui,
    save: (name, value, signal) => writeTuiSetting(paths.home, paths.settingsFile, name, value, { signal }),
  };
  const inkStdin = createInkStdin();
  const input = createScreenInput();
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
  const externalEditor = createExternalEditor({
    env: ports.env,
    temporaryDirectory: () => ports.files.mkdtemp(path.join(os.tmpdir(), 'momonga-draft-')),
    writePrivate: (file, text) => ports.files.writeTextAtomically(file, text, 0o600),
    read: (file) => ports.files.readText(file),
    remove: (directory) => ports.files.rm(directory, { recursive: true }),
    leaveScreen: layer.leaveForProgram,
    launch: launchOnTerminal,
  });
  const noColor = noColorAsked(ports.env);
  try {
    const instance = render(
      <TerminalFrame layer={layer}>
        <App backend={backend} terminal={{ state: layer.state, subscribe: layer.subscribe, subscribeScreen: layer.subscribeScreen, setScreen: layer.setScreen, setTitle: layer.setTitle, bell: layer.bell, enable: layer.enable, disable: layer.disable, input }} tuiSettings={tuiSettings} copyOnSelect={SCREEN_SETTINGS.copyOnSelect} now={() => ports.clock.now()} initialMode={options.permissionMode} startup={{ version: ports.version, home: ports.home, color: !noColor }} colour={{ noColor, level: colorLevelOfDepth(terminal.stdout.getColorDepth()) }} {...(options.prompt === undefined ? {} : { initialPrompt: options.prompt })}
          {...(options.skill === undefined ? {} : { initialSkill: options.skill })}
          {...(options.images === undefined ? {} : { initialImages: options.images })}
          tasks={tasks}
          timers={systemTiming}
          autoMode={autoMode}
          shell={shell}
          externalEditor={externalEditor}
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

const launchOnTerminal = (argv: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const [program, ...args] = argv;
    if (program === undefined) {
      reject(new Error('no program to launch'));
      return;
    }
    const child = spawn(program, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', () => resolve());
  });

const refusalOf = (outcome: TuiOutcome, paths: MomongaPaths): TuiOutcome =>
  outcome.error instanceof RunApiError && outcome.error.code === TARGET_NOT_READY ? { ...outcome, error: new Error(noTargetLines(outcome.error.reason, paths).join('\n')) } : outcome;

export const exitCodeOf = (ports: Pick<CliPorts, 'stderr'>, outcome: TuiOutcome): number => {
  if (outcome.error === undefined) return 0;
  ports.stderr.write(`momonga: ${describeFailure(outcome.error)}\n`);
  return 1;
};
