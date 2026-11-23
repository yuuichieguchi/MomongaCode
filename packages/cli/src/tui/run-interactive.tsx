import { synchronizedFramesOf } from './terminal/synchronized.ts';
import { render } from 'ink';
import path from 'node:path';
import { ABORT_SETTLE_LIMIT_MS, resolveLayoutLocks, sleep } from '@momonga/foundation';
import type { Timing } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { writeTuiSetting } from '@momonga/config';
import { TARGET_NOT_READY, reopenSessionCommand } from '@momonga/protocol';
import { RunApiError } from '../client/runtime-client.ts';
import { describeFailure } from '../failure.ts';
import { createHistoryStore } from '../history-store.ts';
import type { CliPorts, Terminal } from '../ports.ts';
import type { RunBounds, SessionOptions } from '../run/open-session.ts';
import type { Reopen } from '../run/resolve-session.ts';
import type { UpdateWiring } from '../update/background.ts';
import { App } from './app.tsx';
import type { TuiOutcome } from './app.tsx';
import type { AutoModePort, ShellPort } from './slash.ts';
import { autoModeCheck, autoModeCheckPortsOf, autoModeStatus, autoModeStatusPortsOf } from '../commands/auto-mode.ts';
import { createTuiBackend } from './backend.ts';
import { createBackgroundTasks } from './background-tasks.ts';
import { terminalExternalEditor } from './external-editor.ts';
import { createKeyBindings } from './keys/store.ts';
import { a11yOf } from './screen/a11y.ts';
import type { AskedA11y } from './screen/a11y.ts';
import { shortenHome } from './startup.tsx';
import { defaultNoticeSources } from './notices.ts';
import { MAX_FPS } from './screen/constants.ts';
import { createScreenInput } from './screen/input.ts';
import { colorLevelOfDepth, noColorAsked } from './screen/theme.ts';
import { TerminalFrame } from './terminal/frame.tsx';
import { hostProcessOn, hostTerminalOutput, launchOnTerminal, NO_DESCRIPTOR_TEXT } from './terminal/host.ts';
import { createInkStdin } from './terminal/ink-stdin.ts';
import { createTerminalLayer } from './terminal/layer.ts';
import type { TerminalOutputPort } from './terminal/layer.ts';
import { RepairFlow } from './screen/repair.tsx';
import type { RepairOutcome } from './screen/repair.tsx';
import { readTuiStart, setByPerson } from './tui-start-settings.ts';
import type { TuiStart } from './tui-start-settings.ts';
import { DEFAULT_KEY_TABLE } from './keys/table.ts';
import type { HandoverTerminal, TerminalLayer } from './terminal/layer.ts';
import type { NegotiationState } from './terminal/negotiation.ts';
import { startWithHandoverTerminal } from './terminal/handover.ts';
import { insideTmux, showsOsc9Notifications } from './terminal/terminal-name.ts';
import { orderVersions, readCurrentGeneration } from '@momonga/foundation';
import { HANDOVER_FORMAT, recordFileOf } from '../handover/record.ts';
import { adoptionOf, refuseStart } from '../handover/start.ts';
import type { TuiAdoption, TuiMovePort, TuiSurface } from './handover.ts';
import type { TuiSettingsPort } from './screen/notify.ts';

export type InteractiveOptions = SessionOptions & RunBounds & { prompt?: string; skill?: string; images?: readonly string[]; reopen?: Reopen; screenReader?: boolean };

const newerCurrentVersion = async (ports: Pick<CliPorts, 'version'>, paths: MomongaPaths): Promise<string | undefined> => {
  const current = await readCurrentGeneration(paths);
  return current !== undefined && orderVersions(ports.version, current.version) === 'older' ? current.version : undefined;
};

type MoveWiring = { port: TuiMovePort; detach(): void };

const NO_MOVE: MoveWiring = { port: { attach: () => () => undefined, check: () => undefined, probe: () => undefined }, detach: () => undefined };

