import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { countCliUses, countHostUses, countSynchronousFileCalls } from './support/host-uses.ts';
import { ROOT, packageSources, parseSource, perFile, productSources, relativeOf } from './support/source-scan.ts';
import type { Counts, ParsedSource } from './support/source-scan.ts';

const counted = (text: string, count: (source: ParsedSource) => Counts = countHostUses): Counts => count(parseSource('sample.ts', text));

const ADAPTERS: Readonly<Record<string, string>> = {
  'packages/foundation/src/system-timing.ts': 'the one production Timing adapter over the host timers and clocks: systemTiming, whose timers never hold the process open, and systemWaitTiming, whose timers hold it open until the wait ends',
  'packages/foundation/src/system-random.ts': 'the one production Random adapter over node:crypto',
  'packages/foundation/src/node-file-system.ts': 'the one production FileSystem adapter over node:fs',
  'packages/foundation/src/platform/command-runner.ts': 'the one production adapter that runs a host command',
  'packages/tools/src/node-ports.ts': 'the one production adapter module of tools: the child-and-timer port, the shell host and the host-bound factories',
  'packages/foundation/src/daemon-entry.ts': 'the composition root of every daemon process: host streams, signals and timers',
  'packages/cli/src/node-ports.ts': 'the composition root of the CLI ports',
  'packages/cli/src/update/node-ports.ts': 'the composition root of the update ports',
  'packages/cli/src/tui/terminal/host.ts': 'the composition root of the terminal layer ports: the synchronous write to the terminal descriptor and the process signals',
  'packages/gateway/src/process-ports.ts': 'the composition root of the gateway process ports',
  'packages/runtime/src/process/start-runtime-process.ts': 'the composition root of the runtime process',
};

const DAEMON_PACKAGES: readonly string[] = ['foundation', 'gateway', 'mcp', 'runtime', 'sandbox', 'store', 'supervisor'];

const SYNCHRONOUS_ADAPTERS: Readonly<Record<string, string>> = {
  'packages/foundation/src/node-file-system.ts': 'the one production FileSystem adapter over node:fs',
  'packages/foundation/src/sync-paths.ts': 'the synchronous driver of the one path resolution algorithm',
};

