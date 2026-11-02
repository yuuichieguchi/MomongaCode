import { render } from 'ink';
import type { MomongaPaths } from '@momonga/foundation';
import type { CliPorts, Terminal } from '../ports.ts';
import type { SessionOptions } from '../run/open-session.ts';
import { App } from './app.tsx';
import type { TuiOutcome } from './app.tsx';
import { createTuiBackend } from './backend.ts';

export type InteractiveOptions = SessionOptions & { prompt?: string };

export const runInteractive = async (ports: CliPorts, paths: MomongaPaths, terminal: Terminal, options: InteractiveOptions): Promise<number> => {
  const backend = createTuiBackend(ports, paths, options);
  let outcome: TuiOutcome = {};
  const onExit = (result: TuiOutcome): void => {
    outcome = result;
  };
  const instance = render(
    <App backend={backend} initialMode={options.permissionMode} {...(options.prompt === undefined ? {} : { initialPrompt: options.prompt })} onExit={onExit} />,
    { stdin: terminal.stdin, stdout: terminal.stdout, exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  await backend.close();
  if (outcome.error === undefined) return 0;
  ports.stderr.write(`momonga: ${outcome.error.message}\n`);
  return 1;
};
