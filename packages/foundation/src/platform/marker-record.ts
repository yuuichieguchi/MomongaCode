import { nodeFileSystem } from '../node-file-system.ts';
import { KEEPER_NAME_BYTES } from '../process-contract.ts';
import { hostProcessGroupPort } from './group-port.ts';
import type { GroupNames } from './group-port.ts';

export const RETRY_KINDS = ['guard', 'sweep', 'startup', 'shutdown'] as const;

export type RetryKind = (typeof RETRY_KINDS)[number];

export type AttemptRecord = { spent: Record<RetryKind, boolean>; ignored: boolean };

export const EMPTY_RECORD_TEXT = 'r00000\n';

const GROUP_DIGITS = 10;
const GROUP_POSITION = EMPTY_RECORD_TEXT.length;
const NAME_LINE = `j([0-9a-f]{${KEEPER_NAME_BYTES * 2}})\\n`;
const RECORD_FORM = new RegExp(`^r[01]{5}\\n(g\\d{${GROUP_DIGITS}}\\n(${NAME_LINE})?)?$`);
const GROUP_FORM = new RegExp(`^r[01]{5}\\ng(\\d{${GROUP_DIGITS}})\\n(?:${NAME_LINE})?$`);
const IGNORED_POSITION = RETRY_KINDS.length + 1;

const allSpent = (): AttemptRecord => ({ spent: { guard: true, sweep: true, startup: true, shutdown: true }, ignored: false });

export const isMalformedRecord = (text: string): boolean => text !== '' && !RECORD_FORM.test(text);

export const readRecordText = (marker: string, { files = nodeRecordFiles }: { files?: RecordFiles } = {}): Promise<string> => files.read(marker);

export const parseAttemptRecord = (text: string): AttemptRecord => {
  if (text === '') return { spent: { guard: false, sweep: false, startup: false, shutdown: false }, ignored: false };
  if (!RECORD_FORM.test(text)) return allSpent();
  return {
    spent: { guard: text[1] === '1', sweep: text[2] === '1', startup: text[3] === '1', shutdown: text[4] === '1' },
    ignored: text[IGNORED_POSITION] === '1',
  };
};

const recordText = (record: AttemptRecord): string => `r${RETRY_KINDS.map((kind) => (record.spent[kind] ? '1' : '0')).join('')}${record.ignored ? '1' : '0'}\n`;

export type RecordFiles = {
  read(file: string): Promise<string>;
  writeByte(file: string, position: number, byte: string): Promise<void>;
};

export const nodeRecordFiles: RecordFiles = {
  read: (file) => nodeFileSystem.readTextFile(file),
  writeByte: (file, position, byte) => nodeFileSystem.writeByteAt(file, position, byte),
};

export type RecordOptions = { signal: AbortSignal; files?: RecordFiles };

export const readAttemptRecord = async (marker: string, { files = nodeRecordFiles }: { files?: RecordFiles } = {}): Promise<AttemptRecord> => parseAttemptRecord(await files.read(marker));

const queues = new Map<string, Promise<unknown>>();

const singleFlight = <T>(marker: string, task: () => Promise<T>): Promise<T> => {
  const previous = queues.get(marker) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(marker, tail);
  void tail.then(() => {
    if (queues.get(marker) === tail) queues.delete(marker);
  });
  return next;
};

export type ClaimOutcome = 'claimed' | 'spent' | 'failed' | 'absent';

export const claimRetry = (marker: string, kind: RetryKind, { signal, files = nodeRecordFiles }: RecordOptions): Promise<ClaimOutcome> =>
  singleFlight(marker, async () => {
    if (signal.aborted) return 'failed';
    try {
      const text = await files.read(marker);
      const record = parseAttemptRecord(text);
      if (record.spent[kind]) return 'spent';
      if (text === '') {
        await files.writeByte(marker, 0, recordText({ ...record, spent: { ...record.spent, [kind]: true } }));
        return 'claimed';
      }
      await files.writeByte(marker, RETRY_KINDS.indexOf(kind) + 1, '1');
      return 'claimed';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
      throw error;
    }
  });

export type ReturnOutcome = 'returned' | 'absent';

export const returnRetry = (marker: string, kind: RetryKind, { files = nodeRecordFiles }: { files?: RecordFiles } = {}): Promise<ReturnOutcome> =>
  singleFlight(marker, async () => {
    let text: string;
    try {
      text = await files.read(marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
      throw error;
    }
    if (text === '' || !RECORD_FORM.test(text)) throw new Error(`the marker ${marker} holds no attempt record its ${kind} chance can be returned to`);
    await files.writeByte(marker, RETRY_KINDS.indexOf(kind) + 1, '0');
    return 'returned';
  });

const groupText = (pgid: number, name: string | undefined): string => `g${String(pgid).padStart(GROUP_DIGITS, '0')}\n${name === undefined ? '' : `j${name}\n`}`;

export type RecordGroupOptions = { files?: RecordFiles; names?: GroupNames | undefined };

export const recordMarkerGroup = (marker: string, pgid: number, { files = nodeRecordFiles, names = hostProcessGroupPort().names }: RecordGroupOptions = {}): Promise<void> =>
  singleFlight(marker, async () => {
    if (!Number.isInteger(pgid) || pgid <= 0 || String(pgid).length > GROUP_DIGITS) throw new RangeError(`process group ${pgid} cannot be recorded in a marker`);
    const recorded = groupText(pgid, names?.nameOf(pgid));
    const text = await files.read(marker);
    if (text === '') {
      await files.writeByte(marker, 0, `${EMPTY_RECORD_TEXT}${recorded}`);
      return;
    }
    if (!RECORD_FORM.test(text)) throw new Error(`the marker ${marker} holds no attempt record the group can follow`);
    await files.writeByte(marker, GROUP_POSITION, recorded);
  });

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const groupRecordNotice = (marker: string, error: unknown): string =>
  `the process group of the marker ${marker} could not be recorded: ${reasonOf(error)}; later checks of this marker cannot tell whether its processes still run`;

export const unreadableMarkerNotice = (marker: string, error: unknown): string => `the marker ${marker} could not be read: ${reasonOf(error)}; it was left in place`;

export const groupRecordOutcome = (recording: Promise<void>, marker: string): Promise<string | undefined> =>
  recording.then(
    () => undefined,
    (error: unknown) => groupRecordNotice(marker, error),
  );

export const parseRecordedGroup = (text: string): number | undefined => {
  const found = GROUP_FORM.exec(text);
  return found === null ? undefined : Number(found[1]);
};

export const parseRecordedGroupName = (text: string): string | undefined => GROUP_FORM.exec(text)?.[2];

export const readMarkerGroup = async (marker: string, { files = nodeRecordFiles }: { files?: RecordFiles } = {}): Promise<number | undefined> => parseRecordedGroup(await files.read(marker));

export const markIgnored = (marker: string, { files = nodeRecordFiles }: RecordOptions): Promise<void> =>
  singleFlight(marker, async () => {
    const text = await files.read(marker);
    if (text === '' || !RECORD_FORM.test(text)) {
      const record = parseAttemptRecord(text);
      await files.writeByte(marker, 0, recordText({ ...record, ignored: true }));
      return;
    }
    await files.writeByte(marker, IGNORED_POSITION, '1');
  });
