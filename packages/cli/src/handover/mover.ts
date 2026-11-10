import { orderVersions } from '@momonga/foundation';
import type { HandoverTerminal } from '../tui/terminal/layer.ts';
import { encodeRecord, sessionOfRecordFile } from './record.ts';
import type { HandoverRecord } from './record.ts';
import type { ReplaceHooks, ReplaceTarget } from './replace-process.ts';
import { handoverFailedText, recordTooLargeText, restartingText } from './texts.ts';

export type MoveSurface = {
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
  write(file: string, text: string): void;
  remove(file: string): void;
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

export const createMover = (ports: MoverPorts): Mover => {
  let surface: MoveSurface | undefined;
  let wanted: string | undefined;
  let moving: Promise<void> | undefined;
  const tried = new Set<string>();
  const toldTooLarge = new Set<string>();
  const refusals = new Map<string, string>();

  const stayed = (on: MoveSurface, file: string, version: string, reason: string): void => {
    tried.add(version);
    on.say(handoverFailedText({ toVersion: version, fromVersion: ports.version, reason, session: sessionOfRecordFile(file) }));
  };

  const tooLarge = (on: MoveSurface, version: string): void => {
    if (toldTooLarge.has(version)) return;
    toldTooLarge.add(version);
    on.say(recordTooLargeText({ toVersion: version, fromVersion: ports.version }));
  };

  const replaceWith = async (on: MoveSurface, file: string, version: string): Promise<void> => {
    let written = false;
    try {
      const encoded = encodeRecord(on.snapshot(version));
      if (encoded.kind !== 'fits') {
        on.resume();
        tooLarge(on, version);
        return;
      }
      ports.write(file, encoded.text);
      written = true;
      await ports.replace(ports.target(file, on.terminal()), { release: on.release });
    } catch (error) {
      if (written) ports.remove(file);
      on.resume();
      stayed(on, file, version, reasonOf(error));
    }
  };

  const attempt = async (on: MoveSurface, file: string, version: string): Promise<void> => {
    if (encodeRecord(on.snapshot(version)).kind !== 'fits') {
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
      stayed(on, file, version, refusal);
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
