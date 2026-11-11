import { createHostFilesystem, createHostGlobExpander, nodeGlobPorts, resolveBashPath } from '@momonga/policy';
import type { GlobExpander, GlobPorts, PolicyHostFilesystem, ShellPorts } from '@momonga/policy';
import { nodeShellPorts } from './builtins/shell.ts';

export const createGlobExpander = (platform: NodeJS.Platform, shellPorts: ShellPorts, ports: GlobPorts): GlobExpander => createHostGlobExpander(() => resolveBashPath(platform, shellPorts), ports);

export const createPolicyFilesystem = (platform: NodeJS.Platform = process.platform, shellPorts: ShellPorts = nodeShellPorts(), globPorts: GlobPorts = nodeGlobPorts()): PolicyHostFilesystem =>
  createHostFilesystem(platform, () => resolveBashPath(platform, shellPorts), globPorts);
