import type { CliPorts } from '../ports.ts';
import { escapedLines } from '../terminal-writer.ts';

export type StopNotice = (message: string) => void;

export const stderrStopNotice =
  (ports: Pick<CliPorts, 'stderr'>): StopNotice =>
  (message) =>
    void ports.stderr.write(`${escapedLines([`momonga: ${message}`])}\n`);
