import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '@momonga/testkit';
import { claimE2eRun } from './run-setup.ts';

const drawing = (...tokens: string[]): (() => string) => {
  const queue = [...tokens];
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('no token left to draw');
    return next;
  };
};

describe('claimE2eRun', () => {
  it('passes over a token that a directory left by an earlier run still carries, in the e2e root or in the shared base', async (context) => {
    const tmpRoot = withTempDir(context);
    const sharedBase = withTempDir(context);
    fs.mkdirSync(path.join(tmpRoot, 'mme-aaaa-x1y2z3'));
    fs.mkdirSync(path.join(sharedBase, 'mmt-bbbb-q1w2e3'));

    const claimed = claimE2eRun({ tmpRoot, sharedBase, draw: drawing('aaaa', 'bbbb', 'cccc') });

    expect(claimed.run).toBe('cccc');
    await claimed.teardown();
    expect(fs.readdirSync(tmpRoot).sort()).toEqual(['mme-aaaa-x1y2z3']);
  });

  it('passes over a token another run claimed at the same time', (context) => {
    const tmpRoot = withTempDir(context);
    const sharedBase = withTempDir(context);

    const first = claimE2eRun({ tmpRoot, sharedBase, draw: drawing('dddd') });
    const second = claimE2eRun({ tmpRoot, sharedBase, draw: drawing('dddd', 'eeee') });

    expect([first.run, second.run]).toEqual(['dddd', 'eeee']);
  });

  it('refuses, naming the tokens it tried, when every token it drew is in use', (context) => {
    const tmpRoot = withTempDir(context);
    const sharedBase = withTempDir(context);
    fs.mkdirSync(path.join(tmpRoot, 'mme-ffff-a1b2c3'));

    expect(() => claimE2eRun({ tmpRoot, sharedBase, draw: () => 'ffff' })).toThrow(/no free e2e run token after \d+ draws: ffff/);
  });
});
