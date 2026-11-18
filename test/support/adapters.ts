export type AdapterScan = 'host-uses' | 'clock-reads' | 'synchronous-file-calls' | 'synchronous-paths' | 'platform-name';

export type Adapter = {
  readonly name: string;
  readonly file: string;
  readonly reason: string;
  readonly owner: string;
  readonly scans: readonly AdapterScan[];
};

export const ADAPTER_TABLE: readonly Adapter[] = [
  { name: 'Timing', file: 'packages/foundation/src/system-timing.ts', owner: 'foundation', scans: ['host-uses', 'clock-reads'], reason: 'the one production Timing adapter over the host timers and clocks: systemTiming, whose timers never hold the process open, and systemWaitTiming, whose timers hold it open until the wait ends' },
  { name: 'Random', file: 'packages/foundation/src/system-random.ts', owner: 'foundation', scans: ['host-uses'], reason: 'the one production Random adapter over node:crypto' },
  { name: 'FileSystem', file: 'packages/foundation/src/node-file-system.ts', owner: 'foundation', scans: ['host-uses', 'synchronous-file-calls'], reason: 'the one production FileSystem adapter over node:fs' },
  { name: 'command runner', file: 'packages/foundation/src/platform/command-runner.ts', owner: 'foundation', scans: ['host-uses'], reason: 'the one production adapter that runs a host command' },
  { name: 'tools ports', file: 'packages/tools/src/node-ports.ts', owner: 'tools', scans: ['host-uses'], reason: 'the one production adapter module of tools: the child-and-timer port, the shell host and the host-bound factories' },
  { name: 'group launch', file: 'packages/foundation/src/platform/group-launch.ts', owner: 'foundation', scans: ['host-uses'], reason: 'the one production adapter of the group launch: it spawns the leader of a process group' },
  { name: 'ProcessGroupPort', file: 'packages/foundation/src/platform/group-port.ts', owner: 'foundation', scans: ['host-uses', 'platform-name'], reason: 'the one production ProcessGroupPort adapter: it signals a process group through process.kill and reads its members; POSIX process groups and Windows job semantics are the platform, not a probe-able feature (B2)' },
  { name: 'KeeperHost', file: 'packages/foundation/src/platform/windows-keeper-host.ts', owner: 'foundation', scans: ['host-uses'], reason: 'the one production KeeperHost adapter: it starts the Windows keeper and listens on its pipe' },
  { name: 'pattern check', file: 'packages/foundation/src/pattern-check.ts', owner: 'foundation', scans: ['host-uses'], reason: 'the one production adapter that runs untrusted schema patterns off the event loop, in a worker thread' },
  { name: 'lifeline', file: 'packages/foundation/src/lifeline.ts', owner: 'foundation', scans: ['host-uses'], reason: 'the one production adapter of the lifeline: it watches the inherited descriptor as a socket and yields a turn between its lines' },
  { name: 'daemon entry', file: 'packages/foundation/src/daemon-entry.ts', owner: 'foundation', scans: ['host-uses'], reason: 'the composition root of every daemon process: host streams, signals and timers' },
  { name: 'CLI ports', file: 'packages/cli/src/node-ports.ts', owner: 'cli-tui', scans: ['host-uses', 'synchronous-paths'], reason: 'the composition root of the CLI ports; the real path of the secret program, checked for its owners when a secret command chooses the store' },
  { name: 'update ports', file: 'packages/cli/src/update/node-ports.ts', owner: 'supervisor-update-packaging', scans: ['host-uses'], reason: 'the composition root of the update ports' },
  { name: 'terminal host', file: 'packages/cli/src/tui/terminal/host.ts', owner: 'cli-tui', scans: ['host-uses'], reason: 'the composition root of the terminal layer ports: the synchronous write to the terminal descriptor and the process signals' },
  { name: 'gateway process ports', file: 'packages/gateway/src/process-ports.ts', owner: 'gateway-core', scans: ['host-uses'], reason: 'the composition root of the gateway process ports, through which the gateway process takes the OS for the B15 layout conventions' },
  { name: 'runtime process', file: 'packages/runtime/src/process/start-runtime-process.ts', owner: 'runtime-service', scans: ['host-uses'], reason: 'the composition root of the runtime process' },
  { name: 'synchronous paths', file: 'packages/foundation/src/sync-paths.ts', owner: 'foundation', scans: ['synchronous-file-calls', 'synchronous-paths'], reason: 'the synchronous driver of the one path resolution algorithm' },
  { name: 'foundation exports', file: 'packages/foundation/src/index.ts', owner: 'foundation', scans: ['synchronous-paths'], reason: 'exports the synchronous driver of the one path resolution algorithm' },
  { name: 'supervisor start', file: 'packages/supervisor/src/start-supervisor.ts', owner: 'supervisor-update-packaging', scans: ['synchronous-paths', 'platform-name'], reason: 'the real path of the secret program, checked for its owners when the store is chosen once at start; passes the OS to the B15 layout conventions' },
  { name: 'B15 endpoint kind', file: 'packages/foundation/src/socket-path.ts', owner: 'foundation', scans: ['platform-name'], reason: 'the kind of socket a host offers, a unix socket or a named pipe, is an OS convention (B15)' },
  { name: 'B15 paths', file: 'packages/foundation/src/momonga-paths.ts', owner: 'foundation', scans: ['platform-name'], reason: 'OS conventions for where files live and the kind of socket (B15)' },
  { name: 'B15 layout', file: 'packages/config/src/layout.ts', owner: 'config', scans: ['platform-name'], reason: 'passes the OS to the B15 layout conventions' },
  { name: 'runtime entry', file: 'packages/runtime/src/process/entry.ts', owner: 'runtime-service', scans: ['platform-name'], reason: 'passes the OS to the B15 layout conventions' },
  { name: 'supervisor entry', file: 'packages/supervisor/src/entry.ts', owner: 'supervisor-update-packaging', scans: ['platform-name'], reason: 'passes the OS to the B15 layout conventions' },
  { name: 'reaper pass', file: 'packages/supervisor/src/reaper-pass.ts', owner: 'supervisor-update-packaging', scans: ['platform-name'], reason: 'passes the OS to the B15 layout conventions' },
  { name: 'process contract', file: 'packages/foundation/src/process-contract.ts', owner: 'foundation', scans: ['platform-name'], reason: 'conventions of which variables each OS needs (B17)' },
  { name: 'release assets', file: 'packages/foundation/src/release-assets.ts', owner: 'supervisor-update-packaging', scans: ['platform-name'], reason: 'asset names are release-engineering names (B19)' },
  { name: 'update source', file: 'packages/cli/src/update/source.ts', owner: 'supervisor-update-packaging', scans: ['platform-name'], reason: 'signing is a macOS fact (B19)' },
  { name: 'spawn port', file: 'packages/supervisor/src/spawn-port.ts', owner: 'supervisor-update-packaging', scans: ['platform-name'], reason: 'the detached spawn form differs by API (B21)' },
];

export const adapterFilesOf = (scan: AdapterScan): Readonly<Record<string, string>> =>
  Object.fromEntries(ADAPTER_TABLE.filter((adapter) => adapter.scans.includes(scan)).map((adapter) => [adapter.file, adapter.reason]));
