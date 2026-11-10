import { createInterface } from 'node:readline/promises';
import { escapeTerminalLine } from '@momonga/protocol';
import type { Terminal } from '../ports.ts';

export const terminalChoice =
  (terminal: Terminal, signal: AbortSignal) =>
  async (question: string, choices: readonly string[]): Promise<number | undefined> => {
    const lines = createInterface({ input: terminal.stdin, output: terminal.stdout });
    try {
      terminal.stdout.write(`${[escapeTerminalLine(question), ...choices.map((choice, index) => `  ${index + 1}. ${escapeTerminalLine(choice)}`)].join('\n')}\n`);
      const answer = (await lines.question(`1-${choices.length}, or empty to cancel: `, { signal })).trim();
      if (answer === '') return undefined;
      const index = Number(answer) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= choices.length) throw new Error(`${JSON.stringify(answer)} is not one of 1-${choices.length}`);
      return index;
    } finally {
      lines.close();
    }
  };
