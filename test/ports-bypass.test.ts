import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { countCliUses, countHostUses, countSynchronousFileCalls } from './support/host-uses.ts';
import { ADAPTER_TABLE, adapterFilesOf } from './support/adapters.ts';
import { ROOT, packageSources, parseSource, perFile, productSources, relativeOf } from './support/source-scan.ts';
import type { Counts, ParsedSource } from './support/source-scan.ts';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const counted = (text: string, count: (source: ParsedSource) => Counts = countHostUses): Counts => count(parseSource('sample.ts', text));

const HOST_USE_ADAPTERS = adapterFilesOf('host-uses');

const DAEMON_PACKAGES: readonly string[] = ['foundation', 'gateway', 'mcp', 'runtime', 'sandbox', 'store', 'supervisor'];

const SYNCHRONOUS_FILE_ADAPTERS = adapterFilesOf('synchronous-file-calls');

const PRESENT_BYPASSES: Readonly<Record<string, Counts>> = {
  'packages/cli/src/handover/replace-process.ts': { 'node:child_process': 1 },
  'packages/cli/src/ripgrep/host.ts': { 'randomBytes': 1 },
  'packages/cli/src/tui/run-interactive.tsx': { 'node:child_process': 1 },
  'packages/cli/src/tui/screen/clipboard-host.ts': { 'node:child_process': 2 },
  'packages/config/src/auto-fit.ts': { 'node:fs': 2 },
  'packages/config/src/auto-mode-dataset.ts': { 'node:fs': 1 },
  'packages/context/src/fs-instruction-reader.ts': { 'node:fs/promises': 3 },
  'packages/eval/src/files.ts': { 'node:fs/promises': 4 },
  'packages/foundation/src/host-identity.ts': { 'node:fs': 2 },
  'packages/foundation/src/outbound.ts': { 'node:net': 1, 'node:worker_threads': 1 },
  'packages/foundation/src/process-contract.ts': { 'AbortSignal.timeout': 1 },
  'packages/foundation/src/rotating-log.ts': { 'node:fs': 7 },
  'packages/foundation/src/socket-path.ts': { 'node:net': 1 },
  'packages/foundation/src/uds.ts': { 'node:fs': 4, 'node:net': 1 },
  'packages/gateway/src/core/store-worker.ts': { 'node:worker_threads': 2 },
  'packages/gateway/src/core/store.ts': { 'node:worker_threads': 1 },
  'packages/gateway/src/managed/fm-processes.ts': { 'node:fs': 4, 'randomUUID': 1 },
  'packages/gateway/src/managed/server.ts': { 'node:fs': 5 },
  'packages/gateway/src/probe/endpoint-record.ts': { 'node:fs': 1 },
  'packages/gateway/src/probe/record.ts': { 'node:fs': 4 },
  'packages/mcp/src/connection.ts': { 'Math.random': 1 },
  'packages/mcp/src/stdio-transport.ts': { 'randomUUID': 1 },
  'packages/mcp/src/timers.ts': { 'setTimeout': 1 },
  'packages/policy/src/glob-expansion.ts': { 'performance.now': 1 },
  'packages/policy/src/host-filesystem.ts': { 'node:child_process': 1, 'setTimeout': 1 },
  'packages/runtime/src/memory/evidence.ts': { 'node:fs': 3 },
  'packages/runtime/src/memory/journal-thread-client.ts': { 'node:worker_threads': 4, 'setTimeout': 1 },
  'packages/runtime/src/memory/journal-thread.ts': { 'node:fs': 1, 'node:worker_threads': 8, 'performance.now': 2, 'setImmediate': 1 },
  'packages/runtime/src/process/rule-verifier-thread-client.ts': { 'node:worker_threads': 1 },
  'packages/runtime/src/process/rule-verifier-thread.ts': { 'node:worker_threads': 5 },
  'packages/runtime/src/process/tool-runtime.ts': { 'randomBytes': 1 },
  'packages/runtime/src/service/timers.ts': { 'setTimeout': 1 },
  'packages/sandbox/src/bubblewrap.ts': { 'node:child_process': 1, 'node:fs': 7 },
  'packages/sandbox/src/placeholder-journal.ts': { 'node:fs': 16 },
  'packages/sandbox/src/relay.ts': { 'node:child_process': 1, 'node:net': 3 },
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
};