const PRESENT_BYPASSES: Readonly<Record<string, Counts>> = {
  'packages/cli/src/eval/workspace-probe.ts': { 'node:fs/promises': 3, 'setTimeout': 1 },
  'packages/cli/src/handover/replace-process.ts': { 'node:child_process': 1 },
  'packages/cli/src/ripgrep/host.ts': { 'randomBytes': 1 },
  'packages/cli/src/tui/run-interactive.tsx': { 'node:child_process': 1, 'node:os': 1 },
  'packages/cli/src/tui/screen/clipboard-host.ts': { 'node:child_process': 2 },
  'packages/cli/src/tui/screen/history-view.tsx': { 'setImmediate': 1 },
  'packages/config/src/auto-fit.ts': { 'node:fs': 2 },
  'packages/config/src/auto-mode-dataset.ts': { 'node:fs': 1 },
  'packages/context/src/fs-instruction-reader.ts': { 'node:fs/promises': 3 },
  'packages/eval/src/files.ts': { 'node:fs/promises': 4 },
  'packages/foundation/src/code-digest.ts': { 'node:fs/promises': 7 },
  'packages/foundation/src/generation-reaper.ts': { 'node:fs': 6, 'setImmediate': 1 },
  'packages/foundation/src/handover-leftovers.ts': { 'node:fs': 4 },
  'packages/foundation/src/host-identity.ts': { 'node:fs': 2 },
  'packages/foundation/src/leftover-sweep.ts': { 'node:fs': 2 },
  'packages/foundation/src/lifeline.ts': { 'node:fs': 1, 'node:net': 1, 'setImmediate': 1 },
  'packages/foundation/src/outbound.ts': { 'node:net': 1, 'node:worker_threads': 1 },
  'packages/foundation/src/owned-directory.ts': { 'node:fs': 4 },
  'packages/foundation/src/pattern-check.ts': { 'node:worker_threads': 1 },
  'packages/foundation/src/platform/file-identity.ts': { 'node:fs': 2 },
  'packages/foundation/src/platform/group-launch.ts': { 'node:child_process': 2 },
  'packages/foundation/src/platform/group-members.ts': { 'node:fs': 2 },
  'packages/foundation/src/platform/group-port.ts': { 'process.kill': 3 },
  'packages/foundation/src/platform/holder-file.ts': { 'node:fs': 11 },
  'packages/foundation/src/platform/linux-inspector.ts': { 'node:os': 1 },
  'packages/foundation/src/platform/procfs.ts': { 'node:fs': 5 },
  'packages/foundation/src/platform/sqlite-lock.ts': { 'node:fs': 6, 'node:os': 1 },
  'packages/foundation/src/platform/windows-keeper-host.ts': { 'node:child_process': 1, 'node:net': 1 },
  'packages/foundation/src/rotating-log.ts': { 'node:fs': 8 },
  'packages/foundation/src/short-temp-base.ts': { 'node:os': 1 },
  'packages/foundation/src/socket-path.ts': { 'node:net': 1 },
  'packages/foundation/src/uds.ts': { 'node:fs': 4, 'node:net': 1 },
  'packages/gateway/src/adapters/replay-adapter.ts': { 'node:fs': 10 },
  'packages/gateway/src/managed/fm-processes.ts': { 'node:fs': 4, 'randomUUID': 1 },
  'packages/gateway/src/managed/server.ts': { 'node:fs': 5 },
  'packages/gateway/src/probe/auto-probe.ts': { 'setTimeout': 1 },
  'packages/gateway/src/probe/client.ts': { 'setTimeout': 1 },
  'packages/gateway/src/probe/endpoint-record.ts': { 'node:fs': 1 },
  'packages/gateway/src/probe/ollama.ts': { 'new Date()': 1 },
  'packages/gateway/src/probe/record.ts': { 'node:fs': 4 },
  'packages/gateway/src/probe/run-probe.ts': { 'new Date()': 1, 'performance.now': 4 },
  'packages/mcp/src/connection.ts': { 'Math.random': 1 },
  'packages/mcp/src/stdio-transport.ts': { 'randomUUID': 1 },
  'packages/mcp/src/timers.ts': { 'setTimeout': 1 },
  'packages/policy/src/glob-expansion.ts': { 'performance.now': 1 },
  'packages/policy/src/host-filesystem.ts': { 'node:child_process': 1, 'setTimeout': 1 },
  'packages/runtime/src/memory/evidence.ts': { 'node:fs': 3 },
  'packages/runtime/src/memory/journal-thread-client.ts': { 'node:worker_threads': 4, 'setTimeout': 1 },
  'packages/runtime/src/memory/journal-thread.ts': { 'node:fs': 1, 'node:worker_threads': 8, 'performance.now': 2, 'setImmediate': 1 },
  'packages/runtime/src/memory/skill-promotion.ts': { 'node:fs': 4 },
  'packages/runtime/src/memory/upkeep.ts': { 'node:fs': 1 },
  'packages/runtime/src/process/rule-verifier-thread-client.ts': { 'node:worker_threads': 1 },
  'packages/runtime/src/process/rule-verifier-thread.ts': { 'node:worker_threads': 5 },
  'packages/runtime/src/process/tool-runtime.ts': { 'randomBytes': 1 },
  'packages/runtime/src/service/timers.ts': { 'setTimeout': 1 },
  'packages/runtime/src/worker/model-stream.ts': { 'setTimeout': 1 },
  'packages/runtime/src/worker/touched-paths.ts': { 'setImmediate': 1 },
  'packages/sandbox/src/bubblewrap.ts': { 'node:child_process': 1, 'node:fs': 7 },
  'packages/sandbox/src/placeholder-journal.ts': { 'node:fs': 16 },
  'packages/sandbox/src/scratch.ts': { 'node:fs': 1 },
  'packages/sandbox/src/seatbelt.ts': { 'node:fs': 1 },
  'packages/skills/src/file-system.ts': { 'node:fs/promises': 4 },
  'packages/store/src/derived-repair.ts': { 'setImmediate': 1 },
  'packages/store/src/search.ts': { 'setImmediate': 1 },
  'packages/supervisor/src/child-manager.ts': { 'randomBytes': 1 },
  'packages/supervisor/src/orphans.ts': { 'node:fs': 5 },
  'packages/supervisor/src/settings-watch.ts': { 'node:fs': 1 },
  'packages/supervisor/src/start-supervisor.ts': { 'Math.random': 1, 'setTimeout': 1 },
  'packages/tools/src/operations/askpass-client.ts': { 'node:net': 1 },
  'packages/tools/src/operations/git-credential.ts': { 'node:net': 1 },
  'packages/verify/src/distribution-files.ts': { 'node:fs/promises': 2 },
};

const CLI_PRESENT_BYPASSES: Readonly<Record<string, Counts>> = {
  'packages/cli/src/commands/auto-mode.ts': { 'createHostExec': 1 },
  'packages/cli/src/daemon/ensure-daemon.ts': { 'nodeFileSystem': 1 },
  'packages/cli/src/eval/context-effects.ts': { 'createHostExec': 1 },
  'packages/cli/src/keeper/host.ts': { 'nodeFileSystem': 1 },
  'packages/cli/src/ripgrep/host.ts': { 'nodeFileSystem': 1 },
};

