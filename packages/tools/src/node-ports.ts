import { spawn } from 'node:child_process';
import { nodeFileSystem } from '@momonga/foundation';
import type { FileCandidates } from '@momonga/foundation';
import type { PolicyHostFilesystem } from '@momonga/policy';
import { executableCheckOn } from './builtins/shell.ts';
import type { ShellHost, ShellPorts } from './builtins/shell.ts';
import { directoryEntriesOn, fileCandidatesOn } from './file-listing.ts';
import type { FileListingOptions, FileListingPorts } from './file-listing.ts';
import { policyFilesystemOn } from './policy-filesystem.ts';
import type { ChildPorts } from './ports.ts';
import { ripgrepLocatorOn } from './ripgrep-locator.ts';
import type { HostRipgrepLocatorOptions, RipgrepLocator } from './ripgrep-locator.ts';
import { workTreeObserverOn } from './work-tree-observer.ts';
import type { GitWorkTreeObserverOptions, WorkTreeObserver } from './work-tree-observer.ts';

export const nodeChildPorts = (): ChildPorts => ({
  spawn: (file, args, { cwd, env, signal }) =>
    spawn(file, [...args], { env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'], ...(cwd === undefined ? {} : { cwd }), ...(signal === undefined ? {} : { signal }) }),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
});

export const nodeShellPorts = (): ShellPorts => ({ isExecutable: executableCheckOn(nodeFileSystem), env: process.env });

export const nodeShellHost = (): ShellHost => ({ platform: process.platform, isExecutable: executableCheckOn(nodeFileSystem), child: nodeChildPorts() });

export const createPolicyFilesystem = (
  platform: NodeJS.Platform = process.platform,
  shellPorts: ShellPorts = nodeShellPorts(),
  childPorts: ChildPorts = nodeChildPorts(),
): PolicyHostFilesystem => policyFilesystemOn(platform, shellPorts, childPorts);


export const createHostRipgrepLocator = (options: HostRipgrepLocatorOptions): RipgrepLocator => ripgrepLocatorOn(nodeFileSystem, options);

export const createGitWorkTreeObserver = (options: GitWorkTreeObserverOptions): WorkTreeObserver =>
  workTreeObserverOn({ child: nodeChildPorts(), files: nodeFileSystem, searchPath: process.env['PATH'], processId: process.pid }, options);

const hostListing = (): FileListingPorts => ({ child: nodeChildPorts(), files: nodeFileSystem });

export const listFileCandidates = (options: FileListingOptions): Promise<FileCandidates> => fileCandidatesOn(hostListing(), options);

export const listDirectoryEntries = (options: FileListingOptions): Promise<string[]> => directoryEntriesOn(hostListing(), options);
