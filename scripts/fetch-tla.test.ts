import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { TEST_SETUP_COMMAND, fetchTlaJar, requireTlaJar, tlaJarPathOf } from './fetch-tla.ts';
import { HAS_POSIX_SHELL } from './support/host.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

describe('requireTlaJar', () => {
  let root = '';

  beforeEach(() => {
    root = createTempRoot();
  });

  afterEach(async () => {
    await removeTempRoot(root);
  });

  it('names the one setup command when the jar is absent', () => {
    expect(() => requireTlaJar(root)).toThrow(`${tlaJarPathOf(root)} is missing: run ${TEST_SETUP_COMMAND}`);
  });

  it('returns the path of a jar that is present', () => {
    fs.mkdirSync(path.dirname(tlaJarPathOf(root)), { recursive: true });
    fs.writeFileSync(tlaJarPathOf(root), 'jar bytes');
    expect(requireTlaJar(root)).toBe(tlaJarPathOf(root));
  });
});

describe.skipIf(!HAS_POSIX_SHELL)('fetchTlaJar, the step of npm run test:setup', () => {
  let root = '';

  const envWith = (url: string): NodeJS.ProcessEnv => ({ PATH: '/usr/bin:/bin', TLC_JAR_URL: url });

  beforeEach(() => {
    root = createTempRoot();
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(`${repoRoot}scripts/tlc.sh`, path.join(root, 'scripts', 'tlc.sh'));
  });

  afterEach(async () => {
    await removeTempRoot(root);
  });

  it('refuses a download whose sha256 is not the pinned one and places no jar', () => {
    const impostor = path.join(root, 'impostor.jar');
    fs.writeFileSync(impostor, 'not the jar');
    expect(() => fetchTlaJar(root, envWith(`file://${impostor}`))).toThrow(/sha256 mismatch/);
    expect(fs.existsSync(tlaJarPathOf(root))).toBe(false);
  });

  it('places the pinned jar where the formal tests read it', () => {
    const pinned = requireTlaJar(repoRoot);
    expect(fetchTlaJar(root, envWith(`file://${pinned}`))).toBe(tlaJarPathOf(root));
    expect(fs.readFileSync(tlaJarPathOf(root)).equals(fs.readFileSync(pinned))).toBe(true);
  });

  it('is the test:setup script of the package', () => {
    const scripts: unknown = JSON.parse(fs.readFileSync(`${repoRoot}package.json`, 'utf8')).scripts;
    expect(scripts).toMatchObject({ 'test:setup': 'node scripts/fetch-tla.ts' });
    expect(TEST_SETUP_COMMAND).toBe('npm run test:setup');
  });
});
