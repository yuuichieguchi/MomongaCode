import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { sha256Hex } from '@momonga/foundation';
import type { CompactionInputItem, InputItem } from '@momonga/protocol';
import { PrefixChangedError, buildContext, createFsInstructionReader } from '@momonga/context';
import type { BuildContextInput, ContextSources } from '@momonga/context';
import {
  READ_TOOL,
  ROOT_AGENTS,
  SYSTEM_PROMPT,
  TASK,
  USER_AGENTS,
  assistant,
  call,
  capabilitiesFor,
  developerTexts,
  harness,
  inputFor,
  output,
  outputTextOf,
  sourcesWith,
  tokensOfItem,
  touchedDirectory,
  touchedFile,
  user,
} from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ctx-review-')));
  dirs.push(dir);
  return dir;
};

describe('untrusted nested instructions', () => {
  it('never reads nested files in an untrusted project and emits one notice', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports, reader } = harness(capabilities, {
      files: { '/proj/src/AGENTS.md': 'src rules', '/proj/src/lib/AGENTS.md': 'lib rules' },
    });
    const result = await buildContext(
      inputFor(capabilities, { trusted: false, touchedPaths: [touchedFile('/proj/src/lib/a.ts')] }),
      ports,
    );
    expect(reader.reads).not.toContain('/proj/src/AGENTS.md');
    expect(reader.reads).not.toContain('/proj/src/lib/AGENTS.md');
    expect(developerTexts(result.input)).toEqual([]);
    expect(result.notices.filter((notice) => notice.code === 'nested_instructions_untrusted')).toHaveLength(1);
    expect(result.loadedInstructions).toEqual([]);
  });

  it('emits no nested notice when no nested candidate exists', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const result = await buildContext(
      inputFor(capabilities, { trusted: false, touchedPaths: [touchedFile('/proj/src/lib/a.ts')] }),
      ports,
    );
    expect(result.notices.some((notice) => notice.code === 'nested_instructions_untrusted')).toBe(false);
  });

  it('checks the untrusted root file with exists and never reads it', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports, reader } = harness(capabilities, { files: { [ROOT_AGENTS]: 'root rules' } });
    const result = await buildContext(inputFor(capabilities, { trusted: false }), ports);
    expect(reader.reads).not.toContain(ROOT_AGENTS);
    expect(reader.existsChecks).toContain(ROOT_AGENTS);
    expect(result.notices.some((notice) => notice.code === 'root_instructions_untrusted')).toBe(true);
  });
});

describe('stable itemCap', () => {
  it('renders a truncated output byte-identically after a large observed error', async () => {
    const capabilities = capabilitiesFor(4000);
    const { ports, meter } = harness(capabilities);
    const bigText = `HEAD${'m'.repeat(8000)}TAIL`;
    const history = [user(1, 'current'), call(2, 'big'), output(3, 'big', bigText, 'pre-big')];
    const build = async () => buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports);
    const first = await build();
    meter.observe({ inputDigest: first.inputDigest, inputTokens: Math.ceil(first.inputTokens * 1.5) });
    const second = await build();
    expect(second.budget.I).toBeLessThan(first.budget.I);
    expect(outputTextOf(second.input, 'big')).toBe(outputTextOf(first.input, 'big'));
    const truncated = first.input.find((item) => item.type === 'function_call_output') as InputItem;
    expect(tokensOfItem(truncated)).toBeLessThanOrEqual(Math.max(64, Math.floor(0.25 * (4000 - 1000 - 80))));
    expect(tokensOfItem(truncated)).toBeGreaterThan(Math.max(64, Math.floor(0.25 * second.budget.I)));
  });
});

