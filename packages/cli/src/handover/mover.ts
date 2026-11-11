import { isRecord, orderVersions } from '@momonga/foundation';
import type { KeptWork, Surface } from '@momonga/protocol';
import type { HandoverTerminal } from '../tui/terminal/layer.ts';
import { encodeRecord } from './record.ts';
import type { HandoverRecord } from './record.ts';
import type { ReplaceHooks, ReplaceTarget } from './replace-process.ts';
import { handoverFailedText, recordTooLargeText, restartingText } from './texts.ts';

export type MoveSurface = {
  surface: Surface;
  kept(): KeptWork;
  recordFile(): string | undefined;
  quiet(): boolean;
  snapshot(toVersion: string): HandoverRecord;
  terminal(): HandoverTerminal | undefined;
  suspend(): Promise<void>;
  release(): void;
  resume(): void;
  say(text: string): void;
};

export type MoverPorts = {
  version: string;
  pid: number;
  write(file: string, text: string): void;
  remove(file: string): void;
  handOver(file: string): void;
  target(recordFile: string, terminal: HandoverTerminal | undefined): ReplaceTarget;
  replace(target: ReplaceTarget, hooks: ReplaceHooks): Promise<'relayed'>;
};

export type Mover = {
  attach(surface: MoveSurface): () => void;
  learned(version: string): Promise<void>;
  check(): Promise<void>;
  refuse(version: string, reason: string): void;
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

  const replaceWith = async (on: MoveSurface, file: string, version: string): Promise<void> => {
    try {
      const encoded = encodeRecord(on.snapshot(version), ports.pid);
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
    try {
      await ports.replace(ports.target(file, on.terminal()), {
        release: () => {
          on.release();
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
    if (encodeRecord(on.snapshot(version), ports.pid).kind !== 'fits') {
      tooLarge(on, version);
      return;
    }
    await on.suspend();
    if (!on.quiet()) {
      on.resume();
      return;
    }
    on.say(restartingText(version));
    await replaceWith(on, file, version);
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
    if (!on.quiet()) return Promise.resolve();
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
    learned: (version) => {
      if (orderVersions(ports.version, version) !== 'older') return Promise.resolve();
      if (wanted === undefined || orderVersions(wanted, version) === 'older') wanted = version;
      return check();
    },
    check,
    refuse: (version, reason) => {
      refusals.set(version, reason);
    },
  };
};
