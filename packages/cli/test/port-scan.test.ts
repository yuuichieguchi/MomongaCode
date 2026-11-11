import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packagesDir = path.resolve(import.meta.dirname, '..', '..');

type Rule = { names: string; pattern: RegExp };

const HOST_GLOBALS: readonly Rule[] = [
  { names: 'an import of node:fs', pattern: /from 'node:fs(\/promises)?'/ },
  { names: 'an import of node:os', pattern: /from 'node:os'/ },
  { names: 'an import of node:child_process', pattern: /from 'node:child_process'/ },
  { names: 'an import of node:timers', pattern: /from 'node:timers(\/promises)?'/ },
  { names: 'process.kill', pattern: /(?<![.\w])process\.kill\b/ },
  { names: 'process.pid', pattern: /(?<![.\w])process\.pid\b/ },
  { names: 'process.getuid', pattern: /(?<![.\w])process\.getuid\b/ },
  { names: 'Date.now', pattern: /\bDate\.now\b/ },
  { names: 'randomUUID', pattern: /\brandomUUID\b/ },
  { names: 'a timer of the host', pattern: /(?<![.\w])(setTimeout|setInterval)\(/ },
  { names: 'the production clock of foundation', pattern: /\bsystem(Clock|Timing)\b/ },
];

const HOST_FILES: Rule = { names: 'the production file system of foundation', pattern: /\bnodeFileSystem\b/ };

type Scanned = { root: string; rules: readonly Rule[]; adapters: readonly string[] };

const SCANNED: readonly Scanned[] = [
  {
    root: 'cli/src',
    rules: HOST_GLOBALS,
    adapters: [
      'node-ports.ts',
      'update/node-ports.ts',
      'ripgrep/host.ts',
      'handover/replace-process.ts',
      'eval/workspace-probe.ts',
      'tui/run-interactive.tsx',
      'tui/terminal/host.ts',
      'tui/screen/clipboard-host.ts',
    ],
  },
  { root: 'eval/src', rules: [...HOST_GLOBALS, HOST_FILES], adapters: ['files.ts'] },
];

const sourcesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourcesUnder(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

const findingsOf = (file: string, rules: readonly Rule[]): string[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) => rules.filter((rule) => rule.pattern.test(line)).map((rule) => `${path.relative(packagesDir, file)}:${index + 1} names ${rule.names}`));

describe('time, randomness, processes and files are reached through ports', () => {
  for (const scanned of SCANNED) {
    const root = path.join(packagesDir, scanned.root);
    const adapters = new Set(scanned.adapters.map((name) => path.join(root, name)));

    it(`no file under packages/${scanned.root} names a host global, except the adapters listed by name`, () => {
      const findings = sourcesUnder(root)
        .filter((file) => !adapters.has(file))
        .flatMap((file) => findingsOf(file, scanned.rules));

      expect(findings).toEqual([]);
    });

    it(`every listed adapter of packages/${scanned.root} exists and names a host global`, () => {
      const idle = [...adapters].filter((file) => !fs.existsSync(file) || findingsOf(file, scanned.rules).length === 0);

      expect(idle.map((file) => path.relative(packagesDir, file))).toEqual([]);
    });
  }
});
