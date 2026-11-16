import type { MomongaPaths } from '@momonga/foundation';
import type { NewerListener } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import type { OutputFormat } from '../run/output-format.ts';
import type { Mover, MoveSurface } from './mover.ts';
import { HANDOVER_FORMAT, recordFileOf } from './record.ts';
import { SURFACE_OF_KIND } from './texts.ts';

export type StreamMove = { mover: Pick<Mover, 'attach' | 'check'>; kind: 'attach' | 'headless'; recordFile(session: string): string };

export const newerListenerOf = (ports: Pick<CliPorts, 'handover'>): NewerListener | undefined => {
  const mover = ports.handover?.mover;
  return mover === undefined ? undefined : (version, own) => mover.learned(version, own);
};

export const streamMoveOf = (ports: Pick<CliPorts, 'handover'>, paths: Pick<MomongaPaths, 'run'>, kind: StreamMove['kind']): StreamMove | undefined => {
  const mover = ports.handover?.mover;
  return mover === undefined ? undefined : { mover, kind, recordFile: (session) => recordFileOf(paths, kind, session) };
};

export type StreamFacts = {
  move: StreamMove;
  version: string;
  runId: string;
  format: OutputFormat;
  verbose: boolean;
  session(): string | undefined;
  cursor(): number;
  pending(): number;
  say(text: string): void;
};

export const streamSurface = (facts: StreamFacts): MoveSurface => ({
  surface: SURFACE_OF_KIND[facts.move.kind],
  kept: () => ({ kind: 'run', runId: facts.runId }),
  recordFile: () => {
    const session = facts.session();
    return session === undefined ? undefined : facts.move.recordFile(session);
  },
  quiet: () => facts.pending() === 0,
  snapshot: (toVersion) => {
    const session = facts.session();
    if (session === undefined) throw new Error('the stream has delivered no event that names its session');
    return {
      format: HANDOVER_FORMAT,
      fromVersion: facts.version,
      toVersion,
      session,
      lastSeq: { [facts.runId]: facts.cursor() },
      kind: facts.move.kind,
      runId: facts.runId,
      output: facts.format,
      verbose: facts.verbose,
    };
  },
  terminal: () => undefined,
  suspend: () => Promise.resolve(),
  release: () => undefined,
  resume: () => undefined,
  say: facts.say,
});
