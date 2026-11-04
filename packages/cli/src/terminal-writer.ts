import { escapeTerminalBlock, escapeTerminalLine } from '@momonga/protocol';
import type { CliPorts, Sink } from './ports.ts';

export const terminalSink = (target: () => Sink): Sink => ({ write: (text) => target().write(escapeTerminalBlock(text)) });

export const escapedLines = (lines: readonly string[]): string => lines.map(escapeTerminalLine).join('\n');

export const terminalPorts = (ports: CliPorts): CliPorts => ({
  ...ports,
  stdout: terminalSink(() => ports.stdout),
  stderr: terminalSink(() => ports.stderr),
});