const SYNCHRONOUS_FILE_CALLS: Readonly<Record<string, Counts>> = {
  'packages/foundation/src/handover-leftovers.ts': { 'closeSync': 1, 'fstatSync': 1, 'openSync': 1, 'readFileSync': 1 },
  'packages/foundation/src/lifeline.ts': { 'fstatSync': 1 },
  'packages/foundation/src/owned-directory.ts': { 'mkdirSync': 1, 'rmSync': 1 },
  'packages/foundation/src/platform/file-identity.ts': { 'fstatSync': 1, 'lstatSync': 1 },
  'packages/foundation/src/platform/group-members.ts': { 'readFileSync': 1, 'readdirSync': 1 },
  'packages/foundation/src/platform/holder-file.ts': { 'closeSync': 2, 'ftruncateSync': 1, 'openSync': 2, 'readSync': 2, 'rmSync': 1, 'writeSync': 2 },
  'packages/foundation/src/platform/sqlite-lock.ts': { 'closeSync': 2, 'openSync': 2, 'rmSync': 1, 'unlinkSync': 1 },
  'packages/foundation/src/rotating-log.ts': { 'closeSync': 1, 'fstatSync': 1, 'mkdirSync': 1, 'openSync': 1, 'renameSync': 2, 'statSync': 1, 'writeSync': 1 },
  'packages/gateway/src/adapters/replay-adapter.ts': { 'chmodSync': 1, 'closeSync': 1, 'existsSync': 3, 'mkdirSync': 1, 'openSync': 1, 'readFileSync': 1, 'statSync': 1, 'writeSync': 1 },
  'packages/gateway/src/managed/fm-processes.ts': { 'closeSync': 1, 'openSync': 1, 'rmSync': 2 },
  'packages/gateway/src/process-ports.ts': { 'existsSync': 1, 'readFileSync': 1, 'statSync': 1 },
  'packages/runtime/src/memory/journal-thread.ts': { 'statSync': 1 },
  'packages/runtime/src/memory/upkeep.ts': { 'statSync': 1 },
  'packages/sandbox/src/scratch.ts': { 'statSync': 1 },
  'packages/sandbox/src/seatbelt.ts': { 'accessSync': 1 },
  'packages/supervisor/src/orphans.ts': { 'closeSync': 1, 'openSync': 2, 'rmSync': 1 },
};

const outside = (table: Readonly<Record<string, string>>, files: readonly string[]): string[] => files.filter((file) => !(relativeOf(file) in table));

const actualBypasses = (): Record<string, Counts> => perFile(outside(ADAPTERS, productSources()), countHostUses);

const actualCliBypasses = (): Record<string, Counts> => perFile(outside(ADAPTERS, packageSources('cli')), countCliUses);

const actualSynchronousFileCalls = (): Record<string, Counts> => perFile(outside(SYNCHRONOUS_ADAPTERS, DAEMON_PACKAGES.flatMap(packageSources)), countSynchronousFileCalls);

