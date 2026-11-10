import path from 'node:path';
import { readUserStopValues } from '@momonga/config';
import { STOP_VALUE_NAMES, generationLayout, readStopRecord } from '@momonga/foundation';
import type { MomongaPaths, StopValueName, StopValues } from '@momonga/foundation';
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

const STOP_VALUE_SETTING_KEYS = {
  closeGraceMs: 'gateway.closeGraceMs',
  managedServerStopGraceMs: 'gateway.managedServerStopGraceMs',
  drainTimeoutMs: 'runtime.drainTimeoutMs',
  mcpCloseGraceMs: 'mcp.closeGraceMs',
} as const satisfies Record<StopValueName, string>;

export const stopValuesText = (values: StopValues): string => STOP_VALUE_NAMES.map((name) => `${STOP_VALUE_SETTING_KEYS[name]} ${values[name]}`).join(', ');

export const lastStopLines = (lastStop: StopValues, settingsNow: StopValues): string[] => {
  const last = stopValuesText(lastStop);
  const now = stopValuesText(settingsNow);
  return [`  last stop: ${last}`, ...(now === last ? [] : [`  settings now: ${now}`])];
};

export const daemonStatus = async (ports: Pick<CliPorts, 'stdout' | 'clock' | 'home'>, paths: MomongaPaths): Promise<number> => {
  const live = await listLiveGenerations(ports, paths);
  const serving = live.find((entry) => entry.role === 'serving');
  const others = live.filter((entry) => entry !== serving);
  const home = path.dirname(paths.root);
  const lastStops = new Map(await Promise.all(live.map(async (entry) => [entry, await readStopRecord(generationLayout(home, entry.generation).stopRecord)] as const)));
  const settingsNow = [...lastStops.values()].some((values) => values !== undefined) ? readUserStopValues(ports.home) : undefined;
  const lastStopOf = (entry: LiveGeneration): string[] => {
    const lastStop = lastStops.get(entry);
    return lastStop === undefined || settingsNow === undefined ? [] : lastStopLines(lastStop, settingsNow);
  };
  const lines = [
    ...(serving === undefined ? [NOT_RUNNING_TEXT] : [daemonStatusText(serving.health), ...lastStopOf(serving)]),
    ...others.flatMap((entry) => [otherGenerationText(entry), ...lastStopOf(entry)]),
  ];
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