describe('expectedPinnedDigest', () => {
  const files = { [USER_AGENTS]: 'user rules', [ROOT_AGENTS]: 'root rules', '/proj/src/AGENTS.md': 'src rules' };
  const base = (overrides: Partial<ContextSources> = {}): ContextSources =>
    sourcesWith({ tools: [READ_TOOL], history: [user(1, 'q'), assistant(2, 'a')], ...overrides });
  const capabilities = capabilitiesFor(200000);
  const summary = { item: { type: 'compaction', encrypted_content: 'enc' } as CompactionInputItem, replacedThroughSeq: 2 };

  const pinnedOf = async () => (await buildContext(inputFor(capabilities, { sources: base() }), harness(capabilities, { files }).ports));

  it('returns both pinnedDigest and prefixDigest', async () => {
    const first = await pinnedOf();
    expect(first.pinnedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.prefixDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.pinnedDigest).not.toBe(first.prefixDigest);
  });

  it.for<[string, Partial<BuildContextInput>]>([
    ['nested instructions', { touchedPaths: [touchedFile('/proj/src/a.ts')] }],
    ['activated skills', { sources: base({ activatedSkills: [{ name: 'skill', content: 'skill body' }] }) }],
    ['summary', { sources: base({ summary, history: [user(3, 'next')] }) }],
    ['tools', { sources: base({ tools: [{ ...READ_TOOL, name: 'Read2' }] }) }],
  ])('does not throw when only %s change', async ([, overrides]) => {
    const first = await pinnedOf();
    const result = await buildContext(
      inputFor(capabilities, { sources: base(), ...overrides, expectedPinnedDigest: first.pinnedDigest }),
      harness(capabilities, { files }).ports,
    );
    expect(result.pinnedDigest).toBe(first.pinnedDigest);
    expect(result.prefixDigest).not.toBe(first.prefixDigest);
  });

  it.for<[string, Partial<ContextSources>, Record<string, string>]>([
    ['system prompt', { systemPrompt: `${SYSTEM_PROMPT} v2` }, files],
    ['task', { task: { ...TASK, content: 'Another task.' } }, files],
    ['user AGENTS.md', {}, { ...files, [USER_AGENTS]: 'user rules v2' }],
    ['root AGENTS.md', {}, { ...files, [ROOT_AGENTS]: 'root rules v2' }],
  ])('throws PrefixChangedError when the %s changes', async ([, sourceOverrides, changedFiles]) => {
    const first = await pinnedOf();
    const error = await buildContext(
      inputFor(capabilities, { sources: base(sourceOverrides), expectedPinnedDigest: first.pinnedDigest }),
      harness(capabilities, { files: changedFiles }).ports,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrefixChangedError);
    expect((error as PrefixChangedError).expected).toBe(first.pinnedDigest);
  });
});

describe('fs reader rejects non-regular files', () => {
  it('treats a FIFO named AGENTS.md as absent without blocking', async () => {
    const dir = makeDir();
    const fifo = path.join(dir, 'AGENTS.md');
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [fifo]);
    const reader = createFsInstructionReader();
    const started = performance.now();
    const result = await Promise.race([
      reader.read(fifo),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000).unref()),
    ]);
    expect(result).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('treats a unix socket named AGENTS.md as absent', async () => {
    const dir = makeDir();
    const socketPath = path.join(dir, 'AGENTS.md');
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      expect(await createFsInstructionReader().read(socketPath)).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports exists and realpath', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, 'x');
    const link = path.join(dir, 'link.md');
    fs.symlinkSync(file, link);
    const reader = createFsInstructionReader();
    expect(await reader.exists(file)).toBe(true);
    expect(await reader.exists(path.join(dir, 'missing.md'))).toBe(false);
    expect(await reader.realpath(link)).toBe(file);
    expect(await reader.realpath(path.join(dir, 'missing.md'))).toBeUndefined();
  });
});

describe('symlinked project root', () => {
  it('loads root and nested files when the project root path goes through a symlink', async () => {
    const realProject = makeDir();
    const linkParent = makeDir();
    const linkedRoot = path.join(linkParent, 'project-link');
    fs.symlinkSync(realProject, linkedRoot);
    fs.writeFileSync(path.join(realProject, 'AGENTS.md'), 'linked root rules');
    fs.mkdirSync(path.join(realProject, 'src'));
    fs.writeFileSync(path.join(realProject, 'src', 'AGENTS.md'), 'linked src rules');
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const result = await buildContext(
      inputFor(capabilities, {
        projectRoot: linkedRoot,
        home: makeDir(),
        touchedPaths: [touchedFile(path.join(linkedRoot, 'src', 'a.ts'))],
      }),
      { ...ports, instructions: createFsInstructionReader() },
    );
    const texts = developerTexts(result.input);
    expect(texts.some((text) => text.includes('linked root rules'))).toBe(true);
    expect(texts.some((text) => text.includes('linked src rules'))).toBe(true);
    expect(result.notices.some((notice) => notice.code === 'instructions_outside_project')).toBe(false);
  });
});

describe('summary boundary validation', () => {
  it('throws RangeError naming the seq when the summary splits a call/output pair', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const history = [user(1, 'q'), call(2, 'c1'), output(3, 'c1', 'r'), user(4, 'next')];
    const summary = { item: { type: 'compaction', encrypted_content: 'enc' } as CompactionInputItem, replacedThroughSeq: 2 };
    const error = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history, summary }) }), ports).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as RangeError).message).toContain('3');
  });
});

describe('positional summary boundary validation', () => {
  it('throws RangeError naming the call_id when a reused id would cover an output whose own call was dropped', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const history = [call(1, 'c1'), output(2, 'c1', 'A'), call(3, 'c1'), output(4, 'c1', 'B'), user(5, 'next')];
    const summary = { item: { type: 'compaction', encrypted_content: 'enc' } as CompactionInputItem, replacedThroughSeq: 1 };
    const error = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history, summary }) }), ports).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as RangeError).message).toContain('c1');
  });
});

