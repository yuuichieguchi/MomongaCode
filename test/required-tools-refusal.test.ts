import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from '@momonga/testkit/child-process';
import { createTempDir, REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const REPO = path.resolve(import.meta.dirname, '..');
const VITEST = path.join(REPO, 'node_modules', 'vitest', 'vitest.mjs');
const REQUIRED_TOOLS = path.join(REPO, 'test', 'support', 'required-tools.ts');
const PROJECTS = ['unit', 'e2e', 'packaging', 'calibration'] as const;

let root = '';

beforeEach(() => {
  root = createTempDir();
  const setup = [
    `import { setupWith } from '${REQUIRED_TOOLS}';`,
    'export default (project) => setupWith(project, {',
    "  platform: 'linux', arch: 'x64',",
    '  exists: () => false, versionOf: () => undefined, sha256Of: () => undefined, onPath: () => false,',
    '});',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'setup.mjs'), setup);
  for (const name of PROJECTS) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'x.test.ts'), "test('runs', () => undefined);\n");
  }
  const projects = PROJECTS.map((name) => ({ test: { name, include: [`${name}/**/*.test.ts`], globalSetup: ['./setup.mjs'] } }));
  fs.writeFileSync(path.join(root, 'vitest.config.mjs'), `export default ${JSON.stringify({ test: { globals: true, projects } })};\n`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a missing prerequisite refuses the run with its own text', () => {
  it.each(['e2e', 'packaging', 'unit'] as const)('%s: prints the refusal line verbatim and exits non-zero', (project) => {
    const run = spawnSync(process.execPath, [VITEST, 'run', '--root', root, '--project', project], { cwd: root, encoding: 'utf8', env: { ...process.env, MOMONGA_RUN_LOCK: undefined } });
    const printed = `${run.stdout}${run.stderr}`;
    expect(printed).not.toContain('charCodeAt');
    const tool = project === 'packaging' ? 'zig' : 'bwrap';
    expect(printed).toMatch(new RegExp(`^(?:Error: )?${tool} is required on linux and is missing or unusable at .+; run: .+$`, 'm'));
    expect(run.status).not.toBe(0);
  });
});
