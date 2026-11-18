import { nodeCommandRunner } from './command-runner.ts';
import type { CommandRunner } from './command-runner.ts';
import { LSOF_BINARY, PS_BINARY, createDarwinInspector } from './darwin-inspector.ts';
import { createAsyncCapabilityProbe } from '../capability-probe.ts';
import type { CapabilityResult } from '../capability-probe.ts';
import { nodeFileSystem } from '../node-file-system.ts';
import { isErrno } from './inspector-types.ts';
import { powershellPath } from './windows-scripts.ts';
import type { ProcessInspector } from './inspector-types.ts';
import type { LockCapabilityProbe } from './lock-capability.ts';
import { createLinuxInspector } from './linux-inspector.ts';
import { withMarkerState } from './marker-state.ts';
import { nodeProcFs } from './procfs.ts';
import type { ProcFs } from './procfs.ts';
import { isProcessAlive } from '../process-alive.ts';
import type { Timing } from '../timing.ts';
import { systemWaitTiming } from '../system-timing.ts';
import { createWindowsInspector } from './windows-inspector.ts';
import { hostKeptGroups } from './windows-kept-groups.ts';
import type { KeptGroupControl } from './windows-kept-groups.ts';

export type InspectorPorts = {
  run: CommandRunner;
  timing: Pick<Timing, 'setTimeout' | 'clearTimeout'>;
  procfs: ProcFs;
  env: Readonly<Record<string, string | undefined>>;
  uid(): number;
  capability: LockCapabilityProbe;
  jobs: Pick<KeptGroupControl, 'members' | 'leads'>;
  alive(pid: number): boolean;
  isExecutable(file: string): Promise<boolean>;
};

export class UnsupportedPlatformError extends Error {
  readonly platform: string;

  constructor(platform: string, capability: string) {
    super(`${capability} is not supported on ${platform}; supported platforms are darwin, linux and win32`);
    this.name = 'UnsupportedPlatformError';
    this.platform = platform;
  }
}

const hostUid = (): number => {
  if (process.getuid === undefined) throw new UnsupportedPlatformError('this host', 'reading the current user id');
  return process.getuid();
};

const executableOnHost = async (file: string): Promise<boolean> => {
  try {
    await nodeFileSystem.access(file, 'execute');
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR', 'EACCES')) return false;
    throw error;
  }
};

export type InspectorKind = 'procfs' | 'lsof' | 'powershell';

export type InspectorKindProbes = {
  readText(file: string): Promise<string>;
  list(directory: string): Promise<string[]>;
  isExecutable(file: string): Promise<boolean>;
  env: Readonly<Record<string, string | undefined>>;
};

const PROC_SELF_STAT = '/proc/self/stat';
const PROC_SELF_FD = '/proc/self/fd';

const answers = async (ask: () => Promise<unknown>): Promise<boolean> => {
  try {
    await ask();
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return false;
    throw error;
  }
};

const powershellOffered = async (probes: InspectorKindProbes): Promise<boolean> => {
  const systemRoot = probes.env['SystemRoot'];
  if (systemRoot === undefined || systemRoot === '') return false;
  return probes.isExecutable(powershellPath(probes.env));
};

export const inspectorKindOf = async (probes: InspectorKindProbes): Promise<CapabilityResult<InspectorKind>> => {
  if ((await answers(() => probes.readText(PROC_SELF_STAT))) && (await answers(() => probes.list(PROC_SELF_FD)))) {
    return { kind: 'supported', value: 'procfs', evidence: `${PROC_SELF_STAT} and ${PROC_SELF_FD} are readable` };
  }
  if ((await probes.isExecutable(LSOF_BINARY)) && (await probes.isExecutable(PS_BINARY))) {
    return { kind: 'supported', value: 'lsof', evidence: `${LSOF_BINARY} and ${PS_BINARY} are executable` };
  }
  if (await powershellOffered(probes)) return { kind: 'supported', value: 'powershell', evidence: 'Windows PowerShell under SystemRoot is executable' };
  return {
    kind: 'unsupported',
    evidence: `looked for a readable ${PROC_SELF_STAT} and ${PROC_SELF_FD}, executable ${LSOF_BINARY} and ${PS_BINARY}, and Windows PowerShell under SystemRoot; found none`,
  };
};

export const hostInspectorPorts = (capability: LockCapabilityProbe): InspectorPorts => ({
  run: nodeCommandRunner,
  timing: systemWaitTiming,
  procfs: nodeProcFs,
  env: process.env,
  uid: hostUid,
  capability,
  jobs: hostKeptGroups(),
  alive: (pid) => isProcessAlive(pid),
  isExecutable: executableOnHost,
});

export const createProcessInspector = (kind: InspectorKind, ports: InspectorPorts): ProcessInspector => {
  switch (kind) {
    case 'lsof':
      return withMarkerState(createDarwinInspector({ run: ports.run }), ports.capability);
    case 'procfs':
      return withMarkerState(createLinuxInspector({ procfs: ports.procfs, uid: ports.uid() }), ports.capability);
    case 'powershell':
      return withMarkerState(createWindowsInspector({ run: ports.run, timing: ports.timing, env: ports.env, groups: ports.jobs, alive: ports.alive }), ports.capability);
  }
};

const probedInspectorKind = createAsyncCapabilityProbe<InspectorPorts, InspectorKind>(
  () => 'host',
  (ports) => inspectorKindOf({ readText: (file) => ports.procfs.readText(file), list: (directory) => ports.procfs.list(directory), isExecutable: ports.isExecutable, env: ports.env }),
);

export const hostProcessInspector = (ports: InspectorPorts): ProcessInspector => {
  let chosen: Promise<ProcessInspector> | undefined;
  const inspector = (): Promise<ProcessInspector> => {
    chosen ??= probedInspectorKind(ports).then((result) => {
      if (result.kind === 'supported') return createProcessInspector(result.value, ports);
      chosen = undefined;
      if (result.kind === 'unsupported') throw new UnsupportedPlatformError('this host', `process inspection (${result.evidence})`);
      throw new Error(`the process inspector of this host could not be chosen: ${result.evidence}`);
    });
    return chosen;
  };
  return {
    capability: ports.capability,
    startTimeOf: async (pid, options) => (await inspector()).startTimeOf(pid, options),
    holdersOf: async (marker, options, onUninspectable) => (await inspector()).holdersOf(marker, options, onUninspectable),
    groupsOf: async (pids, candidateGroups, options) => (await inspector()).groupsOf(pids, candidateGroups, options),
    markerState: async (marker, options) => (await inspector()).markerState(marker, options),
  };
};

export const layoutProcessInspector = (capability: LockCapabilityProbe): ProcessInspector => hostProcessInspector(hostInspectorPorts(capability));
