import { nodeCommandRunner } from './command-runner.ts';
import type { CommandRunner } from './command-runner.ts';
import { createDarwinInspector } from './darwin-inspector.ts';
import type { ProcessInspector } from './inspector-types.ts';
import type { LockCapabilityProbe } from './lock-capability.ts';
import { createLinuxInspector } from './linux-inspector.ts';
import { withMarkerState } from './marker-state.ts';
import { nodeProcFs } from './procfs.ts';
import type { ProcFs } from './procfs.ts';
import { isProcessAlive } from '../process-alive.ts';
import { createWindowsInspector } from './windows-inspector.ts';
import { hostKeptGroups } from './windows-kept-groups.ts';
import type { KeptGroupControl } from './windows-kept-groups.ts';

export type InspectorPorts = {
  run: CommandRunner;
  procfs: ProcFs;
  env: Readonly<Record<string, string | undefined>>;
  uid(): number;
  capability: LockCapabilityProbe;
  jobs: Pick<KeptGroupControl, 'members' | 'leads'>;
  alive(pid: number): boolean;
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
  if (process.getuid === undefined) throw new UnsupportedPlatformError(process.platform, 'reading the current user id');
  return process.getuid();
};

export const hostInspectorPorts = (capability: LockCapabilityProbe): InspectorPorts => ({ run: nodeCommandRunner, procfs: nodeProcFs, env: process.env, uid: hostUid, capability, jobs: hostKeptGroups(), alive: (pid) => isProcessAlive(pid) });

export const createProcessInspector = (platform: NodeJS.Platform, ports: InspectorPorts): ProcessInspector => {
  switch (platform) {
    case 'darwin':
      return withMarkerState(createDarwinInspector({ run: ports.run }), ports.capability);
    case 'linux':
      return withMarkerState(createLinuxInspector({ procfs: ports.procfs, uid: ports.uid() }), ports.capability);
    case 'win32':
      return withMarkerState(createWindowsInspector({ run: ports.run, env: ports.env, groups: ports.jobs, alive: ports.alive }), ports.capability);
    default:
      throw new UnsupportedPlatformError(platform, 'process inspection');
  }
};

export const hostProcessInspector = (ports: InspectorPorts): ProcessInspector => createProcessInspector(process.platform, ports);

export const layoutProcessInspector = (capability: LockCapabilityProbe): ProcessInspector => hostProcessInspector(hostInspectorPorts(capability));
