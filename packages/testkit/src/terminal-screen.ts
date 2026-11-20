import xterm from '@xterm/headless';

export type TerminalCursor = { readonly row: number; readonly column: number };

export type TerminalScreen = {
  write(bytes: string | Uint8Array): Promise<void>;
  text(): string[];
  lineAt(row: number): string;
  inverseAt(row: number, column: number): boolean;
  everyLine(): string[];
  cursor(): TerminalCursor;
  onAnswer(listener: (answer: string) => void): void;
  dispose(): void;
};

const SCROLLBACK_LINES = 1000;

export const createTerminalScreen = ({ columns, rows }: { readonly columns: number; readonly rows: number }): TerminalScreen => {
  const terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: SCROLLBACK_LINES, convertEol: true });
  const bufferLine = (index: number): string => {
    const line = terminal.buffer.active.getLine(index);
    if (line === undefined) throw new Error(`the terminal buffer has no line ${index}; it has ${terminal.buffer.active.length}`);
    return line.translateToString(true);
  };
  const lineAt = (row: number): string => {
    if (row < 0 || row >= rows) throw new Error(`the terminal screen has no row ${row}; it has ${rows}`);
    return bufferLine(terminal.buffer.active.viewportY + row);
  };
  return {
    write: (bytes) => new Promise<void>((resolve) => terminal.write(bytes, resolve)),
    text: () => Array.from({ length: rows }, (_, row) => lineAt(row)),
    lineAt,
    inverseAt: (row, column) => (terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.getCell(column)?.isInverse() ?? 0) !== 0,
    everyLine: () => Array.from({ length: terminal.buffer.active.length }, (_, index) => bufferLine(index)),
    cursor: () => ({ row: terminal.buffer.active.cursorY, column: terminal.buffer.active.cursorX }),
    onAnswer: (listener) => {
      terminal.onData(listener);
    },
    dispose: () => terminal.dispose(),
  };
};
