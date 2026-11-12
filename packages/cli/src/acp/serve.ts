import { hostPaths } from '@momonga/foundation';
import { agentReadiness } from '@momonga/protocol';
import type { MomongaPaths } from '@momonga/foundation';
import { createGatewayClient, listingViewsOf } from '../client/gateway-client.ts';
import { daemonReadyBoundMs, ensureDaemon, restoreDaemon, ensureSessionDaemon } from '../daemon/ensure-daemon.ts';
import { sessionSocketResolver } from '../daemon/generations.ts';
import type { CliPorts } from '../ports.ts';
import { DaemonUnreachable, followRun, followSession, retryAfterRestore } from '../run/follow.ts';
import { autoModeConfigured, connectSessionRuntime, environmentSnapshot } from '../run/open-session.ts';
import { escapedLines } from '../terminal-writer.ts';
import { HANDOVER_FORMAT, recordFileOf } from '../handover/record.ts';
import { adoptionOf, refuseStart } from '../handover/start.ts';
import { newerListenerOf } from '../handover/stream.ts';
import { createAcpBridge } from './agent.ts';
import { carriedStream } from './carried-input.ts';
import { withReplayedInitialize } from './handover.ts';

export const acpDiagnosticText = (message: string): string => `${escapedLines([`momonga: ${message}`])}\n`;

export const serveAcp = async (ports: CliPorts, paths: MomongaPaths, interrupt: AbortSignal): Promise<number> => {
  if (ports.acpStdio === undefined) throw new Error('this build has no standard streams to speak the Agent Client Protocol on');
  const adoption = adoptionOf(ports.handover?.started, ['acp']);
  if (adoption.kind === 'refused') return refuseStart({ stderr: ports.stderr }, adoption);
  const stdio = ports.acpStdio();
  const onNewer = newerListenerOf(ports);
  const runtime = connectSessionRuntime(ports, paths, onNewer);
  const gateway = createGatewayClient({ resolveSocket: sessionSocketResolver(ports, paths, 'gateway') });
  const reconnectBoundMs = await daemonReadyBoundMs();
  const bridge = createAcpBridge({
    version: ports.version,
    runtime,
    contextWindowOf: (model) => gateway.contextWindowOf(model),
    readinessOf: async (model) => agentReadiness(await gateway.capabilitiesOf(model)),
    models: async () => listingViewsOf(await gateway.models()),
    environment: () => environmentSnapshot(ports, interrupt),
    autoModeAvailable: () => autoModeConfigured(ports, interrupt),
    canonicalCwd: (cwd) => hostPaths(interrupt).canonicalPath(cwd),
    daemonReady: async () => {
      await ensureSessionDaemon(ports, paths, { signal: interrupt, ...(onNewer === undefined ? {} : { onNewer }) });
    },
    retryAfterRestore: (operation, signal) =>
      retryAfterRestore(
        {
          clock: ports.clock,
          random: ports.random,
          reconnectBoundMs,
          boundExceeded: (boundMs, cause) => new DaemonUnreachable(boundMs, cause),
          restoreConnection: restoreDaemon(ports, paths, onNewer),
          onReconnecting: (attempt) => ports.stderr.write(`momonga: lost the connection to the daemon, reconnecting (attempt ${attempt + 1})\n`),
          signal,
        },
        operation,
      ),
    follow: ({ runId, onEvent, onChildEvent, signal }) =>
      followRun({
        client: runtime,
        clock: ports.clock,
        random: ports.random,
        runId,
        reconnectBoundMs,
        restoreConnection: restoreDaemon(ports, paths, onNewer),
        onEvent,
        onChildEvent,
        onReconnecting: (attempt) => ports.stderr.write(`momonga: lost the event stream, reconnecting (attempt ${attempt + 1})\n`),
        signal,
      }),
    followSession: ({ sessionId, after, onEvent, signal }) =>
      followSession({
        client: runtime,
        clock: ports.clock,
        random: ports.random,
        sessionId,
        after,
        reconnectBoundMs,
        restoreConnection: restoreDaemon(ports, paths, onNewer),
        onEvent,
        onReconnecting: (attempt) => ports.stderr.write(`momonga: lost the session event stream, reconnecting (attempt ${attempt + 1})\n`),
        signal,
      }),
    report: (message) => ports.stderr.write(acpDiagnosticText(message)),
  });
  const carried = carriedStream(stdio, adoption.kind === 'record' ? Buffer.from(adoption.record.input, 'base64') : new Uint8Array());
  if (adoption.kind === 'record') carried.hold('adoption');
  const connection = bridge.app.connect(adoption.kind === 'record' ? withReplayedInitialize(carried.stream, adoption.record.initialize) : carried.stream);
  const mover = ports.handover?.mover;
  let named: string | undefined;
  const recordName = (): string => (named ??= `acp-${ports.clock.now()}`);
  const detach = mover?.attach({
    surface: 'acp',
    kept: () => {
      const state = bridge.snapshot();
      return { kind: 'sessions', sessionIds: state === undefined ? [] : state.sessions };
    },
    recordFile: () => (bridge.snapshot() === undefined ? undefined : recordFileOf(paths, 'acp', recordName())),
    quiet: () => bridge.quiet() && carried.idle(),
    snapshot: (toVersion) => {
      const state = bridge.snapshot();
      if (state === undefined) throw new Error('the ACP connection is not initialized');
      return { format: HANDOVER_FORMAT, fromVersion: ports.version, toVersion, session: recordName(), kind: 'acp', ...state, input: Buffer.from(carried.pending()).toString('base64') };
    },
    terminal: () => undefined,
    suspend: async () => carried.hold('handover'),
    release: () => undefined,
    resume: () => carried.release('handover'),
    say: (text) => ports.stderr.write(acpDiagnosticText(text)),
  });
  bridge.onActivity(() => void mover?.check());
  carried.onIdle(() => void mover?.check());
  if (adoption.kind === 'record') {
    await bridge.adopt(adoption.record);
    ports.handover?.removeRecord(adoption.file);
    carried.release('adoption');
  }
  const closeOnInterrupt = (): void => connection.close();
  if (interrupt.aborted) closeOnInterrupt();
  else interrupt.addEventListener('abort', closeOnInterrupt, { once: true });
  try {
    await connection.closed;
  } finally {
    interrupt.removeEventListener('abort', closeOnInterrupt);
    detach?.();
    await Promise.all([runtime.close(), gateway.close()]);
  }
  return 0;
};
