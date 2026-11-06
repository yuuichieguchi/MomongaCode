import { nodeFileSystem } from '../node-file-system.ts';

export const RETRY_KINDS = ['guard', 'sweep', 'startup', 'shutdown'] as const;

export type RetryKind = (typeof RETRY_KINDS)[number];

export type AttemptRecord = { spent: Record<RetryKind, boolean>; ignored: boolean };

export const EMPTY_RECORD_TEXT = 'r00000\n';

const RECORD_FORM = /^r[01]{5}\n$/;
const IGNORED_POSITION = RETRY_KINDS.length + 1;

const allSpent = (): AttemptRecord => ({ spent: { guard: true, sweep: true, startup: true, shutdown: true }, ignored: false });

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
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'failed';
    }
  });

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
