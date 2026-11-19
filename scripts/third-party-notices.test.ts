import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleInputsOf, bundleThreadOf, defaultEntry, journalThreadEntry, repoRoot, ruleVerifierThreadEntry } from './bundle.ts';
import { SEA_NODE_VERSION } from './node-runtime.ts';
import { RIPGREP_VERSION } from './ripgrep-release.ts';
import { UNBOUNDED_BUILD_WAIT_MS } from './support/build-wait.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { componentOfPackage, generateNotices, hostNoticeSources, thirdPartyPackagesOf } from './third-party-notices.ts';
import type { BundleInputs } from './bundle.ts';

const read = (file: string): string => fs.readFileSync(`${repoRoot}${file}`, 'utf8');

const writePackage = (directory: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
  return directory;
};

describe('the third-party notices generator, on fixtures', () => {
  let root = '';
  let recorded = '';

  beforeAll(() => {
    root = createTempRoot();
    recorded = path.join(root, 'recorded');
    fs.mkdirSync(recorded);
  });

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('takes the licence files a package ships, with its name, version and declared licence', () => {
    const directory = writePackage(path.join(root, 'node_modules', 'shipped'), { name: 'shipped', version: '1.2.3', license: 'MIT' }, { LICENSE: 'MIT text of shipped\n', 'NOTICE.md': 'notice of shipped\n' });
    expect(componentOfPackage(directory, recorded)).toEqual({
      name: 'shipped',
      version: '1.2.3',
      licence: 'MIT',
      texts: [
        { file: 'LICENSE', text: 'MIT text of shipped\n' },
        { file: 'NOTICE.md', text: 'notice of shipped\n' },
      ],
    });
  });

  it('fails on a package that ships no licence file and has no recorded copy', () => {
    const directory = writePackage(path.join(root, 'node_modules', 'bare'), { name: 'bare', version: '0.1.0', license: 'MIT' });
    expect(() => componentOfPackage(directory, recorded)).toThrow(`bare@0.1.0 (${directory}) ships no licence file, and ${path.join(recorded, 'bare@0.1.0.txt')} does not exist`);
  });

  it('takes the recorded copy of a package that ships no licence file, for exactly that version', () => {
    const directory = writePackage(path.join(root, 'node_modules', 'quiet'), { name: 'quiet', version: '2.0.0', license: 'MIT' });
    fs.writeFileSync(path.join(recorded, 'quiet@2.0.0.txt'), 'recorded MIT text of quiet\n');
    expect(componentOfPackage(directory, recorded).texts).toEqual([{ file: 'quiet@2.0.0.txt', text: 'recorded MIT text of quiet\n' }]);
  });

  it('refuses a recorded copy beside a licence file the package ships', () => {
    const directory = writePackage(path.join(root, 'node_modules', 'both'), { name: 'both', version: '1.0.0', license: 'MIT' }, { LICENSE: 'shipped text\n' });
    fs.writeFileSync(path.join(recorded, 'both@1.0.0.txt'), 'recorded text\n');
    expect(() => componentOfPackage(directory, recorded)).toThrow(`both@1.0.0 ships its licence file, so the recorded copy ${path.join(recorded, 'both@1.0.0.txt')} must be removed`);
  });

  it('treats a package that declares a licence as third-party and the product\'s own packages, which declare none, as not', () => {
    const own = writePackage(path.join(root, 'packages', 'own'), { name: '@momonga/own', version: '0.0.0' });
    const vendored = writePackage(path.join(root, 'packages', 'vendored'), { name: '@momonga/vendored', version: '1.0.0', license: 'MIT' }, { LICENSE: 'x' });
    const nested = writePackage(path.join(root, 'node_modules', 'outer', 'node_modules', 'inner'), { name: 'inner', version: '3.0.0', license: 'ISC' }, { LICENSE: 'x' });
    fs.mkdirSync(path.join(own, 'src'), { recursive: true });
    fs.mkdirSync(path.join(nested, 'lib'), { recursive: true });
    const inputs: BundleInputs = {
      'packages/own/src/a.ts': { bytes: 1, imports: [] },
      'packages/vendored/lib.js': { bytes: 1, imports: [] },
      'node_modules/outer/node_modules/inner/lib/index.js': { bytes: 1, imports: [] },
      'node_modules/outer/node_modules/inner/package.json': { bytes: 1, imports: [] },
    };
    expect(thirdPartyPackagesOf([inputs], root)).toEqual([nested, vendored].sort());
  });
});

