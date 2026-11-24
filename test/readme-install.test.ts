import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTALLERS } from '../scripts/site-target.ts';

const README = fs.readFileSync(path.join(import.meta.dirname, '..', 'README.md'), 'utf8');
const GUIDE = fs.readFileSync(path.join(import.meta.dirname, '..', 'site/docs/guide.md'), 'utf8');

const installationSection = (markdown: string): string => {
  const start = markdown.search(/^## (?:1\. )?Installation$/m);
  const rest = markdown.slice(start);
  const end = rest.slice(1).search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end + 1);
};

type Block = { leadIn: string; language: string; command: string };

const blocksOf = (section: string): Block[] => {
  const lines = section.split('\n');
  const blocks: Block[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^```(\S+)$/.exec(lines[index] as string);
    if (open === null) continue;
    let lead = index - 1;
    while (lead >= 0 && (lines[lead] as string).trim() === '') lead -= 1;
    const close = lines.indexOf('```', index + 1);
    blocks.push({ leadIn: lines[lead] as string, language: open[1] as string, command: lines.slice(index + 1, close).join('\n') });
    index = close;
  }
  return blocks;
};

describe('README section 1 and the installers of the site', () => {
  it('names the two installers of the site with their tabs, languages and commands', () => {
    expect(INSTALLERS).toEqual([
      { file: 'install.sh', source: 'scripts/install.sh', tab: 'macOS and Linux', language: 'sh', command: 'curl -fsSL https://momongacode.com/install.sh | bash' },
      { file: 'install.ps1', source: 'scripts/install.ps1', tab: 'Windows, in PowerShell', language: 'powershell', command: 'irm https://momongacode.com/install.ps1 | iex' },
    ]);
  });

  it('carries each installer command in a fenced block led by its tab and a colon in README and guide', () => {
    expect(blocksOf(installationSection(README))).toEqual(INSTALLERS.map((installer) => ({ leadIn: `${installer.tab}:`, language: installer.language, command: installer.command })));
    expect(blocksOf(installationSection(GUIDE))).toEqual(INSTALLERS.map((installer) => ({ leadIn: `${installer.tab}:`, language: installer.language, command: installer.command })));
  });

  it('does not say that no release has been published', () => {
    expect(README).not.toMatch(/no release has been published/i);
    expect(GUIDE).not.toMatch(/no release has been published/i);
  });
});
