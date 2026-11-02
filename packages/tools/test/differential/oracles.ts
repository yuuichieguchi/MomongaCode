import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeCommand, commandSpecsFor, programNameOf } from '@momonga/policy';
import type { Analysis, Decision } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { CANARY } from './fixture.ts';
import type { DifferentialWorkspace } from './fixture.ts';

export type Case = {
  command: string;
  mode?: PermissionMode;
  cwd?: string;
  rules?: ReadonlyArray<readonly ['allow' | 'deny' | 'ask', string]>;
  searchPath?: string;
};

export type Outcome = { decision: Decision | 'threw'; ran: boolean; violations: string[] };

const PRINTERS: ReadonlySet<string> = new Set(['echo', 'printf']);
const TRACE_MARKER = '@MM@ ';
const TRACE_LINE = /^@+MM@ (.*)$/;

const snapshot = (base: string): Map<string, string> => {
  const entries = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const name of fs.readdirSync(directory)) {
      const absolute = path.join(directory, name);
      if (absolute.endsWith(`${path.sep}.git${path.sep}index`)) continue;
      const stat = fs.lstatSync(absolute);
      const link = stat.isSymbolicLink() ? fs.readlinkSync(absolute) : '';
      entries.set(absolute, stat.isDirectory() ? `${stat.mode}:directory` : `${stat.mode}:${stat.size}:${stat.mtimeMs}:${link}`);
      if (stat.isDirectory()) walk(absolute);
    }
  };
  walk(base);
  return entries;
};

const changedPaths = (before: Map<string, string>, after: Map<string, string>): string[] => {
  const changed: string[] = [];
  for (const [entry, signature] of after) if (before.get(entry) !== signature) changed.push(entry);
  for (const entry of before.keys()) if (!after.has(entry)) changed.push(entry);
  return changed;
};

const analysedNames = (analysis: Analysis): string[] => [
  ...analysis.segments.flatMap((segment) => {
    const name = programNameOf(segment);
    return name === undefined ? [] : [name];
  }),
  ...analysis.nested.flatMap(analysedNames),
];

const tokensOf = (text: string): string[] => {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (const char of text) {
    if (quoted) {
      if (char === "'") quoted = false;
      else current += char;
    } else if (char === "'") {
      quoted = true;
      started = true;
    } else if (char === ' ') {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else if (char !== '\\') {
      current += char;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
};

const inside = (candidate: string, root: string): boolean => candidate === root || candidate.startsWith(`${root}${path.sep}`);

const canonical = (absolute: string): string | undefined => (fs.existsSync(absolute) ? fs.realpathSync.native(absolute) : undefined);

const traceViolations = (workspace: DifferentialWorkspace, stderr: string, startCwd: string, names: ReadonlySet<string> | undefined): string[] => {
  const violations: string[] = [];
  let cwd = startCwd;
  for (const line of stderr.split('\n')) {
    const match = TRACE_LINE.exec(line);
    if (match === null) continue;
    const [name, ...args] = tokensOf(match[1] as string);
    if (name === undefined) continue;
    if (names !== undefined && !names.has(name)) violations.push(`executed ${name}, which the analysis did not report (${line})`);
    const operands = args.filter((arg) => !arg.startsWith('-') && !arg.includes('='));
    if (name === 'cd') {
      const target = operands[0];
      if (target !== undefined) cwd = canonical(path.resolve(cwd, target)) ?? cwd;
      continue;
    }
    if (PRINTERS.has(name)) continue;
    for (const operand of operands) {
      const resolved = canonical(path.resolve(cwd, operand));
      if (resolved !== undefined && !inside(resolved, workspace.project) && !inside(resolved, '/dev')) {
        violations.push(`read ${resolved}, outside the workspace (${line})`);
      }
    }
  }
  return violations;
};

const SHELL = '/bin/bash';

export const runCase = (workspace: DifferentialWorkspace, input: Case): Outcome => {
  const cwd = input.cwd ?? workspace.project;
  const mode = input.mode ?? 'default';
  const searchPath = input.searchPath;
  let decision: Decision;
  try {
    decision = workspace.decide(input.command, {
      mode,
      cwd,
      ...(input.rules === undefined ? {} : { rules: input.rules }),
      ...(searchPath === undefined ? {} : { searchPath }),
    });
  } catch (error) {
    return { decision: 'threw', ran: false, violations: [`decide threw: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (decision.kind !== 'allow') return { decision, ran: false, violations: [] };

  const before = snapshot(workspace.base);
  const markersBefore = new Set(workspace.firedMarkers());
  const analysis = analyzeCommand(input.command, commandSpecsFor(process.platform));
  const names = analysis === null ? undefined : new Set(analysedNames(analysis));
  const env = workspace.env({ PS4: TRACE_MARKER, ...(searchPath === undefined ? {} : { PATH: searchPath }) });
  const result = spawnSync(SHELL, ['-x', '-c', input.command], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const violations = traceViolations(workspace, result.stderr, cwd, names);
  if (result.stdout.includes(CANARY)) violations.push(`output carries a secret from outside the workspace: ${result.stdout.slice(0, 120)}`);
  for (const marker of workspace.firedMarkers()) if (!markersBefore.has(marker)) violations.push(`a repository configuration ran ${marker}`);
  const after = snapshot(workspace.base);
  const fired = new Set(workspace.firedMarkers());
  for (const entry of changedPaths(before, after)) {
    const permitted = mode === 'acceptEdits' && inside(entry, workspace.project);
    if (!permitted && !(fired.has(path.basename(entry)) && path.dirname(entry) === workspace.base)) violations.push(`changed ${entry}, which the analysis did not report as written`);
  }
  return { decision, ran: true, violations };
};
