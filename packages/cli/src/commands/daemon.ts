import { readUserStopValuesOrDefault } from '@momonga/config';
import { STOP_VALUE_NAMES, generationLayout, readStopRecord } from '@momonga/foundation';
import type { MomongaPaths, StopValueName, StopValues } from '@momonga/foundation';
import { INTERRUPTED_WORK_LISTED } from '@momonga/protocol';
import type { InterruptedWorkItem, RetentionStatusView, SupervisorChildRole, SupervisorHealth } from '@momonga/protocol';
import { ensureCurrentDaemon, stopDaemon } from '../daemon/ensure-daemon.ts';
import type { DaemonPorts, InterruptedWork } from '../daemon/ensure-daemon.ts';
import { listLiveGenerations } from '../daemon/generations.ts';
import type { LiveGeneration } from '../daemon/generations.ts';
import { stderrStopNotice } from '../daemon/stop-notice.ts';
import type { CliPorts } from '../ports.ts';
import { escapedLines } from '../terminal-writer.ts';

const retentionText = (retention: RetentionStatusView): string =>
  retention.lastSweep === null
    ? `  retention: ${retention.days} days, no sweep yet`
    : `  retention: ${retention.days} days, last sweep at ${retention.lastSweep.at}: ${retention.lastSweep.sessionsDeleted} sessions deleted, ${retention.lastSweep.runsPurged} runs purged, ${retention.lastSweep.blobsCollected} blobs collected`;

export const daemonStatusText = (health: SupervisorHealth): string =>
  escapedLines([
    `momonga daemon running: pid ${health.pid}, version ${health.version}, phase ${health.phase}, started ${health.startedAt}`,
    ...(health.retention === null ? [] : [retentionText(health.retention)]),
    ...health.children.map(
      (child) => `  ${child.role}: ${child.state}${child.pid === undefined ? '' : ` (pid ${child.pid})`}${child.heldReason === undefined ? '' : ` - ${child.heldReason}`}`,
    ),
  ]);

const NOT_RUNNING_TEXT = 'momonga daemon is not running';

const countText = (count: number | undefined, noun: string, notKnown: boolean): string => (notKnown ? `${noun} not known` : `${count} ${noun}`);

const notAnsweredText = (roles: readonly SupervisorChildRole[]): string => (roles.length === 0 ? '' : ` (its ${roles.join(' and its ')} did not answer in time)`);

const retiringWorkText = ({ steps, jobs, calls, countsNotKnown = [] }: SupervisorHealth): string => {
  const runtimeNotKnown = countsNotKnown.includes('runtime');
  const gatewayNotKnown = countsNotKnown.includes('gateway');
  if ((!runtimeNotKnown && (steps === undefined || jobs === undefined)) || (!gatewayNotKnown && calls === undefined)) return '';
  return `: ${countText(steps, 'steps in flight', runtimeNotKnown)}, ${countText(jobs, 'background jobs', runtimeNotKnown)}, ${countText(calls, 'model calls in flight', gatewayNotKnown)}${notAnsweredText(countsNotKnown)}`;
};

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

const generationDocumentOf = (entry: LiveGeneration, lastStop: StopValues | undefined) => ({ role: entry.role, generation: entry.generation, ...entry.health, lastStop: lastStop ?? null });

export const daemonStatus = async (ports: Pick<CliPorts, 'stdout' | 'stderr' | 'clock' | 'env' | 'interrupt' | 'endpointScope'>, paths: MomongaPaths, options: { json: boolean }): Promise<number> => {
  const live = await listLiveGenerations(ports, paths);
  const serving = live.find((entry) => entry.role === 'serving');
  const others = live.filter((entry) => entry !== serving);
  const lastStops = new Map(await Promise.all(live.map(async (entry) => [entry, await readStopRecord(generationLayout(paths.home, entry.generation).stopRecord)] as const)));
  const settingsNow = [...lastStops.values()].some((values) => values !== undefined)
    ? await readUserStopValuesOrDefault({ env: ports.env, home: paths.home, signal: ports.interrupt, onNotice: (message) => ports.stderr.write(`${escapedLines([`momonga: ${message}`])}\n`) })
    : undefined;
  if (options.json) {
    const ordered = [...(serving === undefined ? [] : [serving]), ...others];
    ports.stdout.write(`${JSON.stringify({ running: serving !== undefined, generations: ordered.map((entry) => generationDocumentOf(entry, lastStops.get(entry))), settingsNow: settingsNow ?? null })}\n`);
    return serving === undefined ? 1 : 0;
  }
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

const interruptedItemText = (item: InterruptedWorkItem): string => (item.kind === 'run' ? `run ${item.id}` : `job ${item.id} (${item.command})`);

export const stoppingText = (work: InterruptedWork): string => {
  const shown = work.items.slice(0, INTERRUPTED_WORK_LISTED);
  const rest = work.steps + work.jobs - shown.length;
  const more = rest > 0 ? ` and ${rest} more` : '';
  const list = shown.length === 0 ? '' : `: ${shown.map(interruptedItemText).join(', ')}${more}`;
  const notKnown = work.notKnown.length === 0 ? '' : `, and work that is not known in ${work.notKnown.join(', ')}, whose runtime did not answer in time`;
  return escapedLines([`Stopping the daemon. This interrupts ${work.steps} running steps and ${work.jobs} background jobs${list}${notKnown}. Interrupted runs resume when the daemon starts again.`]);
};

export const daemonStop = async (ports: CliPorts & DaemonPorts, paths: MomongaPaths): Promise<number> => {
  const { stopped } = await stopDaemon(ports, paths, undefined, stderrStopNotice(ports), undefined, (work) => {
    if (work.steps + work.jobs > 0 || work.notKnown.length > 0) ports.stdout.write(`${stoppingText(work)}\n`);
  });
  ports.stdout.write(stopped ? 'momonga daemon stopped\n' : `${NOT_RUNNING_TEXT}\n`);
  return 0;
};