const wireMove = (ports: CliPorts, paths: MomongaPaths, terminal: Terminal, layer: TerminalLayer, report: (error: unknown) => void): MoveWiring => {
  const mover = ports.handover?.mover;
  if (mover === undefined) return NO_MOVE;
  let surface: TuiSurface | undefined;
  let released: { terminal: HandoverTerminal; negotiation: NegotiationState } | undefined;
  let probing = false;
  const attached = (): TuiSurface => {
    if (surface === undefined) throw new Error('the interface has attached no surface to move');
    return surface;
  };
  const detach = mover.attach({
    surface: 'tui',
    kept: () => {
      const session = surface?.session();
      return { kind: 'sessions', sessionIds: session === undefined ? [] : [session] };
    },
    recordFile: () => {
      const session = surface?.session();
      return session === undefined ? undefined : recordFileOf(paths, 'tui', session);
    },
    quiet: (own) => surface?.quiet(own) === true,
    snapshot: (toVersion) => {
      const snapshot = attached().snapshot();
      if (snapshot === undefined) throw new Error('the interface has no open session to move');
      return { format: HANDOVER_FORMAT, fromVersion: ports.version, toVersion, ...snapshot };
    },
    terminal: () => released?.terminal ?? layer.handoverTerminal(),
    suspend: () => attached().suspend(),
    release: () => {
      released = { terminal: layer.handoverTerminal(), negotiation: layer.state().negotiation };
      layer.release();
    },
    resume: () => {
      if (released !== undefined) {
        layer.adopt(released.terminal, released.negotiation);
        released = undefined;
      }
      attached().resume();
    },
    say: (text) => attached().say(text),
  });
  const probe = async (): Promise<void> => {
    probing = true;
    try {
      const newer = await newerCurrentVersion(ports, paths);
      if (newer !== undefined) await mover.learned(newer, 'live');
    } finally {
      probing = false;
    }
  };
  return {
    port: {
      attach: (next) => {
        surface = next;
        return () => {
          if (surface === next) surface = undefined;
        };
      },
      check: () => {
        mover.check().catch(report);
      },
      probe: () => {
        if (!probing) probe().catch(report);
      },
    },
    detach,
  };
};

export const runInteractive = async (ports: CliPorts, paths: MomongaPaths, terminal: Terminal, options: InteractiveOptions, update: UpdateWiring, shell: ShellPort): Promise<number> => {
  const output = hostTerminalOutput(terminal.stdout);
  if (output.kind === 'no-descriptor') {
    ports.stderr.write(`momonga: ${NO_DESCRIPTOR_TEXT}\n`);
    return 1;
  }
  const adoption = adoptionOf(ports.handover?.started, ['tui']);
  if (adoption.kind === 'refused') return refuseStart({ stderr: ports.stderr, terminal: { output: output.port, input: terminal.stdin } }, adoption);
  const backend = createTuiBackend(ports, paths, options, createHistoryStore(ports.files, path.join(paths.state, 'history.jsonl')), defaultNoticeSources(ports, update));
  const tasks = createBackgroundTasks();
  const autoMode: AutoModePort = {
    check: async (checkOptions, write) => autoModeCheck(await autoModeCheckPortsOf(ports, write, checkOptions.signal), checkOptions),
    status: async (statusOptions, write) => autoModeStatus(await autoModeStatusPortsOf(ports, write, statusOptions.signal), statusOptions),
  };
  let outcome: TuiOutcome = {};
  const onExit = (result: TuiOutcome): void => {
    outcome = result;
  };
  const readStart = (): Promise<TuiStart> => readTuiStart({ env: ports.env, home: paths.home, projectDir: ports.cwd, userFile: paths.settingsFile, signal: ports.interrupt, isTrusted: async () => (await backend.boot()).decision === 'trusted' });
  const firstStart = await readStart();
  const start = firstStart.kind === 'loaded' ? firstStart : await repairedStart(ports, terminal, output.port, firstStart, readStart);
  if (start === undefined) {
    ports.stderr.write(`momonga: ${firstStart.kind === 'broken' ? firstStart.message : ''}\n`);
    return 1;
  }
  const tuiSettings: TuiSettingsPort = {
    initial: start.settings,
    save: (name, value, signal) => writeTuiSetting(paths.home, paths.settingsFile, name, value, { lock: resolveLayoutLocks(paths).mechanism, signal }),
  };
  const asked: AskedA11y = { screenReaderFlag: options.screenReader === true, env: ports.env };
  const readerAtStart = a11yOf(tuiSettings.initial, asked).screenReader;
  const keyBindings = createKeyBindings({
    file: paths.keybindingsFile,
    shownFile: shortenHome(paths.keybindingsFile, paths.home),
    files: {
      stat: async (file) => ((await ports.files.exists(file)) ? ports.files.stat(file) : undefined),
      read: (file) => ports.files.readText(file),
      write: (file, text, mode) => ports.files.writeTextAtomically(file, text, mode),
    },
  });
  await keyBindings.load();
  const inkStdin = createInkStdin();
  const moveFailures: unknown[] = [];
  const input = createScreenInput();
  const layer = createTerminalLayer({
    input: terminal.stdin,
    output: output.port,
    process: hostProcessOn(ports.platform),
    timers: ports.timers,
    screen: readerAtStart ? 'scrollback' : tuiSettings.initial.screen,
    screenSetByUser: readerAtStart || setByPerson(start, 'screen'),
    mouse: tuiSettings.initial.mouse,
    onEvents: input.push,
    onArrival: input.arrived,
    onFailure: (error) => moveFailures.push(error),
  });
  if (adoption.kind === 'record') startWithHandoverTerminal(layer, ports.handover?.started?.terminal, adoption.record.neg);
  else layer.start();
  const moving = wireMove(ports, paths, terminal, layer, (error) => moveFailures.push(error));
  const adopted: { adoption?: TuiAdoption } = adoption.kind === 'record' ? { adoption: { record: adoption.record, attached: () => ports.handover?.removeRecord(adoption.file) } } : {};
  const externalEditor = terminalExternalEditor(ports, layer, launchOnTerminal);
  const noColor = noColorAsked(ports.env);
  try {
    const instance = render(
      <TerminalFrame layer={layer}>
        <App backend={backend} terminal={{ state: layer.state, subscribe: layer.subscribe, subscribeScreen: layer.subscribeScreen, setScreen: layer.setScreen, setTitle: layer.setTitle, bell: layer.bell, desktopNotification: layer.desktopNotification, enable: layer.enable, disable: layer.disable, input }} tuiSettings={tuiSettings} attentionTerminal={{ osc9: showsOsc9Notifications(ports.env), tmux: insideTmux(ports.env) }} move={moving.port} {...adopted} keyBindings={keyBindings} a11y={asked} copyOnSelect={tuiSettings.initial.copyOnSelect} now={() => ports.clock.now()} initialMode={options.permissionMode} startup={{ version: ports.version, home: ports.home }} colour={{ noColor, level: colorLevelOfDepth(terminal.stdout.getColorDepth()) }} {...(options.prompt === undefined ? {} : { initialPrompt: options.prompt })}
          {...(options.skill === undefined ? {} : { initialSkill: options.skill })}
          {...(options.images === undefined ? {} : { initialImages: options.images })}
          {...(options.reopen === undefined ? {} : { reopen: options.reopen })}
          tasks={tasks}
          timers={ports.timers}
          autoMode={autoMode}
          shell={shell}
          externalEditor={externalEditor}
          onExit={onExit}
        />
      </TerminalFrame>,
      { stdin: inkStdin.stream, stdout: synchronizedFramesOf(terminal.stdout, () => layer.state().synchronizedOutput), exitOnCtrlC: false, maxFps: MAX_FPS, incrementalRendering: true, onRender: () => input.framed() },
    );
    await instance.waitUntilExit();
  } finally {
    moving.detach();
    await layer.close();
  }
  const [moveFailure] = moveFailures;
  if (moveFailure !== undefined) throw moveFailure;
  await settledWithin(ports.timers, tasks.settle(), ABORT_SETTLE_LIMIT_MS);
  await backend.close();
  const exitCode = exitCodeOf(ports, refusalOf(outcome));
  writeReopenLine(ports, outcome);
  return exitCode;
};

