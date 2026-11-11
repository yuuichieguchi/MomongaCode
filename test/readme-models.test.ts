import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { momongaLayout } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';

const README = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'README.md'), 'utf8');

const modelsSection = (): string => {
  const lines = README.split('\n');
  const start = lines.findIndex((line) => line === '### Models');
  if (start === -1) return '';
  const length = lines.slice(start + 1).findIndex((line) => /^#{1,3} /.test(line));
  return lines.slice(start + 1, length === -1 ? undefined : start + 1 + length).join('\n');
};

const jsonBlocksOf = (section: string): string[] => [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? '');

describe('the README states the model settings in the shape the product loads (design-model-names A32)', () => {
  it('every JSON block under Models loads with the product loader, without a warning, and holds at least one model', async (context) => {
    const blocks = jsonBlocksOf(modelsSection());
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const home = withTempDir(context, { asHome: true });
      const file = momongaLayout(home, process.platform, process.env).settingsFile;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, block, { mode: 0o600 });
      const loaded = await loadUserSettings({ home });
      expect(loaded.warnings).toEqual([]);
      expect(loaded.settings.models.models.size).toBeGreaterThan(0);
    }
  });

  it('the README names none of models.targets, models.aliases and --model <alias>', () => {
    expect(['models.targets', 'models.aliases', '--model <alias>', '"targets"', '"aliases"'].filter((token) => README.includes(token))).toEqual([]);
    expect(README).toContain('`models.connections`');
    expect(README).toContain('`--model <model>`');
  });
});
