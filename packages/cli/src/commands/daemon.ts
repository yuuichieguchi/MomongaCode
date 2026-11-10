import type { MomongaPaths } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { ensureCurrentDaemon, stopDaemon } from '../daemon/ensure-daemon.ts';
import type { DaemonPorts, InterruptedWork } from '../daemon/ensure-daemon.ts';
import { listLiveGenerations } from '../daemon/generations.ts';
import type { LiveGeneration } from '../daemon/generations.ts';
import { stderrStopNotice } from '../daemon/stop-notice.ts';
import type { CliPorts } from '../ports.ts';
import { escapedLines } from '../terminal-writer.ts';

export const daemonStatusText = (health: SupervisorHealth): string =>
  escapedLines([
    `momonga daemon running: pid ${health.pid}, version ${health.version}, phase ${health.phase}, started ${health.startedAt}`,
    ...health.children.map(
      (child) => `  ${child.role}: ${child.state}${child.pid === undefined ? '' : ` (pid ${child.pid})`}${child.heldReason === undefined ? '' : ` - ${child.heldReason}`}`,
    ),
  ]);

const NOT_RUNNING_TEXT = 'momonga daemon is not running';

const retiringWorkText = ({ steps, jobs, calls }: SupervisorHealth): string =>
  steps === undefined || jobs === undefined || calls === undefined ? '' : `: ${steps} steps in flight, ${jobs} background jobs, ${calls} model calls in flight`;

export const otherGenerationText = ({ role, health }: LiveGeneration): string =>
  escapedLines([`v${health.version} ${role} (pid ${health.pid})${role === 'retiring' ? retiringWorkText(health) : ''}`]);

export const daemonStatus = async (ports: Pick<CliPorts, 'stdout' | 'clock'>, paths: MomongaPaths): Promise<number> => {
  const live = await listLiveGenerations(ports, paths);
  const serving = live.find((entry) => entry.role === 'serving');
  const lines = [serving === undefined ? NOT_RUNNING_TEXT : daemonStatusText(serving.health), ...live.filter((entry) => entry !== serving).map(otherGenerationText)];
  ports.stdout.write(`${lines.join('\n')}\n`);
  return serving === undefined ? 1 : 0;
};

export const daemonStart = async (ports: CliPorts & DaemonPorts, paths: MomongaPaths): Promise<number> => {
  const health = await ensureCurrentDaemon(ports, paths);
  ports.stdout.write(`momonga daemon running: pid ${health.pid}, version ${health.version}\n`);
  return 0;
};

const LISTED_ITEMS = 5;

export const stoppingText = (work: InterruptedWork & { items: readonly string[] }): string => {
  const shown = work.items.slice(0, LISTED_ITEMS).join(', ');
  const more = work.items.length > LISTED_ITEMS ? ` and ${work.items.length - LISTED_ITEMS} more` : '';
  const list = work.items.length === 0 ? '' : `: ${shown}${more}`;
  return escapedLines([`Stopping the daemon. This interrupts ${work.steps} running steps and ${work.jobs} background jobs${list}. Interrupted runs resume when the daemon starts again.`]);
};

export const daemonStop = async (ports: CliPorts & DaemonPorts, paths: MomongaPaths): Promise<number> => {
  const { stopped } = await stopDaemon(ports, paths, undefined, stderrStopNotice(ports), undefined, (work) => {
    if (work.steps + work.jobs > 0) ports.stdout.write(`${stoppingText({ ...work, items: [] })}\n`);
  });
  ports.stdout.write(stopped ? 'momonga daemon stopped\n' : `${NOT_RUNNING_TEXT}\n`);
  return 0;
};
