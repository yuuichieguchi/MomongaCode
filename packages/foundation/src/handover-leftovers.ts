import path from 'node:path';
import { isAtomicWriteTemporary } from './atomic-file.ts';
import { isRecord } from './json.ts';
import { JsonDepthError, parseOutsideJson } from './json-depth.ts';
import type { LeftoverDirectory, Retention } from './leftover-sweep.ts';
import { OPEN_FLAGS } from './node-file-system.ts';
import type { FileSystem, ReadHandle } from './node-file-system.ts';
import { isErrno } from './platform/inspector-types.ts';
import { probeReader } from './process-alive.ts';
import type { NamedReader } from './process-alive.ts';

export const HANDOVER_DIRECTORY = 'handover';
export const HANDOVER_RECORD_SUFFIX = '.json';
export const HANDOVER_RECORD_MAX_BYTES = 1024 * 1024;
export const HANDOVER_RECORD_OWNER_FIELD = 'pid';
export const HANDOVER_RECORD_READER_FIELD = 'reader';
export const HANDOVER_RECORD_NAMESPACE_FIELD = 'namespace';

export type HandoverRecordParties = { readonly writer: number; readonly reader: number; readonly namespace: string };

export const handoverRecordFields = ({ writer, reader, namespace }: HandoverRecordParties): Record<string, number | string> => ({
  [HANDOVER_RECORD_OWNER_FIELD]: writer,
  [HANDOVER_RECORD_READER_FIELD]: reader,
  [HANDOVER_RECORD_NAMESPACE_FIELD]: namespace,
});

export const handoverDirectoryOf = (paths: { readonly run: string }): string => path.join(paths.run, HANDOVER_DIRECTORY);

const isRecordName = (name: string): boolean => name.endsWith(HANDOVER_RECORD_SUFFIX);

const jsonOf = (text: string): unknown => {
  try {
    return parseOutsideJson(text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof JsonDepthError) return undefined;
    throw error;
  }
};

const pidOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined);

export const handoverRecordOwner = (text: string): number | undefined => {
  const parsed = jsonOf(text);
  return isRecord(parsed) ? pidOf(parsed[HANDOVER_RECORD_OWNER_FIELD]) : undefined;
};

export const handoverRecordReader = (text: string): NamedReader | undefined => {
  const parsed = jsonOf(text);
  if (!isRecord(parsed)) return undefined;
  const pid = pidOf(parsed[HANDOVER_RECORD_READER_FIELD]);
  const namespace = parsed[HANDOVER_RECORD_NAMESPACE_FIELD];
  return pid === undefined || typeof namespace !== 'string' || namespace === '' ? undefined : { pid, namespace };
};

const boundedTextOf = async (handle: ReadHandle): Promise<string | undefined> => {
  const buffer = new Uint8Array(HANDOVER_RECORD_MAX_BYTES + 1);
  let filled = 0;
  for (;;) {
    const count = await handle.read(buffer.subarray(filled));
    if (count === 0) return Buffer.from(buffer.buffer, 0, filled).toString('utf8');
    filled += count;
    if (filled > HANDOVER_RECORD_MAX_BYTES) return undefined;
  }
};

const textOfRecord = async (files: Pick<FileSystem, 'openRead'>, file: string): Promise<string | undefined> => {
  let handle: ReadHandle;
  try {
    handle = await files.openRead(file, OPEN_FLAGS.readOnly | OPEN_FLAGS.noFollow);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    return await boundedTextOf(handle);
  } finally {
    await handle.close();
  }
};

type RecordRead = { kind: 'read'; text: string | undefined } | { kind: 'unreadable'; code: string };

const recordRead = async (files: Pick<FileSystem, 'openRead'>, file: string): Promise<RecordRead> => {
  try {
    return { kind: 'read', text: await textOfRecord(files, file) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (typeof code !== 'string') throw error;
    return { kind: 'unreadable', code };
  }
};

export type HandoverLeftoverPorts = {
  readonly files: Pick<FileSystem, 'openRead'>;
  readonly namespace: string;
  alive(pid: number): boolean;
};

const FREE: Retention = { kind: 'free' };

const retentionOf = (text: string | undefined, ports: HandoverLeftoverPorts): Retention => {
  const reader = text === undefined ? undefined : handoverRecordReader(text);
  if (reader === undefined) return FREE;
  const probe = probeReader(reader, ports.namespace, (pid) => ports.alive(pid));
  if (probe.kind === 'alive') return { kind: 'kept' };
  if (probe.kind === 'gone') return FREE;
  return { kind: 'reported', reason: `its reader ${reader.pid} is in the pid namespace ${probe.namespace}, which cannot be probed from ${ports.namespace}` };
};

export const handoverLeftovers = (paths: { readonly run: string }, ports: HandoverLeftoverPorts): LeftoverDirectory => {
  const directory = handoverDirectoryOf(paths);
  return {
    directory,
    isLeftover: (name) => isRecordName(name) || isAtomicWriteTemporary(name),
    retain: async (name) => {
      if (!isRecordName(name)) return FREE;
      const read = await recordRead(ports.files, path.join(directory, name));
      return read.kind === 'unreadable' ? { kind: 'reported', reason: `the record cannot be read: ${read.code}` } : retentionOf(read.text, ports);
    },
  };
};
