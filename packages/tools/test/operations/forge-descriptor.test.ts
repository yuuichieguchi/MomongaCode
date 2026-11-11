import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForgeDescriptorError, loadForgeDescriptors, parseForgeDescriptor } from '@momonga/tools';
import { LAB_DESCRIPTOR } from '@momonga/testkit';
import { expectRejected } from './support.ts';

const PACKAGES = path.resolve(import.meta.dirname, '../../..');
const DESCRIPTOR_DIR = path.join(PACKAGES, 'tools', 'src', 'forge', 'descriptors');

const VOCABULARY = ['listPullRequests', 'getPullRequest', 'createPullRequest', 'mergePullRequest', 'getBranch', 'listChecks', 'listComments', 'listReviewComments', 'createComment'];

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [full] : [];
  });

const shippedIds = (): string[] =>
  fs
    .readdirSync(DESCRIPTOR_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => String((JSON.parse(fs.readFileSync(path.join(DESCRIPTOR_DIR, file), 'utf8')) as { id: unknown }).id));

describe('forge descriptors', () => {
  it('ships at least one descriptor file, each of which loads and maps the whole vocabulary', () => {
    const ids = shippedIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(loadForgeDescriptors().map((descriptor) => descriptor.id).sort()).toEqual([...ids].sort());
    for (const descriptor of loadForgeDescriptors()) expect(Object.keys(descriptor.operations).sort()).toEqual([...VOCABULARY].sort());
  });

  it('ships the descriptor of the first forge with the id github', () => {
    expect(shippedIds()).toContain('github');
  });

  it('accepts a second forge with different paths, statuses and field names as data alone', () => {
    expect(parseForgeDescriptor(LAB_DESCRIPTOR)).toMatchObject({ id: 'labforge-test' });
  });

  it('rejects a descriptor that leaves out an operation of the vocabulary', () => {
    const { createPullRequest: _dropped, ...operations } = LAB_DESCRIPTOR.operations;
    expectRejected(() => parseForgeDescriptor({ ...LAB_DESCRIPTOR, operations }), ForgeDescriptorError);
  });

  it('rejects a result path outside the dotted subset, such as a filter', () => {
    const operations = { ...LAB_DESCRIPTOR.operations, getPullRequest: { ...LAB_DESCRIPTOR.operations.getPullRequest, result: { ...LAB_DESCRIPTOR.operations.getPullRequest.result, headSha: 'items[?(@.sha)]' } } };
    expectRejected(() => parseForgeDescriptor({ ...LAB_DESCRIPTOR, operations }), ForgeDescriptorError);
  });

  it('rejects an unknown HTTP method', () => {
    const operations = { ...LAB_DESCRIPTOR.operations, createPullRequest: { ...LAB_DESCRIPTOR.operations.createPullRequest, method: 'TRACE' } };
    expectRejected(() => parseForgeDescriptor({ ...LAB_DESCRIPTOR, operations }), ForgeDescriptorError);
  });

  it('is never branched on by name: no source file of any package mentions a shipped descriptor id', () => {
    const ids = shippedIds();
    expect(ids.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const pkg of fs.readdirSync(PACKAGES)) {
      const src = path.join(PACKAGES, pkg, 'src');
      if (!fs.existsSync(src)) continue;
      for (const file of sourceFiles(src)) {
        const text = fs.readFileSync(file, 'utf8');
        for (const id of ids) if (new RegExp(`['"\`]${id}['"\`]`).test(text)) offenders.push(`${path.relative(PACKAGES, file)}: ${id}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
