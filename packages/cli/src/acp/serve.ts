import { ndJsonStream } from '@agentclientprotocol/sdk';
import { canonicalPath } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { createGatewayClient } from '../client/gateway-client.ts';
import { daemonReadyBoundMs, ensureDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { followRun, followSession } from '../run/follow.ts';
import { autoModeConfigured, connectRuntime, environmentSnapshot } from '../run/open-session.ts';
import { createAcpAgent } from './agent.ts';

export const serveAcp = async (ports: CliPorts, paths: MomongaPaths, interrupt: AbortSignal): Promise<number> => {
  if (ports.acpStdio === undefined) throw new Error('this build has no standard streams to speak the Agent Client Protocol on');
  const stdio = ports.acpStdio();
  const runtime = connectRuntime(paths);
  const gateway = createGatewayClient({ socketPath: paths.sockets.gateway });
  const reconnectBoundMs = await daemonReadyBoundMs();
  const app = createAcpAgent({
    version: ports.version,
    runtime,
    contextWindowOf: (modelAlias) => gateway.contextWindowOf(modelAlias),
    environment: () => environmentSnapshot(ports),
    autoModeAvailable: () => autoModeConfigured(ports),
    canonicalCwd: canonicalPath,
    daemonReady: async () => {
      await ensureDaemon(ports, paths, { replacement: 'when-idle', signal: interrupt });
    },
    follow: ({ runId, onEvent, onChildEvent, signal }) =>
      followRun({
        client: runtime,
        clock: ports.clock,
        random: ports.random,
        runId,
        reconnectBoundMs,
        restoreConnection: async () => {
          await ensureDaemon(ports, paths);
        },
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
        restoreConnection: async () => {
          await ensureDaemon(ports, paths);
        },
        onEvent,
        onReconnecting: (attempt) => ports.stderr.write(`momonga: lost the session event stream, reconnecting (attempt ${attempt + 1})\n`),
        signal,
      }),
    report: (message) => ports.stderr.write(`momonga: ${message}\n`),
  });
  const connection = app.connect(ndJsonStream(stdio.output, stdio.input));
  const closeOnInterrupt = (): void => connection.close();
  interrupt.addEventListener('abort', closeOnInterrupt, { once: true });
  try {
    await connection.closed;
  } finally {
    interrupt.removeEventListener('abort', closeOnInterrupt);
    await Promise.all([runtime.close(), gateway.close()]);
  }
  return 0;
};
