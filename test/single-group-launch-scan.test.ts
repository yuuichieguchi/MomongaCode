import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');

const PORT_FILES = new Set(['foundation/src/platform/group-launch.ts', 'foundation/src/platform/windows-keeper-host.ts']);

const EXCLUDED_PACKAGES = new Set(['testkit']);

const STARTS_PROCESSES = new RegExp(`from 'node:${['child', 'process'].join('_')}'`);
const DETACHED = /\bdetached\b/;
const PID_AS_GROUP = /(?:\bpgid\s*[:=]\s*|[gG]roup\w*\([^()]*?|\bkill\(\s*-\s*)(?:this\.)?\b(?!process\.pid\b)\w*(?:child|process|proc|handle)\w*(?:\?)?\.pid\b/i;

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.generated.ts') ? [full] : [];
  });

const sources = (): { file: string; text: string }[] =>
  fs
    .readdirSync(packagesDir)
    .filter((name) => !EXCLUDED_PACKAGES.has(name) && fs.existsSync(path.join(packagesDir, name, 'src')))
    .flatMap((name) => sourceFiles(path.join(packagesDir, name, 'src')))
    .map((file) => ({ file: path.relative(packagesDir, file).split(path.sep).join('/'), text: fs.readFileSync(file, 'utf8') }))
    .filter(({ file }) => !PORT_FILES.has(file));

const linesMatching = (text: string, form: RegExp): string[] => text.split('\n').filter((line) => form.test(line));

describe('every process group of the product is started by the one launch of the group port', () => {
  it('the port files exist', () => {
    for (const file of PORT_FILES) expect(fs.existsSync(path.join(packagesDir, file)), file).toBe(true);
  });

  it('no file outside the port starts a process detached', () => {
    const found = sources()
      .filter(({ text }) => STARTS_PROCESSES.test(text) && DETACHED.test(text))
      .map(({ file }) => file);
    expect(found).toEqual([]);
  });

  it('no file outside the port takes the pid of a child as a group number', () => {
    const found = sources().flatMap(({ file, text }) => linesMatching(text, PID_AS_GROUP).map((line) => `${file}: ${line.trim()}`));
    expect(found).toEqual([]);
  });

  it('the forms find the old shapes', () => {
    expect(PID_AS_GROUP.test("await signalGroup(child.pid, 'SIGKILL', undefined, stop);")).toBe(true);
    expect(PID_AS_GROUP.test('process.kill(-child.pid, signal)')).toBe(true);
    expect(PID_AS_GROUP.test('return { pid, pgid: child.pid, stdout }')).toBe(true);
    expect(PID_AS_GROUP.test('recordMarkerGroup(marker, child.pid)')).toBe(true);
    expect(PID_AS_GROUP.test('recordMarkerGroup(marker, launched.pgid)')).toBe(false);
    expect(PID_AS_GROUP.test('holderGroups([process.pid], recorded)')).toBe(false);
  });
});
