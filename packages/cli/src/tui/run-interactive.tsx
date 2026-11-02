import { render } from 'ink';
import path from 'node:path';
import type { MomongaPaths } from '@momonga/foundation';
import { describeFailure } from '../failure.ts';
import { createHistoryStore } from '../history-store.ts';
import type { CliPorts, Terminal } from '../ports.ts';
import type { SessionOptions } from '../run/open-session.ts';
import type { UpdateWiring } from '../update/background.ts';
import { App } from './app.tsx';
import type { TuiOutcome } from './app.tsx';
import { createTuiBackend } from './backend.ts';
import { defaultNoticeSources } from './notices.ts';

export type InteractiveOptions = SessionOptions & { prompt?: string; skill?: string; images?: readonly string[] };

export const runInteractive = async (ports: CliPorts, paths: MomongaPaths, terminal: Terminal, options: InteractiveOptions, update: UpdateWiring): Promise<number> => {
  const backend = createTuiBackend(ports, paths, options, createHistoryStore(ports.files, path.join(paths.state, 'history.jsonl')), defaultNoticeSources(ports, update));
  let outcome: TuiOutcome = {};
  const onExit = (result: TuiOutcome): void => {
    outcome = result;
  };
  const instance = render(
    <App backend={backend} initialMode={options.permissionMode} startup={{ version: ports.version, home: ports.home, color: (ports.env['NO_COLOR'] ?? '') === '' }} {...(options.prompt === undefined ? {} : { initialPrompt: options.prompt })}
      {...(options.skill === undefined ? {} : { initialSkill: options.skill })}
      {...(options.images === undefined ? {} : { initialImages: options.images })}
      onExit={onExit}
    />,
    { stdin: terminal.stdin, stdout: terminal.stdout, exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  await backend.close();
  return exitCodeOf(ports, outcome);
};

export const exitCodeOf = (ports: Pick<CliPorts, 'stderr'>, outcome: TuiOutcome): number => {
  if (outcome.error === undefined) return 0;
  ports.stderr.write(`momonga: ${describeFailure(outcome.error)}\n`);
  return 1;
};
