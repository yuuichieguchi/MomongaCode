import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { codeDigestOf, codeDigestOfRunningProcess } from '@momonga/foundation';

const foundationSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'code-digest.ts');

const sha256Of = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const trees: string[] = [];

afterEach(() => {
  for (const tree of trees.splice(0)) fs.rmSync(tree, { recursive: true, force: true });
});

const SOURCES: Readonly<Record<string, string>> = {
  'packages/foundation/src/code-digest.ts': 'export const digest = 1;\n',
  'packages/foundation/src/index.ts': "export * from './code-digest.ts';\n",
  'packages/gateway/src/core/estimate.ts': 'export const ratio = 4;\n',
  'packages/cli/src/main.ts': "console.log('momonga');\n",
};

const sourceTree = (files: Readonly<Record<string, string>> = SOURCES): string => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-code-digest-')));
  trees.push(root);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
};

const fromSources = (root: string) => ({ loadedFrom: path.join(root, 'packages', 'foundation', 'src', 'code-digest.ts'), isSea: false, execPath: '/unused/node' });

describe('the code digest of an unbundled CLI covers the product sources', () => {
  it('changes when a product source file other than code-digest.ts changes', async () => {
    const root = sourceTree();
    const before = await codeDigestOf(fromSources(root));
    fs.writeFileSync(path.join(root, 'packages', 'gateway', 'src', 'core', 'estimate.ts'), 'export const ratio = 5;\n');
    const after = await codeDigestOf(fromSources(root));
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
  });

  it('changes when a product source file is added', async () => {
    const root = sourceTree();
    const before = await codeDigestOf(fromSources(root));
    fs.writeFileSync(path.join(root, 'packages', 'cli', 'src', 'added.ts'), 'export {};\n');
    expect(await codeDigestOf(fromSources(root))).not.toBe(before);
  });

  it('changes when content moves from one source file to another, so the file names are part of the digest', async () => {
    const left = sourceTree({ ...SOURCES, 'packages/cli/src/a.ts': 'xy', 'packages/cli/src/b.ts': '' });
    const right = sourceTree({ ...SOURCES, 'packages/cli/src/a.ts': 'x', 'packages/cli/src/b.ts': 'y' });
    expect(await codeDigestOf(fromSources(left))).not.toBe(await codeDigestOf(fromSources(right)));
  });

  it('is the same for two trees with the same sources', async () => {
    expect(await codeDigestOf(fromSources(sourceTree()))).toBe(await codeDigestOf(fromSources(sourceTree())));
  });

  it('is not the digest of code-digest.ts alone', async () => {
    const root = sourceTree();
    expect(await codeDigestOf(fromSources(root))).not.toBe(sha256Of(path.join(root, 'packages', 'foundation', 'src', 'code-digest.ts')));
  });
});

describe('the code digest of a bundled CLI or a single executable', () => {
  it('is the sha256 of the bundle the process was loaded from', async () => {
    const root = sourceTree({ ...SOURCES, 'packages/cli/dist/main.js': 'console.log("bundle");\n' });
    const bundle = path.join(root, 'packages', 'cli', 'dist', 'main.js');
    expect(await codeDigestOf({ loadedFrom: bundle, isSea: false, execPath: '/unused/node' })).toBe(sha256Of(bundle));
  });

  it('is the sha256 of the executable for a single executable', async () => {
    const root = sourceTree({ ...SOURCES, 'bin/momonga': 'executable bytes' });
    const executable = path.join(root, 'bin', 'momonga');
    expect(await codeDigestOf({ loadedFrom: path.join(root, 'packages', 'cli', 'dist', 'main.js'), isSea: true, execPath: executable })).toBe(sha256Of(executable));
  });
});

describe('the code digest of the running process', () => {
  it('in a source checkout is the digest of the checkout sources, not of the foundation module alone', async () => {
    const running = await codeDigestOfRunningProcess();
    expect(running).not.toBe(sha256Of(foundationSource));
    expect(running).toBe(await codeDigestOf({ loadedFrom: foundationSource, isSea: false, execPath: process.execPath }));
  });

  it('has one producer: the eval host no longer keeps its own copy', () => {
    const cliEvalCopy = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'src', 'eval', 'code-digest.ts');
    expect(fs.existsSync(cliEvalCopy)).toBe(false);
  });

  it('is imported from @momonga/foundation by the gateway and by the commands that run the eval host, and the eval host does not compute it', () => {
    const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const importsFromFoundation = (source: string): boolean =>
      /import \{[^}]*\bcodeDigestOfRunningProcess\b[^}]*\} from '@momonga\/foundation'/.test(fs.readFileSync(path.join(packages, source), 'utf8'));
    const gatewaySources = fs
      .readdirSync(path.join(packages, 'gateway', 'src'), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .map((file) => path.join('gateway', 'src', file));
    expect(gatewaySources.some(importsFromFoundation)).toBe(true);
    expect(importsFromFoundation(path.join('cli', 'src', 'commands', 'evaluate.ts'))).toBe(true);
    expect(importsFromFoundation(path.join('cli', 'src', 'commands', 'context.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(packages, 'cli', 'src', 'eval', 'context-host.ts'), 'utf8')).not.toMatch(/\bcodeDigestOf\w*\b|createHash/);
  });
});
