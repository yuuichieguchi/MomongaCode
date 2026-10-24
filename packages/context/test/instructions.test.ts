import { describe, expect, it } from 'vitest';
import { PinnedOverflowError, buildContext } from '@momonga/context';
import {
  ROOT_AGENTS,
  TASK,
  USER_AGENTS,
  capabilitiesFor,
  developerTexts,
  harness,
  inputFor,
  textOf,
  touchedFile,
} from './helpers.ts';

const header = (filePath: string, dir: string): string => `Instructions from ${filePath} (applies to ${dir}/**):`;

describe('pinned AGENTS.md', () => {
  it('pins the user-level and root files as developer messages before the task', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities, {
      files: { [USER_AGENTS]: 'user rules', [ROOT_AGENTS]: 'root rules' },
    });
    const result = await buildContext(inputFor(capabilities), ports);
    expect(result.input[0]).toMatchObject({ type: 'message', role: 'system' });
    expect(result.input[1]).toMatchObject({ type: 'message', role: 'developer' });
    expect(result.input[2]).toMatchObject({ type: 'message', role: 'developer' });
    expect(result.input[3]).toMatchObject(TASK);
    const texts = developerTexts(result.input);
    expect(texts[0]).toContain('user rules');
    expect(texts[0]?.startsWith(`Instructions from ${USER_AGENTS}`)).toBe(true);
    expect(texts[1]?.startsWith(header(ROOT_AGENTS, '/proj'))).toBe(true);
    expect(texts[1]).toContain('root rules');
    expect(result.loadedInstructions).toEqual([
      expect.objectContaining({ path: USER_AGENTS, scope: 'user', truncated: false }),
      expect.objectContaining({ path: ROOT_AGENTS, scope: 'root', truncated: false }),
    ]);
  });

  it('includes pinned instructions in the prefix digest', async () => {
    const capabilities = capabilitiesFor(200000);
    const first = await buildContext(
      inputFor(capabilities),
      harness(capabilities, { files: { [ROOT_AGENTS]: 'root rules' } }).ports,
    );
    const second = await buildContext(
      inputFor(capabilities),
      harness(capabilities, { files: { [ROOT_AGENTS]: 'root rules changed' } }).ports,
    );
    expect(second.prefixDigest).not.toBe(first.prefixDigest);
  });

  it('skips the root file with a notice when the project is untrusted', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities, {
      files: { [USER_AGENTS]: 'user rules', [ROOT_AGENTS]: 'root rules' },
    });
    const result = await buildContext(inputFor(capabilities, { trusted: false }), ports);
    const texts = developerTexts(result.input);
    expect(texts.some((text) => text.includes('root rules'))).toBe(false);
    expect(texts.some((text) => text.includes('user rules'))).toBe(true);
    expect(result.notices.some((notice) => notice.code === 'root_instructions_untrusted')).toBe(true);
    expect(result.loadedInstructions.some((entry) => entry.path === ROOT_AGENTS)).toBe(false);
  });

  it('emits no untrusted notice when the project has no root file', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const result = await buildContext(inputFor(capabilities, { trusted: false }), ports);
    expect(result.notices.some((notice) => notice.code === 'root_instructions_untrusted')).toBe(false);
  });

  it('throws PinnedOverflowError when pinned instructions exceed I', async () => {
    const capabilities = capabilitiesFor(4000);
    const { ports } = harness(capabilities, { files: { [ROOT_AGENTS]: 'r'.repeat(16000) } });
    const error = await buildContext(inputFor(capabilities), ports).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PinnedOverflowError);
    expect((error as PinnedOverflowError).inputBudget).toBe(2920);
  });
});