describe('ports bypass scan', () => {
  it('counts a direct host call and ignores a port call and a port method signature', () => {
    expect(counted('const timer = setTimeout(done, 5);')).toEqual({ setTimeout: 1 });
    expect(counted('const timer = timing.setTimeout(done, 5);')).toEqual({});
    expect(counted('interface Timing {\n  setTimeout(callback: () => void, ms: number): unknown;\n}')).toEqual({});
    expect(counted('const id = Date.now() + Math.random() + performance.now();')).toEqual({ 'Date.now': 1, 'Math.random': 1, 'performance.now': 1 });
  });

  it('counts every call site of a host module, not the import of it', () => {
    expect(counted("import fs from 'node:fs';\nimport { readFile } from \"node:fs/promises\";")).toEqual({});
    expect(counted("import fs from 'node:fs';\nfs.statSync(a);\nfs.readFileSync(b);")).toEqual({ 'node:fs': 2 });
    expect(counted("import { readFile as read } from 'fs/promises';\nawait read(a);")).toEqual({ 'node:fs/promises': 1 });
    expect(counted("import type { Stats } from 'node:fs';\nimport fs from 'node:fs';\nlet stats: fs.Stats | Stats;")).toEqual({});
    expect(counted("import fs from 'node:fs';\nimport net from 'node:net';\nconst flags = fs.constants.O_RDONLY;\nconst family = net.isIP(host);")).toEqual({});
  });

  it('counts a host capability under any name it is imported by', () => {
    expect(counted("import { setTimeout as delay } from 'node:timers/promises';\nawait delay(5);")).toEqual({ setTimeout: 1 });
    expect(counted("import * as timers from 'node:timers';\ntimers.setInterval(tick, 5);")).toEqual({ setInterval: 1 });
    expect(counted("import { randomUUID as id } from 'node:crypto';\nconst a = id();")).toEqual({ randomUUID: 1 });
    expect(counted("import crypto from 'node:crypto';\nconst a = crypto.randomBytes(8);\nconst b = crypto.createHash('sha256');")).toEqual({ randomBytes: 1 });
    expect(counted('const a = crypto.randomUUID();\nconst b = globalThis.crypto.getRandomValues(c);')).toEqual({ 'crypto.randomUUID': 1, 'crypto.getRandomValues': 1 });
    expect(counted("const fs = await import('node:fs');\nconst os = require('os');\nconst net = process.getBuiltinModule('node:net');")).toEqual({ 'node:fs': 1, 'node:os': 1, 'node:net': 1 });
    expect(counted("export { readFile } from 'node:fs/promises';")).toEqual({ 'node:fs/promises': 1 });
  });

  it('counts the host capabilities that have no port call of the same name', () => {
    expect(counted('setImmediate(done);\nglobalThis.setTimeout(done, 1);')).toEqual({ setImmediate: 1, setTimeout: 1 });
    expect(counted('const stamp = new Date();\nconst shown = new Date(stamp.getTime());')).toEqual({ 'new Date()': 1 });
    expect(counted('process.kill(pid, 0);\nconst t = process.hrtime.bigint();')).toEqual({ 'process.kill': 1, 'process.hrtime': 1 });
    expect(counted("import { spawn } from 'node:child_process';\nimport os from 'node:os';\nimport net from 'node:net';\nimport { Worker } from 'node:worker_threads';\nspawn(a);\nos.homedir();\nnet.connect(b);\nnew Worker(c);")).toEqual({
      'node:child_process': 1,
      'node:os': 1,
      'node:net': 1,
      'node:worker_threads': 1,
    });
  });

  it('does not count a name the file binds itself', () => {
    expect(counted('const run = (setTimeout: (done: () => void, ms: number) => void): void => setTimeout(done, 5);')).toEqual({});
    expect(counted("import { process } from './fake.ts';\nprocess.kill(1);")).toEqual({});
  });

  it('counts every synchronous file call by its name', () => {
    expect(counted("import fs, { existsSync as there } from 'node:fs';\nfs.statSync(a);\nfs.readdirSync(b);\nthere(c);\nawait fs.promises.stat(a);", countSynchronousFileCalls)).toEqual({
      statSync: 1,
      readdirSync: 1,
      existsSync: 1,
    });
  });

  it('every production adapter named in the tables exists', () => {
    const missing = [...Object.keys(ADAPTERS), ...Object.keys(SYNCHRONOUS_ADAPTERS)].filter((file) => !fs.existsSync(path.join(ROOT, file)));
    expect(missing).toEqual([]);
  });

  it('every adapter carries a reason', () => {
    expect([...Object.entries(ADAPTERS), ...Object.entries(SYNCHRONOUS_ADAPTERS)].filter(([, reason]) => reason.trim() === '')).toEqual([]);
  });

  it('no file is both an adapter and a present bypass', () => {
    expect(Object.keys(PRESENT_BYPASSES).filter((file) => file in ADAPTERS)).toEqual([]);
  });

  it('the direct host calls outside the adapters are exactly the listed present bypasses', () => {
    expect(actualBypasses()).toEqual(PRESENT_BYPASSES);
  });

  it('the synchronous file calls on the daemon paths are exactly the listed ones', () => {
    expect(actualSynchronousFileCalls()).toEqual(SYNCHRONOUS_FILE_CALLS);
  });

  it('the names the CLI reaches the host by are counted', () => {
    expect(counted('const exec = createHostExec(minimalChildEnv(env));', countCliUses)).toEqual({ createHostExec: 1 });
    expect(counted('await nodeFileSystem.stat(file);', countCliUses)).toEqual({ nodeFileSystem: 1 });
    expect(counted("const home = process.env['HOME'];", countCliUses)).toEqual({ 'process.env': 1 });
    expect(counted("import {\n  nodeFileSystem,\n  createHostExec,\n} from '@momonga/foundation';", countCliUses)).toEqual({});
  });

  it("the CLI's direct createHostExec, nodeFileSystem and process.env uses outside the adapters are exactly the listed present bypasses", () => {
    expect(actualCliBypasses()).toEqual(CLI_PRESENT_BYPASSES);
  });
});
