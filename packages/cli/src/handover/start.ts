import { EXIT_FAILURE } from '@momonga/foundation';
import type { KeptWork } from '@momonga/protocol';
import type { SelfExecutable, Sink } from '../ports.ts';
import { HANDOVER_TERMINAL_ENV } from '../tui/terminal/constants.ts';
import { handoverTerminalValue, takeHandoverTerminal } from '../tui/terminal/handover.ts';
import type { HandoverTerminal } from '../tui/terminal/layer.ts';
import { LEAVE_EVERY_MODE, leaveSequenceOf } from '../tui/terminal/modes.ts';
import { parseRecord } from './record.ts';
import type { HandoverKind, HandoverRecord, ParsedRecord } from './record.ts';
import type { ReplaceTarget } from './replace-process.ts';
import { keptWorkOf, restoreRefusedText } from './texts.ts';

export const HANDOVER_FLAG = '--handover';

export type HandoverStart = { file: string; parsed: ParsedRecord; terminal: HandoverTerminal | undefined };

export type TakenStart = { args: string[]; started: HandoverStart | undefined };

const readRecord = (file: string, read: (file: string) => string): ParsedRecord => {
  let text: string;
  try {
    text = read(file);
  } catch (error) {
    return { kind: 'refused', reason: `the record could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  return parseRecord(text);
};

export const takeHandoverStart = (args: readonly string[], env: Record<string, string | undefined>, read: (file: string) => string): TakenStart => {
  const terminal = takeHandoverTerminal(env);
  const at = args.indexOf(HANDOVER_FLAG);
  const file = at === -1 ? undefined : args[at + 1];
  if (at === -1 || file === undefined) return { args: [...args], started: undefined };
  return { args: [...args.slice(0, at), ...args.slice(at + 2)], started: { file, parsed: readRecord(file, read), terminal } };
};

export type Refusal = { reason: string; kept: KeptWork; terminal: HandoverTerminal | undefined };

export type Adoption<K extends HandoverKind> = { kind: 'none' } | { kind: 'record'; record: Extract<HandoverRecord, { kind: K }>; file: string } | ({ kind: 'refused' } & Refusal);

const KIND_NAMES: Readonly<Record<HandoverKind, string>> = { tui: 'an interactive', acp: 'an ACP', attach: 'an attach', headless: 'a headless' };

const isOfKind = <K extends HandoverKind>(record: HandoverRecord, kinds: readonly K[]): record is Extract<HandoverRecord, { kind: K }> => kinds.some((kind) => kind === record.kind);

export const adoptionOf = <K extends HandoverKind>(started: HandoverStart | undefined, kinds: readonly K[]): Adoption<K> => {
  if (started === undefined) return { kind: 'none' };
  const { parsed, terminal, file } = started;
  if (parsed.kind === 'refused') return { kind: 'refused', reason: parsed.reason, kept: { kind: 'unnamed' }, terminal };
  if (!isOfKind(parsed.record, kinds)) return { kind: 'refused', reason: `the record is of ${KIND_NAMES[parsed.record.kind]} session`, kept: keptWorkOf(parsed.record), terminal };
  return { kind: 'record', record: parsed.record, file };
};

export type Invocation = { self: SelfExecutable; execArgv: readonly string[]; args: readonly string[]; env: Readonly<Record<string, string | undefined>> };

export const handoverTarget = ({ self, execArgv, args, env }: Invocation, recordFile: string, terminal: HandoverTerminal | undefined): ReplaceTarget => ({
  file: self.execPath,
  args: [...(self.kind === 'script' ? [...execArgv, self.script] : []), ...args, HANDOVER_FLAG, recordFile],
  env: { ...env, ...(terminal === undefined ? {} : { [HANDOVER_TERMINAL_ENV]: handoverTerminalValue(terminal) }) },
});

export type RefusalIo = { stderr: Sink; terminal?: { output: { writeSync(text: string): void }; input: { setRawMode(on: boolean): unknown } } };

export const refuseStart = (io: RefusalIo, refusal: Refusal): number => {
  if (io.terminal !== undefined) {
    const leave = refusal.terminal === undefined ? LEAVE_EVERY_MODE : leaveSequenceOf(refusal.terminal.modes);
    if (leave !== '') io.terminal.output.writeSync(leave);
    io.terminal.input.setRawMode(false);
  }
  io.stderr.write(`momonga: ${restoreRefusedText(refusal)}\n`);
  return EXIT_FAILURE;
};
