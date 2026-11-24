import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

const sectionOf = (text: string, heading: string): string => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === heading);
  if (start === -1) return '';
  const level = heading.indexOf(' ');
  const length = lines.slice(start + 1).findIndex((line) => new RegExp(`^#{1,${level}} `).test(line));
  return lines.slice(start + 1, length === -1 ? undefined : start + 1 + length).join('\n');
};

describe('the documents state that a model request can be sent twice (Q20 B3)', () => {
  const guide = sectionOf(read('site/docs/guide.md'), '### Models');
  const threat = sectionOf(read('site/docs/threat-model.md'), '## A model request can be sent twice');

  it.for([
    ['site/docs/guide.md', guide],
    ['site/docs/threat-model.md', threat],
  ] as const)('%s states the double send, its record, and the setting that prevents it', ([, text]) => {
    expect(text).toContain('sent twice');
    expect(text).toMatch(/after a crash/i);
    expect(text).toContain('`idempotencyKeyHeader`');
    expect(text).toContain('`retry_of`');
    expect(text).not.toContain('/v1/momonga/usage');
    expect(text).toMatch(/trace/);
  });

  it('the guide points to the threat model from the Models section', () => {
    expect(guide).toContain('threat-model.md');
  });

  it('the threat model says what a server without such a header does with the second request', () => {
    expect(threat).toMatch(/bill/);
    expect(threat).toContain('`models.connections`');
  });

  it('neither text calls a model an alias or a target', () => {
    expect(`${guide}\n${threat}`).not.toMatch(/\balias|\btarget/i);
  });
});