const CLI_PRESENT_BYPASSES: Readonly<Record<string, Counts>> = {
  'packages/cli/src/commands/auto-mode.ts': { 'createHostExec': 1 },
  'packages/cli/src/daemon/ensure-daemon.ts': { 'nodeFileSystem': 1 },
  'packages/cli/src/eval/context-effects.ts': { 'createHostExec': 1 },
  'packages/cli/src/keeper/host.ts': { 'nodeFileSystem': 1 },
  'packages/cli/src/ripgrep/host.ts': { 'nodeFileSystem': 1 },
};

const SYNCHRONOUS_FILE_CALLS: Readonly<Record<string, Counts>> = {
  'packages/foundation/src/rotating-log.ts': { 'closeSync': 1, 'fstatSync': 1, 'openSync': 1, 'renameSync': 2, 'statSync': 1, 'writeSync': 1 },
  'packages/gateway/src/managed/fm-processes.ts': { 'closeSync': 1, 'openSync': 1, 'rmSync': 2 },
  'packages/gateway/src/process-ports.ts': { 'existsSync': 1, 'readFileSync': 1, 'statSync': 1 },
  'packages/runtime/src/memory/journal-thread.ts': { 'statSync': 1 },
  'packages/sandbox/src/scratch.ts': { 'statSync': 1 },
  'packages/sandbox/src/seatbelt.ts': { 'accessSync': 1 },
  'packages/supervisor/src/orphans.ts': { 'closeSync': 1, 'openSync': 2, 'rmSync': 1 },
};

const outside = (table: Readonly<Record<string, string>>, files: readonly string[]): string[] => files.filter((file) => !(relativeOf(file) in table));

const actualBypasses = (): Record<string, Counts> => perFile(outside(HOST_USE_ADAPTERS, productSources()), countHostUses);

const actualCliBypasses = (): Record<string, Counts> => perFile(outside(HOST_USE_ADAPTERS, packageSources('cli')), countCliUses);

const actualSynchronousFileCalls = (): Record<string, Counts> => perFile(outside(SYNCHRONOUS_FILE_ADAPTERS, DAEMON_PACKAGES.flatMap(packageSources)), countSynchronousFileCalls);

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
    expect(counted('const bound = AbortSignal.timeout(5);\nconst both = AbortSignal.any([bound, given]);')).toEqual({ 'AbortSignal.timeout': 1 });
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

  it('every permanent adapter exists once in the table with its name, reason, owner and scans', () => {
    expect(ADAPTER_TABLE.filter((adapter) => !fs.existsSync(path.join(ROOT, adapter.file))).map((adapter) => adapter.file)).toEqual([]);
    expect(ADAPTER_TABLE.filter((adapter) => [adapter.name, adapter.reason, adapter.owner].some((text) => text.trim() === '') || adapter.scans.length === 0).map((adapter) => adapter.file)).toEqual([]);
    expect(new Set(ADAPTER_TABLE.map((adapter) => adapter.file)).size).toBe(ADAPTER_TABLE.length);
  });

  it('no file is both an adapter and a present bypass', () => {
    expect(Object.keys(PRESENT_BYPASSES).filter((file) => file in HOST_USE_ADAPTERS)).toEqual([]);
  });

  it('the direct host calls outside the adapters are exactly the listed present bypasses', () => {
    expect(actualBypasses()).toEqual(PRESENT_BYPASSES);
  });

  it('the synchronous file calls on the daemon paths are exactly the listed ones', () => {
    expect(actualSynchronousFileCalls()).toEqual(SYNCHRONOUS_FILE_CALLS);
  });

  it('every scan takes its permanent adapters from the one table and declares none of its own', () => {
    const scans = ['test/ports-bypass.test.ts', 'test/platform-name-branches.test.ts', 'test/async-path-resolution.test.ts'];
    const table = path.join(ROOT, 'test/support/adapters.ts');
    expect(fs.existsSync(table)).toBe(true);
    const own = scans.filter((file) => /\bconst (?:ADAPTERS|SYNCHRONOUS_ADAPTERS|KEPT|SYNCHRONOUS_USERS)\b/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    const readers = scans.filter((file) => /from '\.\/support\/adapters\.ts'/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect({ own, readers }).toEqual({ own: [], readers: scans });
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
