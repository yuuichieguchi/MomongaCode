import { isRecord, orderVersions } from '@momonga/foundation';
import type { HandoverRecordParties } from '@momonga/foundation';
import type { KeptWork, Surface } from '@momonga/protocol';
import type { HandoverTerminal } from '../tui/terminal/layer.ts';
import { encodeRecord } from './record.ts';
import type { HandoverRecord } from './record.ts';
import type { ReplaceHooks, ReplaceTarget } from './replace-process.ts';
import { handoverFailedText, recordTooLargeText, restartingText } from './texts.ts';

export type OwnGeneration = 'live' | 'gone';

export type MoveStanding = 'moves-at-quiet-point' | 'cannot-move';

export type MoveSurface = {
  surface: Surface;
  kept(): KeptWork;
  recordFile(): string | undefined;
  quiet(own: OwnGeneration): boolean;
  snapshot(toVersion: string): HandoverRecord;
  terminal(): HandoverTerminal | undefined;
  suspend(): Promise<void>;
  release(): void;
  resume(): void;
  say(text: string): void;
  announceRestart?(text: string): void;
};

export type MoverPorts = {
  version: string;
  parties(): Promise<HandoverRecordParties>;
  write(file: string, text: string): void;
  remove(file: string): void;
  handOver(file: string): void;
  target(recordFile: string, terminal: HandoverTerminal | undefined): ReplaceTarget;
  replace(target: ReplaceTarget, hooks: ReplaceHooks): Promise<'relayed'>;
};

export type Mover = {
  attach(surface: MoveSurface): () => void;
  learned(version: string, own: OwnGeneration): Promise<void>;
  check(): Promise<void>;
  refuse(version: string, reason: string): void;
  standing(version: string): MoveStanding;
};

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const codeOf = (error: unknown): string => {
  if (isRecord(error) && typeof error['code'] === 'string') return error['code'];
  return error instanceof Error ? error.name : String(error);
};

export const createMover = (ports: MoverPorts): Mover => {
  let surface: MoveSurface | undefined;
  let wanted: string | undefined;
  let moving: Promise<void> | undefined;
  let own: OwnGeneration = 'live';
  const tried = new Set<string>();
  const toldTooLarge = new Set<string>();
  const refusals = new Map<string, string>();
  const toldWriteFailure = new Map<string, string>();

  const said = (on: MoveSurface, version: string, reason: string): void => {
    on.say(handoverFailedText(on.surface, { toVersion: version, fromVersion: ports.version, reason, kept: on.kept() }));
  };

  const stayed = (on: MoveSurface, version: string, reason: string): void => {
    tried.add(version);
    said(on, version, reason);
  };

  const tooLarge = (on: MoveSurface, version: string): void => {
    if (toldTooLarge.has(version)) return;
    toldTooLarge.add(version);
    on.say(recordTooLargeText({ toVersion: version, fromVersion: ports.version }));
  };

  const replaceWith = async (on: MoveSurface, file: string, version: string, parties: HandoverRecordParties): Promise<void> => {
    const record = on.snapshot(version);
    try {
      const encoded = encodeRecord(record, parties);
      if (encoded.kind !== 'fits') {
        on.resume();
        tooLarge(on, version);
        return;
      }
      ports.write(file, encoded.text);
    } catch (error) {
      on.resume();
      const code = codeOf(error);
      if (toldWriteFailure.get(version) === code) return;
      toldWriteFailure.set(version, code);
      said(on, version, reasonOf(error));
      return;
    }
    if (on.announceRestart !== undefined) on.announceRestart(restartingText(version));
    else on.say(restartingText(version));
    try {
      await ports.replace(ports.target(file, on.terminal()), {
        release: () => on.release(),
        relayed: (childPid) => {
          const named = encodeRecord(record, { ...parties, reader: childPid });
          if (named.kind !== 'fits') throw new Error(`the record naming the relayed process ${childPid} is larger than 1 MiB`);
          ports.write(file, named.text);
          ports.handOver(file);
        },
      });
    } catch (error) {
      ports.remove(file);
      on.resume();
      stayed(on, version, reasonOf(error));
    }
  };

  const attempt = async (on: MoveSurface, file: string, version: string): Promise<void> => {
    const parties = await ports.parties();
    if (encodeRecord(on.snapshot(version), parties).kind !== 'fits') {
      tooLarge(on, version);
      return;
    }
    await on.suspend();
    if (!on.quiet(own)) {
      on.resume();
      return;
    }
    await replaceWith(on, file, version, parties);
  };

  const check = (): Promise<void> => {
    if (moving !== undefined) return moving;
    const on = surface;
    const version = wanted;
    const file = on?.recordFile();
    if (on === undefined || version === undefined || file === undefined || tried.has(version)) return Promise.resolve();
    const refusal = refusals.get(version);
    if (refusal !== undefined) {
      stayed(on, version, refusal);
      return Promise.resolve();
    }
    if (!on.quiet(own)) return Promise.resolve();
    const running = attempt(on, file, version).finally(() => {
      moving = undefined;
    });
    moving = running;
    return running;
  };

  return {
    attach: (next) => {
      surface = next;
      return () => {
        if (surface === next) surface = undefined;
      };
    },
    learned: (version, standing) => {
      if (standing === 'gone') own = 'gone';
      if (orderVersions(ports.version, version) !== 'older') return Promise.resolve();
      if (wanted === undefined || orderVersions(wanted, version) === 'older') wanted = version;
      return check();
    },
    check,
    refuse: (version, reason) => {
      refusals.set(version, reason);
    },
    standing: (version) => {
      const on = surface;
      if (on === undefined || on.recordFile() === undefined) return 'cannot-move';
      if (tried.has(version) || refusals.has(version) || orderVersions(ports.version, version) !== 'older') return 'cannot-move';
      return 'moves-at-quiet-point';
    },
  };
};
