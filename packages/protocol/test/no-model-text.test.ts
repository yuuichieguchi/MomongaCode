import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messageOf } from '@momonga/protocol';

const root = path.resolve(import.meta.dirname, '../../..');

const sourcesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourcesUnder(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.generated.ts') ? [full] : [];
  });

const productSources = (): string[] =>
  fs.readdirSync(path.join(root, 'packages'), { withFileTypes: true }).flatMap((entry) => {
    const src = path.join(root, 'packages', entry.name, 'src');
    return entry.isDirectory() && fs.existsSync(src) ? sourcesUnder(src) : [];
  });

const RETIRED_WORDINGS = ['no model target', 'target_not_ready: ', 'TARGET_NOT_READY}: ', 'The gateway lists no models', 'to find a local model server'];

describe('the text for "no model is connected"', () => {
  it('the shell text names the shell commands and never the interactive /login', () => {
    const shell = messageOf('noModelConnected', 'cli');
    expect(shell).toContain('momonga models add');
    expect(shell).toContain('momonga auth login');
    expect(shell).not.toContain('/login');
  });

  it('the interactive text names /login', () => {
    expect(messageOf('noModelConnected', 'tui')).toContain('/login');
  });

  it('no product source carries an older wording of the condition or the code as a lead', () => {
    const found = productSources().flatMap((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return RETIRED_WORDINGS.filter((wording) => text.includes(wording)).map((wording) => `${path.relative(root, file)}: ${wording}`);
    });
    expect(found).toEqual([]);
  });
});
