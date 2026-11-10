import { orderVersions } from '@momonga/foundation';
import type { SelfExecutable } from '../ports.ts';
import { createMover } from './mover.ts';
import type { Mover } from './mover.ts';
import { hostReplace, replaceProcess } from './replace-process.ts';
import { handoverTarget, takeHandoverStart } from './start.ts';
import type { HandoverStart } from './start.ts';
import { installedNotNewerReason } from './texts.ts';

export type HandoverHost = { args: readonly string[]; started: HandoverStart | undefined; mover: Mover; removeRecord(file: string): void };

export type RecordFiles = { read(file: string): string; write(file: string, text: string): void; remove(file: string): void };

export type HandoverInvocation = { version: string; self: SelfExecutable; argv: readonly string[]; env: Record<string, string | undefined>; execArgv: readonly string[]; files: RecordFiles };

export const createHandoverHost = ({ version, self, argv, env, execArgv, files }: HandoverInvocation): HandoverHost => {
  const { args, started } = takeHandoverStart(argv, env, files.read);
  const mover = createMover({
    version,
    write: files.write,
    remove: files.remove,
    target: (recordFile, terminal) => handoverTarget({ self, execArgv, args, env }, recordFile, terminal),
    replace: (target, hooks) => replaceProcess(target, hostReplace, hooks),
  });
  const record = started?.parsed.kind === 'record' ? started.parsed.record : undefined;
  if (record !== undefined && orderVersions(record.fromVersion, version) !== 'older') mover.refuse(record.toVersion, installedNotNewerReason(version));
  return { args, started, mover, removeRecord: files.remove };
};
