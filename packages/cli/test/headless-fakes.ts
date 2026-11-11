import { momongaPaths } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { PublicRunEvent } from '@momonga/protocol';
import type { RunEventFrame, RuntimeClient } from '../src/client/runtime-client.ts';
import type { RunView } from '../src/client/views.ts';
import type { CliPorts } from '../src/ports.ts';
import { terminalPorts } from '../src/terminal-writer.ts';
import { virtualClock } from './fake-supervisor.ts';

export const eventFrame = (seq: number, event: Record<string, unknown>, runId = 'run-1'): RunEventFrame => ({
  id: seq,
  event: String(event['type']),
  data: { id: seq, runId, sessionId: 'session-1', seq, step: 1, createdAt: 1, ...event } as PublicRunEvent,
});

export const textDelta = (seq: number, itemId: string, text: string): RunEventFrame => eventFrame(seq, { type: 'agent.message.delta', attempt: 0, itemId, text });

export type Watched = { paths: MomongaPaths; client: RuntimeClient; ports: CliPorts; stdout: string[]; stderr: string[]; cancelled: string[] };

export const watchedRun = (home: string, frames: readonly RunEventFrame[], ended: RunView, options: { staysOpen?: boolean } = {}): Watched => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const cancelled: string[] = [];
  const client = {
    cancel: async (runId: string) => {
      cancelled.push(runId);
      return { status: 202, run: ended };
    },
    streamEvents: async function* (_runId: string, stream: { signal?: AbortSignal } = {}) {
      for (const each of frames) {
        stream.signal?.throwIfAborted();
        yield each;
      }
      stream.signal?.throwIfAborted();
      if (options.staysOpen !== true) return;
      const aborted = Promise.withResolvers<never>();
      const abort = (): void => aborted.reject(stream.signal?.reason);
      if (stream.signal?.aborted === true) abort();
      else stream.signal?.addEventListener('abort', abort, { once: true });
      await aborted.promise;
    },
    getRun: async () => ended,
    childRuns: async () => [],
  } as unknown as RuntimeClient;
  const raw = { version: '1.2.3', clock: virtualClock(), random: () => 0.5, stdout: { write: (text: string) => void stdout.push(text) }, stderr: { write: (text: string) => void stderr.push(text) } } as unknown as CliPorts;
  return { paths: momongaPaths(home), client, ports: terminalPorts(raw), stdout, stderr, cancelled };
};