describe('the third-party notices of the released executable', () => {
  let generated = '';
  let packages: readonly string[] = [];

  beforeAll(async () => {
    const inputs = await Promise.all([defaultEntry, journalThreadEntry, ruleVerifierThreadEntry].map((entry) => bundleInputsOf(entry)));
    packages = thirdPartyPackagesOf(inputs, repoRoot).map((directory) => (JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as { name: string }).name);
    generated = await generateNotices(hostNoticeSources());
  }, UNBOUNDED_BUILD_WAIT_MS);

  it('names every package the bundles take from bundleInputsOf, highlight.js among them', () => {
    expect(packages).toContain('highlight.js');
    expect(packages).toContain('@momonga/ata-validator');
    expect(packages).not.toContain('@momonga/foundation');
    for (const name of packages) expect(generated).toContain(`## ${name} `);
  });

  it('names Node.js, the Z3 solver with what its bundle takes, ripgrep and the mingw-w64 runtime of the Windows keeper', () => {
    expect(generated).toContain(`## Node.js ${SEA_NODE_VERSION}`);
    expect(generated).toContain('OpenSSL');
    expect(generated).toMatch(/^## z3-solver /m);
    expect(generated).toMatch(/^## async-mutex /m);
    expect(generated).toContain(`## ripgrep ${RIPGREP_VERSION}`);
    expect(generated).toContain('NOTICE.txt');
    expect(generated).toContain('## mingw-w64 runtime');
  });

  it('takes the yoga-layout licence as its upstream LICENSE at v3.2.1 has it, with Facebook, Inc. as the copyright holder', () => {
    expect(read('scripts/third-party-licences/yoga-layout@3.2.1.txt')).toContain('Copyright (c) Facebook, Inc. and its affiliates.');
  });

  it('is the THIRD-PARTY-NOTICES.md of the repository', () => {
    expect(read('THIRD-PARTY-NOTICES.md')).toBe(generated);
  });

  it('puts the generated notices in the release, so that SHA256SUMS and its signature cover it', () => {
    const release = read('scripts/release.sh');
    expect(release).toContain('THIRD-PARTY-NOTICES.md');
    expect(release).toContain('run npm run notices -- --output "$NOTICES"');
    expect(release).not.toContain('cp "$ROOT/$NOTICES_NAME"');
  });

  it('mentions the bundled ripgrep in the License section of the README', () => {
    const readme = read('README.md');
    const license = /## 10\. License\n([\s\S]*?)\n## 11\. Disclaimer/.exec(readme)?.[1] ?? '';
    expect(license).toContain('Bundles ripgrep (MIT or Unlicense)');
    expect(license).toContain('THIRD-PARTY-NOTICES.md');
  });
});

describe('the legal comments of the thread bundles', () => {
  let root = '';

  beforeAll(() => {
    root = createTempRoot();
  });

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('keeps the legal comment of code a thread bundle contains', async () => {
    fs.writeFileSync(path.join(root, 'licensed.js'), 'export const licensed = () => {\n  /*! fixture component. MIT License. Fixture Author */\n  return 1;\n};\n');
    fs.writeFileSync(path.join(root, 'entry.js'), "import { licensed } from './licensed.js';\nconsole.log(licensed());\n");
    const code = await bundleThreadOf('legal-comment-fixture', path.join(root, 'entry.js'));
    expect(code).toContain('fixture component. MIT License. Fixture Author');
  }, UNBOUNDED_BUILD_WAIT_MS);
});
