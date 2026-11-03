import { escapeTerminalBlock } from '@momonga/protocol';
import type { CliPorts, Sink } from './ports.ts';

export const terminalSink = (target: () => Sink): Sink => ({ write: (text) => target().write(escapeTerminalBlock(text)) });

export const terminalPorts = (ports: CliPorts): CliPorts => ({
  ...ports,
  stdout: terminalSink(() => ports.stdout),
  stderr: terminalSink(() => ports.stderr),
});
