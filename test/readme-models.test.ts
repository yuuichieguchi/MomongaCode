import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { momongaLayout } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { renderReference } from '../scripts/reference.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const GUIDE = fs.readFileSync(path.join(ROOT, 'site/docs/guide.md'), 'utf8');
const JUDGING_MODELS = fs.readFileSync(path.join(ROOT, 'site/docs/judging-models.md'), 'utf8');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

const modelsSection = (markdown: string): string => {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line === '### Models');
  if (start === -1) return '';
  const length = lines.slice(start + 1).findIndex((line) => /^#{1,3} /.test(line));
  return lines.slice(start + 1, length === -1 ? undefined : start + 1 + length).join('\n');
};

const jsonBlocksOf = (section: string): string[] => [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? '');

describe('the documentation states the model settings in the shape the product loads (design-model-names A32)', () => {
  it('every JSON block under Models and Judging models loads with the product loader, without a warning, and holds at least one model', async (context) => {
    const blocks = [...jsonBlocksOf(modelsSection(GUIDE)), ...jsonBlocksOf(JUDGING_MODELS)];
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      const home = withTempDir(context, { asHome: true });
      const file = momongaLayout(home, process.platform, process.env).settingsFile;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, block, { mode: 0o600 });
      const loaded = await loadUserSettings({ env: process.env, home, signal: new AbortController().signal });
      expect(loaded.warnings).toEqual([]);
      expect(loaded.settings.models.models.size).toBeGreaterThan(0);
    }
  });

  it('the documentation names none of models.targets, models.aliases and --model <alias>', async () => {
    const forbidden = ['models.targets', 'models.aliases', '--model <alias>', '"targets"', '"aliases"'];
    for (const [name, content] of [
      ['README.md', README],
      ['site/docs/guide.md', GUIDE],
      ['site/docs/judging-models.md', JUDGING_MODELS],
    ] as const) {
      expect(forbidden.filter((token) => content.includes(token)), name).toEqual([]);
    }
    expect(GUIDE).toContain('`models.connections`');
    expect(JUDGING_MODELS).toContain('`models.connections`');
    expect(await renderReference()).toContain('`--model <model>`');
  });
});
