import type { MomongaPaths } from "@momonga/foundation";
import { createSupervisorClient } from "../client/supervisor-client.ts";
import { ensureDaemon, probeSupervisor, stopDaemon } from "../daemon/ensure-daemon.ts";
import { stderrStopNotice } from "../daemon/stop-notice.ts";
import type { DaemonPorts } from "../daemon/ensure-daemon.ts";
import type { SupervisorHealth } from "@momonga/protocol";
import type { CliPorts } from "../ports.ts";
import { escapedLines } from "../terminal-writer.ts";

export const daemonStatusText = (health: SupervisorHealth): string =>
  escapedLines([
    `momonga daemon running: pid ${health.pid}, version ${health.version}, phase ${health.phase}, started ${health.startedAt}`,
    ...health.children.map(
      (child) =>
        `  ${child.role}: ${child.state}${child.pid === undefined ? "" : ` (pid ${child.pid})`}${child.heldReason === undefined ? "" : ` - ${child.heldReason}`}`,
    ),
  ]);

export const daemonStatus = async (
  ports: CliPorts,
  paths: MomongaPaths,
): Promise<number> => {
  const client = createSupervisorClient({
    socketPath: paths.sockets.supervisor,
  });
  try {
    const health = await probeSupervisor(client);
    if (health === undefined) {
      ports.stdout.write("momonga daemon is not running\n");
      return 1;
    }
    ports.stdout.write(`${daemonStatusText(health)}\n`);
    return 0;
  } finally {
    await client.close();
  }
};

export const daemonStart = async (
  ports: CliPorts & DaemonPorts,
  paths: MomongaPaths,
): Promise<number> => {
  const health = await ensureDaemon(ports, paths, { onNotice: stderrStopNotice(ports) });
  ports.stdout.write(
    `momonga daemon running: pid ${health.pid}, version ${health.version}\n`,
  );
  return 0;
};

export const daemonStop = async (
  ports: CliPorts & DaemonPorts,
  paths: MomongaPaths,
): Promise<number> => {
  const { stopped } = await stopDaemon(ports, paths, undefined, stderrStopNotice(ports));
  ports.stdout.write(
    stopped ? "momonga daemon stopped\n" : "momonga daemon is not running\n",
  );
  return 0;
};
