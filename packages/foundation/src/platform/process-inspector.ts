import { nodeCommandRunner } from './command-runner.ts';
import type { CommandRunner } from './command-runner.ts';
import { createDarwinInspector } from './darwin-inspector.ts';
import type { ProcessInspector } from './inspector-types.ts';
import { createLinuxInspector } from './linux-inspector.ts';
import { nodeProcFs } from './procfs.ts';
import type { ProcFs } from './procfs.ts';
import { createWindowsInspector } from './windows-inspector.ts';

export const PS_PROBE_TIMEOUT_MS = 2000;

export type InspectorPorts = {
  run: CommandRunner;
  procfs: ProcFs;
  env: Readonly<Record<string, string | undefined>>;
  startTimeoutMs: number;
};

export class UnsupportedPlatformError extends Error {
  readonly platform: string;

  constructor(platform: string, capability: string) {
    super(`${capability} is not supported on ${platform}; supported platforms are darwin, linux and win32`);
    this.name = 'UnsupportedPlatformError';
    this.platform = platform;
  }
}

export const hostInspectorPorts = (): InspectorPorts => ({ run: nodeCommandRunner, procfs: nodeProcFs, env: process.env, startTimeoutMs: PS_PROBE_TIMEOUT_MS });

export const createProcessInspector = (platform: NodeJS.Platform, ports: InspectorPorts): ProcessInspector => {
  switch (platform) {
    case 'darwin':
      return createDarwinInspector({ run: ports.run, startTimeoutMs: ports.startTimeoutMs });
    case 'linux':
      return createLinuxInspector({ procfs: ports.procfs });
    case 'win32':
      return createWindowsInspector({ run: ports.run, env: ports.env });
    default:
      throw new UnsupportedPlatformError(platform, 'process inspection');
  }
};

let hostInspector: ProcessInspector | undefined;

export const defaultProcessInspector = (): ProcessInspector => {
  hostInspector ??= createProcessInspector(process.platform, hostInspectorPorts());
  return hostInspector;
};
