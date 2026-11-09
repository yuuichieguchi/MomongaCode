import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { RIPGREP_VERSION } from './ripgrep-release.ts';

const read = (file: string): string => fs.readFileSync(`${repoRoot}${file}`, 'utf8');

describe('third-party notices for the bundled ripgrep', () => {
  it('has THIRD-PARTY-NOTICES.md at the repository root naming ripgrep, its version, its licence and where its notice text is', () => {
    const notices = read('THIRD-PARTY-NOTICES.md');
    expect(notices).toContain('ripgrep');
    expect(notices).toContain(RIPGREP_VERSION);
    expect(notices).toMatch(/Unlicense/);
    expect(notices).toMatch(/MIT/);
    expect(notices).toContain('NOTICE.txt');
  });

  it('puts the notices file in the release, so that SHA256SUMS and its signature cover it', () => {
    const release = read('scripts/release.sh');
    expect(release).toContain('THIRD-PARTY-NOTICES.md');
  });

  it('mentions the bundled ripgrep in the License section of the README, without adding a section', () => {
    const readme = read('README.md');
    const license = /## 10\. License\n([\s\S]*?)\n## 11\. Disclaimer/.exec(readme)?.[1] ?? '';
    expect(license).toContain('Bundles ripgrep (MIT or Unlicense)');
    expect(license).toContain('THIRD-PARTY-NOTICES.md');
    expect(readme.match(/^## /gm)).toHaveLength(11);
  });
});