const settledWithin = async (timers: Pick<Timing, 'setTimeout' | 'clearTimeout'>, pending: Promise<void>, limitMs: number): Promise<void> => {
  const bound = new AbortController();
  try {
    await Promise.race([pending, sleep(timers, limitMs, bound.signal)]);
  } finally {
    bound.abort();
  }
};

const repairedStart = async (ports: CliPorts, terminal: Terminal, output: TerminalOutputPort, first: Extract<TuiStart, { kind: 'broken' }>, reread: () => Promise<TuiStart>): Promise<Extract<TuiStart, { kind: 'loaded' }> | undefined> => {
  const failures: unknown[] = [];
  const input = createScreenInput();
  const layer = createTerminalLayer({ input: terminal.stdin, output, process: hostProcessOn(ports.platform), timers: ports.timers, screen: 'scrollback', screenSetByUser: true, mouse: false, onEvents: input.push, onFailure: (error) => failures.push(error) });
  layer.start();
  const editor = terminalExternalEditor(ports, layer, launchOnTerminal);
  const outcome = Promise.withResolvers<RepairOutcome>();
  try {
    const instance = render(
      <TerminalFrame layer={layer}>
        <RepairFlow first={first} input={input} keys={DEFAULT_KEY_TABLE} open={editor.open} reread={reread} done={outcome.resolve} failed={outcome.reject} />
      </TerminalFrame>,
      { stdin: createInkStdin().stream, stdout: synchronizedFramesOf(terminal.stdout, () => layer.state().synchronizedOutput), exitOnCtrlC: false, maxFps: MAX_FPS, onRender: () => input.framed() },
    );
    const answer = await outcome.promise;
    instance.unmount();
    await instance.waitUntilExit();
    const [failure] = failures;
    if (failure !== undefined) throw failure;
    return answer.kind === 'loaded' ? answer.start : undefined;
  } finally {
    await layer.close();
  }
};

const refusalOf = (outcome: TuiOutcome): TuiOutcome =>
  outcome.error instanceof RunApiError && outcome.error.code === TARGET_NOT_READY ? { ...outcome, error: new Error(outcome.error.reason) } : outcome;

export const exitCodeOf = (ports: Pick<CliPorts, 'stderr'>, outcome: TuiOutcome): number => {
  if (outcome.error === undefined) return 0;
  ports.stderr.write(`momonga: ${describeFailure(outcome.error)}\n`);
  return 1;
};

export const writeReopenLine = (ports: Pick<CliPorts, 'stdout'>, outcome: TuiOutcome): void => {
  if (outcome.reopen !== undefined) ports.stdout.write(`${reopenSessionCommand(outcome.reopen)}\n`);
};
