import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import { capabilitiesFor, developerTexts, harness, inputFor } from './helpers.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ictx-')));
  tempDirs.push(dir);
  return dir;
};

const kernelFoldsCase = (): boolean => {
  const probe = path.join(makeDir(), 'CaseProbe');
  fs.mkdirSync(probe);
  try {
    return fs.statSync(probe).ino === fs.statSync(path.join(path.dirname(probe), 'caseprobe')).ino;
  } catch {
    return false;
  }
};

const CASE_INSENSITIVE = kernelFoldsCase();

describe('AGENTS.md containment', () => {
  it.runIf(CASE_INSENSITIVE)('loads an AGENTS.md whose real path differs from the root only in case', async () => {
    const root = makeDir();
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'AGENTS.md'), 'project rules');
    const realPath = path.join(root, 'PROJECT', 'AGENTS.md');
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities, {
      files: { [path.join(project, 'AGENTS.md')]: { realPath, text: 'project rules' } },
    });
    const result = await buildContext(inputFor(capabilities, { projectRoot: project }), ports);
    expect(developerTexts(result.input).some((text) => text.includes('project rules'))).toBe(true);
    expect(result.notices.some((notice) => notice.code === 'instructions_outside_project')).toBe(false);
  });

  it('still ignores one outside the project', async () => {
    const root = makeDir();
    const project = path.join(root, 'project');
    const outside = path.join(root, 'project-other');
    fs.mkdirSync(project);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'AGENTS.md'), 'foreign rules');
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities, {
      files: { [path.join(project, 'AGENTS.md')]: { realPath: path.join(outside, 'AGENTS.md'), text: 'foreign rules' } },
    });
    const result = await buildContext(inputFor(capabilities, { projectRoot: project }), ports);
    expect(developerTexts(result.input).some((text) => text.includes('foreign rules'))).toBe(false);
    expect(result.notices.some((notice) => notice.code === 'instructions_outside_project')).toBe(true);
  });
});
