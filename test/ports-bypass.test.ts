import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

type Token =
  | 'setTimeout'
  | 'setInterval'
  | 'Date.now'
  | 'performance.now'
  | 'Math.random'
  | 'randomUUID'
  | 'randomBytes'
  | 'node:fs'
  | 'node:fs/promises'
  | 'execFileSync';

type Counts = Partial<Record<Token, number>>;

const TOKENS: Readonly<Record<Token, RegExp>> = {
  setTimeout: /(?<![\w.$])setTimeout\(/g,
  setInterval: /(?<![\w.$])setInterval\(/g,
  'Date.now': /\bDate\.now\(/g,
  'performance.now': /\bperformance\.now\(/g,
  'Math.random': /\bMath\.random\(/g,
  randomUUID: /(?<![\w.$])randomUUID\(/g,
  randomBytes: /(?<![\w.$])randomBytes\(/g,
  'node:fs': /from\s+['"]node:fs['"]/g,
  'node:fs/promises': /from\s+['"]node:fs\/promises['"]/g,
  execFileSync: /(?<![\w.$])execFileSync\(/g,
};

const METHOD_SIGNATURE = /^\s*[\w$]+\(.*\)\s*:\s*[^=]+;\s*$/;

const countBypasses = (source: string): Counts => {
  const body = source
    .split('\n')
    .filter((line) => !METHOD_SIGNATURE.test(line))
    .join('\n');
  const counts: Counts = {};
  for (const [token, pattern] of Object.entries(TOKENS) as Array<[Token, RegExp]>) {
    const found = [...body.matchAll(pattern)].length;
    if (found > 0) counts[token] = found;
  }
  return counts;
};

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts') ? [full] : [];
  });

const productSources = (): string[] =>
  fs
    .readdirSync(path.join(ROOT, 'packages'))
    .filter((name) => name !== 'testkit')
    .map((name) => path.join(ROOT, 'packages', name, 'src'))
    .filter((dir) => fs.existsSync(dir))
    .flatMap(sourceFiles);

const ADAPTERS: Readonly<Record<string, string>> = {
  'packages/foundation/src/system-timing.ts': 'the one production Timing adapter over the host timers and clocks',
  'packages/foundation/src/system-random.ts': 'the one production Random adapter over node:crypto',
  'packages/foundation/src/node-file-system.ts': 'the one production FileSystem adapter over node:fs',
  'packages/foundation/src/platform/command-runner.ts': 'the one production adapter that runs a host command',
  'packages/foundation/src/daemon-entry.ts': 'the composition root of every daemon process: host streams, signals and timers',
  'packages/cli/src/node-ports.ts': 'the composition root of the CLI ports',
  'packages/cli/src/update/node-ports.ts': 'the composition root of the update ports',
  'packages/gateway/src/process-ports.ts': 'the composition root of the gateway process ports',
  'packages/runtime/src/process/start-runtime-process.ts': 'the composition root of the runtime process',
};

const PRESENT_BYPASSES_REASON = 'a present bypass of the Timing, Random or FileSystem port; the increment that adopts the port there removes the entry';

const PRESENT_BYPASSES: Readonly<Record<string, Counts>> = {
  'packages/cli/src/commands/context.ts': { 'randomUUID': 1 },
  'packages/cli/src/eval/context-effects.ts': { 'setTimeout': 1, 'node:fs/promises': 1 },
  'packages/cli/src/ripgrep/host.ts': { 'randomBytes': 1 },
  'packages/cli/src/verify/host.ts': { 'node:fs/promises': 1 },
  'packages/config/src/append-rule.ts': { 'node:fs': 1 },
  'packages/config/src/auto-fit.ts': { 'node:fs': 1 },
  'packages/config/src/auto-mode-dataset.ts': { 'node:fs': 1 },
  'packages/config/src/json-file.ts': { 'node:fs': 1 },
  'packages/config/src/layers.ts': { 'node:fs': 1 },
  'packages/config/src/load-settings.ts': { 'node:fs': 1 },
  'packages/config/src/local-settings.ts': { 'node:fs': 1 },
  'packages/config/src/mcp-servers.ts': { 'node:fs': 1 },
  'packages/config/src/user-settings.ts': { 'node:fs': 1 },
  'packages/context/src/fs-instruction-reader.ts': { 'node:fs': 1, 'node:fs/promises': 1 },
  'packages/eval/src/context-live.ts': { 'node:fs/promises': 1 },
  'packages/eval/src/files.ts': { 'node:fs/promises': 1 },
  'packages/foundation/src/clock.ts': { 'Date.now': 1 },
  'packages/foundation/src/code-digest.ts': { 'node:fs/promises': 1 },
  'packages/foundation/src/file-lock.ts': { 'setTimeout': 1, 'randomBytes': 1 },
  'packages/foundation/src/host-identity.ts': { 'node:fs': 1 },
  'packages/foundation/src/leftover-sweep.ts': { 'node:fs': 1 },
  'packages/foundation/src/lifeline.ts': { 'node:fs': 1 },
  'packages/foundation/src/momonga-paths.ts': { 'node:fs': 1, 'node:fs/promises': 1 },
  'packages/foundation/src/owned-directory.ts': { 'node:fs': 1 },
  'packages/foundation/src/path-compare.ts': { 'node:fs': 1 },
  'packages/foundation/src/platform/file-identity.ts': { 'node:fs': 1 },
  'packages/foundation/src/platform/group-members.ts': { 'node:fs': 1 },
  'packages/foundation/src/platform/holder-file.ts': { 'node:fs': 1 },
  'packages/foundation/src/platform/kernel-lock.ts': { 'node:fs': 1 },
  'packages/foundation/src/platform/privacy.ts': { 'node:fs': 1 },
  'packages/foundation/src/platform/probe-timing.ts': { 'setTimeout': 1, 'Date.now': 1 },
  'packages/foundation/src/platform/procfs.ts': { 'node:fs': 1 },
  'packages/foundation/src/platform/sqlite-lock.ts': { 'node:fs': 1 },
  'packages/foundation/src/process-group.ts': { 'setTimeout': 1, 'Date.now': 1 },
  'packages/foundation/src/process-lock.ts': { 'randomBytes': 1 },
  'packages/foundation/src/process-markers.ts': { 'node:fs': 1 },
  'packages/foundation/src/rotating-log.ts': { 'node:fs': 1 },
  'packages/foundation/src/sqlite.ts': { 'node:fs': 1 },
  'packages/foundation/src/uds.ts': { 'node:fs': 1 },
  'packages/gateway/src/adapters/replay-adapter.ts': { 'node:fs': 1 },
  'packages/gateway/src/managed/fm-processes.ts': { 'randomUUID': 1, 'node:fs': 1 },
  'packages/gateway/src/managed/server.ts': { 'node:fs': 1 },
  'packages/gateway/src/probe/endpoint-record.ts': { 'node:fs': 1 },
  'packages/gateway/src/probe/record.ts': { 'node:fs': 1 },
  'packages/gateway/src/probe/run-probe.ts': { 'performance.now': 4 },
  'packages/mcp/src/stdio-transport.ts': { 'setTimeout': 1, 'randomUUID': 1, 'node:fs': 1 },
  'packages/mcp/src/timers.ts': { 'setTimeout': 1 },
  'packages/policy/src/glob-expansion.ts': { 'performance.now': 1 },
  'packages/runtime/src/memory/evidence.ts': { 'node:fs': 1 },
  'packages/runtime/src/memory/journal-thread-client.ts': { 'setTimeout': 1 },
  'packages/runtime/src/memory/journal-thread.ts': { 'performance.now': 2, 'node:fs': 1 },
  'packages/runtime/src/memory/skill-promotion.ts': { 'node:fs': 1 },
  'packages/runtime/src/memory/upkeep.ts': { 'node:fs': 1 },
  'packages/runtime/src/process/runtime-files.ts': { 'node:fs': 1 },
  'packages/runtime/src/process/tool-runtime.ts': { 'randomBytes': 1 },
  'packages/runtime/src/service/markers.ts': { 'node:fs': 1 },
  'packages/runtime/src/service/timers.ts': { 'setTimeout': 1 },
  'packages/runtime/src/worker/model-stream.ts': { 'setTimeout': 1 },
  'packages/sandbox/src/always-write-denied.ts': { 'node:fs': 1 },
  'packages/sandbox/src/bubblewrap.ts': { 'Date.now': 1, 'node:fs': 1 },
  'packages/sandbox/src/placeholder-journal.ts': { 'node:fs': 1 },
  'packages/sandbox/src/process.ts': { 'node:fs': 1 },
  'packages/sandbox/src/scratch.ts': { 'node:fs': 1 },
  'packages/sandbox/src/seatbelt.ts': { 'node:fs': 1 },
  'packages/skills/src/file-system.ts': { 'node:fs/promises': 1 },
  'packages/store/src/blobs.ts': { 'node:fs': 1 },
  'packages/store/src/runtime-store.ts': { 'node:fs': 1 },
  'packages/store/src/trust.ts': { 'node:fs': 1 },
  'packages/supervisor/src/orphans.ts': { 'node:fs': 1 },
  'packages/supervisor/src/settings-watch.ts': { 'node:fs': 1 },
  'packages/supervisor/src/start-supervisor.ts': { 'setTimeout': 1, 'node:fs': 1 },
  'packages/tools/src/builtins/bash.ts': { 'randomBytes': 1 },
  'packages/tools/src/builtins/edit.ts': { 'node:fs': 1 },
  'packages/tools/src/builtins/files.ts': { 'node:fs': 1 },
  'packages/tools/src/ripgrep-locator.ts': { 'node:fs/promises': 1 },
  'packages/tools/src/builtins/glob.ts': { 'node:fs': 1 },
  'packages/tools/src/builtins/shell.ts': { 'node:fs': 1 },
  'packages/tools/src/builtins/walk.ts': { 'node:fs': 1 },
  'packages/tools/src/builtins/write.ts': { 'node:fs': 1 },
  'packages/tools/src/call-lock.ts': { 'node:fs': 1 },
  'packages/tools/src/capture.ts': { 'setTimeout': 1 },
  'packages/tools/src/executor.ts': { 'setTimeout': 3, 'node:fs': 1 },
  'packages/tools/src/policy-filesystem.ts': { 'setTimeout': 1, 'node:fs': 1 },
  'packages/tools/src/timers.ts': { 'setTimeout': 1 },
  'packages/tools/src/work-tree-observer.ts': { 'node:fs': 1 },
  'packages/verify/src/dialect-model/gate.ts': { 'Date.now': 4 },
  'packages/verify/src/dialect-model/harness.ts': { 'Date.now': 3 },
};

const actualBypasses = (): Record<string, Counts> =>
  Object.fromEntries(
    productSources()
      .map((file) => [path.relative(ROOT, file), countBypasses(fs.readFileSync(file, 'utf8'))] as const)
      .filter(([relative, counts]) => !(relative in ADAPTERS) && Object.keys(counts).length > 0),
  );

describe('ports bypass scan', () => {
  it('counts a direct host call and ignores a port call and a port method signature', () => {
    expect(countBypasses('const timer = setTimeout(done, 5);')).toEqual({ setTimeout: 1 });
    expect(countBypasses('const timer = timing.setTimeout(done, 5);')).toEqual({});
    expect(countBypasses('  setTimeout(callback: () => void, ms: number): unknown;')).toEqual({});
    expect(countBypasses("import fs from 'node:fs';\nimport { readFile } from \"node:fs/promises\";")).toEqual({ 'node:fs': 1, 'node:fs/promises': 1 });
    expect(countBypasses('const id = Date.now() + Math.random() + performance.now();')).toEqual({ 'Date.now': 1, 'Math.random': 1, 'performance.now': 1 });
  });

  it('every production adapter named in the table exists', () => {
    const missing = Object.keys(ADAPTERS).filter((file) => !fs.existsSync(path.join(ROOT, file)));
    expect(missing).toEqual([]);
  });

  it('every adapter and every present bypass carries a reason', () => {
    expect(Object.entries(ADAPTERS).filter(([, reason]) => reason.trim() === '')).toEqual([]);
    expect(PRESENT_BYPASSES_REASON.trim()).not.toBe('');
  });

  it('no file is both an adapter and a present bypass', () => {
    expect(Object.keys(PRESENT_BYPASSES).filter((file) => file in ADAPTERS)).toEqual([]);
  });

  it('the direct host calls outside the adapters are exactly the listed present bypasses', () => {
    expect(actualBypasses()).toEqual(PRESENT_BYPASSES);
  });
});
