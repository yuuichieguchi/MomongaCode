import { createHostFilesystem, createHostGlobExpander } from '@momonga/policy';
import type { GlobExpander, PolicyHostFilesystem } from '@momonga/policy';
import { resolveBashPath } from './builtins/shell.ts';
import type { ShellPorts } from './builtins/shell.ts';
import type { ChildPorts } from './ports.ts';

export const createGlobExpander = (platform: NodeJS.Platform, shellPorts: ShellPorts, ports: ChildPorts): GlobExpander =>
  createHostGlobExpander(() => resolveBashPath(platform, shellPorts), shellPorts.env, ports);

export const policyFilesystemOn = (platform: NodeJS.Platform, shellPorts: ShellPorts, childPorts: ChildPorts): PolicyHostFilesystem =>
  createHostFilesystem(platform, () => resolveBashPath(platform, shellPorts), shellPorts.env, childPorts);