describe('touched path kinds', () => {
  it('never looks for AGENTS.md inside a touched file path', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports, reader } = harness(capabilities, { files: { '/proj/src/AGENTS.md': 'src rules' } });
    const result = await buildContext(inputFor(capabilities, { touchedPaths: [touchedFile('/proj/src/a.ts')] }), ports);
    expect([...reader.reads, ...reader.existsChecks]).not.toContain('/proj/src/a.ts/AGENTS.md');
    expect(developerTexts(result.input).some((text) => text.includes('src rules'))).toBe(true);
  });

  it('loads a touched directory own AGENTS.md', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities, {
      files: { '/proj/src/AGENTS.md': 'src rules', '/proj/src/lib/AGENTS.md': 'lib rules' },
    });
    const result = await buildContext(inputFor(capabilities, { touchedPaths: [touchedDirectory('/proj/src/lib')] }), ports);
    const texts = developerTexts(result.input);
    expect(texts.findIndex((text) => text.includes('src rules'))).toBe(0);
    expect(texts.findIndex((text) => text.includes('lib rules'))).toBe(1);
  });
});

describe('loaded instruction hashes', () => {
  it('reports textSha256 of the loaded text', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities, { files: { '/proj/src/AGENTS.md': 'src rules' } });
    const result = await buildContext(inputFor(capabilities, { touchedPaths: [touchedFile('/proj/src/a.ts')] }), ports);
    expect(result.loadedInstructions).toEqual([
      expect.objectContaining({ path: '/proj/src/AGENTS.md', textSha256: sha256Hex('src rules'), truncated: false }),
    ]);
  });

  it('hashes the capped text of a file over 32 KiB', async () => {
    const capabilities = capabilitiesFor(200000);
    const full = 'q'.repeat(40000);
    const { ports } = harness(capabilities, { files: { '/proj/src/AGENTS.md': full } });
    const result = await buildContext(inputFor(capabilities, { touchedPaths: [touchedFile('/proj/src/a.ts')] }), ports);
    expect(result.loadedInstructions).toEqual([
      expect.objectContaining({ truncated: true, textSha256: sha256Hex('q'.repeat(32768)) }),
    ]);
  });
});

describe('summary with a pending call', () => {
  it('accepts a trailing function_call without output when a summary is present', async () => {
    const capabilities = capabilitiesFor(200000);
    const history = [user(1, 'q'), assistant(2, 'a'), user(3, 'next'), call(4, 'pending')];
    const summaryItem = { type: 'compaction', encrypted_content: 'enc' } as CompactionInputItem;
    const withSummary = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history, summary: { item: summaryItem, replacedThroughSeq: 2 } }) }),
      harness(capabilities).ports,
    );
    const without = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history: history.filter((entry) => entry.seq > 2) }) }),
      harness(capabilities).ports,
    );
    expect(withSummary.input.filter((item) => item.type !== 'compaction')).toEqual(without.input);
    expect(withSummary.input.at(-1)).toMatchObject({ type: 'function_call', call_id: 'pending' });
  });
});

describe('frozen digested items', () => {
  const partsHistory = () => [
    { seq: 1, item: { type: 'message' as const, id: 'h1', role: 'user' as const, content: [{ type: 'input_text' as const, text: 'hi' }] } },
    call(2, 'c1'),
    output(3, 'c1', 'result'),
  ];

  it('rejects mutation of a top-level field after a build', async () => {
    const capabilities = capabilitiesFor(200000);
    const history = partsHistory();
    await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), harness(capabilities).ports);
    const callItem = history[1]?.item as { arguments: string };
    expect(() => {
      callItem.arguments = '{"changed":true}';
    }).toThrow(TypeError);
  });

  it('rejects mutation of a nested content part after a build', async () => {
    const capabilities = capabilitiesFor(200000);
    const history = partsHistory();
    await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), harness(capabilities).ports);
    const part = (history[0]?.item as unknown as { content: Array<{ text: string }> }).content[0] as { text: string };
    expect(() => {
      part.text = 'mutated';
    }).toThrow(TypeError);
    const content = (history[0]?.item as unknown as { content: unknown[] }).content;
    expect(() => {
      content.push({ type: 'input_text', text: 'extra' });
    }).toThrow(TypeError);
  });

  it('gives equal digests to structurally equal distinct items', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const first = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history: partsHistory() }) }), ports);
    const second = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history: partsHistory() }) }), ports);
    expect(second.inputDigest).toBe(first.inputDigest);
    expect(second.prefixDigest).toBe(first.prefixDigest);
    expect(second.input).toEqual(first.input);
  });

  it('produces identical results when frozen items are passed again', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const history = partsHistory();
    const first = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports);
    expect(Object.isFrozen(history[0]?.item)).toBe(true);
    const second = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports);
    expect(second.input).toEqual(first.input);
    expect(second.inputDigest).toBe(first.inputDigest);
    expect(second.inputTokens).toBe(first.inputTokens);
  });
});