describe('nested AGENTS.md', () => {
  it('loads files between the root and touched paths, closest last, before the task', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports, reader } = harness(capabilities, {
      files: {
        [ROOT_AGENTS]: 'root rules',
        '/proj/src/AGENTS.md': 'src rules',
        '/proj/src/lib/AGENTS.md': 'lib rules',
        '/outside/AGENTS.md': 'outside rules',
      },
    });
    const result = await buildContext(
      inputFor(capabilities, { touchedPaths: [touchedFile('/proj/src/lib/file.ts'), touchedFile('/outside/x.ts')] }),
      ports,
    );
    const taskIndex = result.input.findIndex((item) => item.type === 'message' && item.role === 'user');
    expect(taskIndex).toBe(result.input.length - 1);
    const beforeTask = result.input.slice(taskIndex - 2, taskIndex);
    const nested = beforeTask.map((item) => (item.type === 'message' && item.role === 'developer' ? textOf(item.content) : ''));
    expect(nested[0]?.startsWith(header('/proj/src/AGENTS.md', '/proj/src'))).toBe(true);
    expect(nested[0]).toContain('src rules');
    expect(nested[1]?.startsWith(header('/proj/src/lib/AGENTS.md', '/proj/src/lib'))).toBe(true);
    expect(nested[1]).toContain('lib rules');
    expect(developerTexts(result.input).filter((text) => text.includes('root rules')).length).toBe(1);
    expect(developerTexts(result.input).some((text) => text.includes('outside rules'))).toBe(false);
    expect(reader.reads).not.toContain('/outside/AGENTS.md');
    expect(result.loadedInstructions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/proj/src/AGENTS.md', scope: 'nested' }),
        expect.objectContaining({ path: '/proj/src/lib/AGENTS.md', scope: 'nested' }),
      ]),
    );
  });

  it('loads nothing nested when no path was touched', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities, { files: { '/proj/src/AGENTS.md': 'src rules' } });
    const result = await buildContext(inputFor(capabilities), ports);
    expect(developerTexts(result.input)).toEqual([]);
    expect(result.loadedInstructions).toEqual([]);
  });

  it('drops the oldest-loaded nested file with a notice when protected does not fit', async () => {
    const capabilities = capabilitiesFor(4000);
    const { ports } = harness(capabilities, {
      files: { '/proj/a/AGENTS.md': 'A'.repeat(6000), '/proj/b/AGENTS.md': 'B'.repeat(6000) },
    });
    const result = await buildContext(
      inputFor(capabilities, { touchedPaths: [touchedFile('/proj/a/x.ts'), touchedFile('/proj/b/y.ts')] }),
      ports,
    );
    const texts = developerTexts(result.input);
    expect(texts.some((text) => text.includes('AAAA'))).toBe(false);
    expect(texts.some((text) => text.startsWith(header('/proj/b/AGENTS.md', '/proj/b')))).toBe(true);
    expect(result.notices.some((notice) => notice.code === 'instructions_dropped' && notice.message.includes('/proj/a/AGENTS.md'))).toBe(true);
    expect(result.inputTokens).toBeLessThanOrEqual(result.budget.I);
  });

  it('caps each file at 32 KiB and marks it truncated', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities, { files: { '/proj/src/AGENTS.md': 'q'.repeat(40000) } });
    const result = await buildContext(inputFor(capabilities, { touchedPaths: [touchedFile('/proj/src/a.ts')] }), ports);
    const text = developerTexts(result.input)[0] ?? '';
    const kept = text.split('').filter((character) => character === 'q').length;
    expect(kept).toBeLessThanOrEqual(32768);
    expect(kept).toBeGreaterThanOrEqual(32000);
    expect(new TextEncoder().encode(text).length).toBeLessThan(40000);
    expect(result.loadedInstructions).toEqual([
      expect.objectContaining({ path: '/proj/src/AGENTS.md', scope: 'nested', truncated: true }),
    ]);
  });

  it('ignores a symlinked file whose target is outside the project, with a notice', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities, {
      files: {
        '/proj/src/AGENTS.md': { realPath: '/etc/evil/AGENTS.md', text: 'evil rules' },
        '/proj/src/lib/AGENTS.md': { realPath: '/proj/shared/AGENTS.md', text: 'shared rules' },
      },
    });
    const result = await buildContext(inputFor(capabilities, { touchedPaths: [touchedFile('/proj/src/lib/a.ts')] }), ports);
    const texts = developerTexts(result.input);
    expect(texts.some((text) => text.includes('evil rules'))).toBe(false);
    expect(texts.some((text) => text.includes('shared rules'))).toBe(true);
    expect(result.notices.some((notice) => notice.code === 'instructions_outside_project')).toBe(true);
    expect(result.loadedInstructions.some((entry) => entry.path === '/proj/src/AGENTS.md')).toBe(false);
  });

  it('ignores a root file whose symlink target is outside the project', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities, {
      files: { [ROOT_AGENTS]: { realPath: '/tmp/other/AGENTS.md', text: 'foreign root' } },
    });
    const result = await buildContext(inputFor(capabilities), ports);
    expect(developerTexts(result.input).some((text) => text.includes('foreign root'))).toBe(false);
    expect(result.notices.some((notice) => notice.code === 'instructions_outside_project')).toBe(true);
  });
});
