import { nodeCommandRunner } from './command-runner.ts';
import type { CommandRunner } from './command-runner.ts';
import { createDarwinInspector } from './darwin-inspector.ts';
import type { ProcessInspector } from './inspector-types.ts';
import { hostLockCapability } from './lock-capability.ts';
import type { LockCapabilityProbe } from './lock-capability.ts';
import { createLinuxInspector } from './linux-inspector.ts';
import { withMarkerState } from './marker-state.ts';
import { nodeProcFs } from './procfs.ts';
import type { ProcFs } from './procfs.ts';
import { createWindowsInspector } from './windows-inspector.ts';

export type InspectorPorts = {
  run: CommandRunner;
  procfs: ProcFs;
  env: Readonly<Record<string, string | undefined>>;
  uid(): number;
  capability: LockCapabilityProbe;
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

export const hostInspectorPorts = (): InspectorPorts => ({ run: nodeCommandRunner, procfs: nodeProcFs, env: process.env, uid: hostUid, capability: hostLockCapability });

export const createProcessInspector = (platform: NodeJS.Platform, ports: InspectorPorts): ProcessInspector => {
  switch (platform) {
    case 'darwin':
      return withMarkerState(createDarwinInspector({ run: ports.run }), ports.capability);
    case 'linux':
      return withMarkerState(createLinuxInspector({ procfs: ports.procfs, uid: ports.uid() }), ports.capability);
    case 'win32':
      return withMarkerState(createWindowsInspector({ run: ports.run, env: ports.env }), ports.capability);
    default:
      throw new UnsupportedPlatformError(platform, 'process inspection');
  }
};

export const hostProcessInspector = (ports: InspectorPorts): ProcessInspector => createProcessInspector(process.platform, ports);

let hostInspector: ProcessInspector | undefined;

export const defaultProcessInspector = (): ProcessInspector => {
  hostInspector ??= hostProcessInspector(hostInspectorPorts());
  return hostInspector;
};
