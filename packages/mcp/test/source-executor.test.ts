import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MCP_TOOL_IDLE_TIMEOUT_MS, MCP_TOOL_TOTAL_TIMEOUT_MS } from '@momonga/mcp';
import type { ToolSet } from '@momonga/tools';
import {
  MODERN_FIXTURE_AUDIO_BYTES,
  MODERN_FIXTURE_BLOB_BYTES,
  MODERN_FIXTURE_HOSTILE_DESCRIPTION,
  MODERN_FIXTURE_IMAGE_BYTES,
  MODERN_FIXTURE_LONG_TOOL_NAME,
} from '@momonga/testkit';
import { callRecords, entry, legacyConfig, makeExecutor, makePool, makeRecordFile, modernConfig, readRecords, waitForRecord } from './mcp-harness.ts';

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const UNKNOWN_EFFECTS = 'Its side effects are unknown; inspect the current state before retrying.';

const modernSet = async (options: { requestTimeoutMs?: number; toolIdleTimeoutMs?: number } = {}): Promise<{ set: ToolSet; recordFile: string }> => {
  const recordFile = makeRecordFile();
  const harness = makePool([entry('modern', modernConfig(recordFile))], options);
  return { set: await harness.snapshot(), recordFile };
};

const hash8 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 8);

const DOTTED_PART = `dotted_name_with-slash_${hash8('dotted.name/with-slash')}`;
const DOTTED = `mcp__modern__${DOTTED_PART}`;

const expectedLongName = (): string => {
  const hash = createHash('sha256').update(MODERN_FIXTURE_LONG_TOOL_NAME).digest('hex').slice(0, 8);
  return `mcp__modern__${MODERN_FIXTURE_LONG_TOOL_NAME.slice(0, 42)}_${hash}`;
};

describe('MCP tools through createToolExecutor', () => {
  it('validates input with Ajv before the call reaches the server', async () => {
    const { set, recordFile } = await modernSet();
    const result = await makeExecutor().resultOf(set, 'mcp__modern__add', { a: 'two', b: 2 });
    expect(result.status).toBe('failed');
    expect(result.output.startsWith('Invalid input for mcp__modern__add:')).toBe(true);
    expect(callRecords(recordFile, 'add')).toEqual([]);
  });

  it('denies a call matched by an mcp__<server>__<tool> deny rule without reaching the server', async () => {
    const { set, recordFile } = await modernSet();
    const harness = makeExecutor();
    const result = await harness.resultOf(set, 'mcp__modern__echo', { text: 'hi' }, { rules: [harness.rule('deny', 'mcp__modern__echo')] });
    expect(result.status).toBe('failed');
    expect(result.output.startsWith('Permission denied')).toBe(true);
    expect(callRecords(recordFile, 'echo')).toEqual([]);
  });

  it('asks by default and suggests the exact allow rule', async () => {
    const { set, recordFile } = await modernSet();
    const outcome = await makeExecutor().run(set, 'mcp__modern__echo', { text: 'hi' }, { rules: [] });
    expect(outcome).toMatchObject({
      kind: 'needs_approval',
      decision: { kind: 'ask', source: 'mode' },
      suggestedRule: 'mcp__modern__echo',
      toolKind: 'other',
    });
    expect(callRecords(recordFile, 'echo')).toEqual([]);
  });

  it('runs a call allowed by mcp__modern__echo and returns the text as output and ACP content', async () => {
    const { set, recordFile } = await modernSet();
    const result = await makeExecutor().resultOf(set, 'mcp__modern__echo', { text: 'hello' });
    expect(result).toEqual({ status: 'completed', output: 'hello', content: [{ type: 'content', content: { type: 'text', text: 'hello' } }] });
    expect(callRecords(recordFile, 'echo')).toHaveLength(1);
  });

  it('runs a legacy server tool end to end', async () => {
    const harness = makePool([entry('legacy', legacyConfig())]);
    const set = await harness.snapshot();
    expect(set.tools.map((tool) => tool.name)).toEqual(['mcp__legacy__add', 'mcp__legacy__bare', 'mcp__legacy__echo']);
    const result = await makeExecutor().resultOf(set, 'mcp__legacy__add', { a: 40, b: 2 });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('42');
  });

  it('shows only read-only MCP tools in plan mode and still asks before running them', async () => {
    const { set, recordFile } = await modernSet();
    const visible = set.forModel({ mode: 'plan', rules: [] }).map((tool) => tool.name);
    expect(visible).toEqual(['mcp__modern__content_kinds', 'mcp__modern__read_only']);
    const outcome = await makeExecutor().run(set, 'mcp__modern__read_only', {}, { mode: 'plan', rules: [] });
    expect(outcome).toMatchObject({ kind: 'needs_approval', decision: { kind: 'ask', source: 'mode' }, toolKind: 'read' });
    expect(callRecords(recordFile, 'read_only')).toEqual([]);
  });
});

describe('MCP tool naming', () => {
  it('replaces characters outside [A-Za-z0-9_-] and calls the server with the original name', async () => {
    const { set, recordFile } = await modernSet();
    const result = await makeExecutor().resultOf(set, DOTTED, {});
    expect(result.output).toBe('dotted');
    expect(callRecords(recordFile, 'dotted.name/with-slash')).toHaveLength(1);
    expect(callRecords(recordFile, 'dotted_name_with-slash')).toEqual([]);
  });

  it('keeps a hashed normalized name distinct from a tool already named like the normalization', async () => {
    const { set, recordFile } = await modernSet();
    expect(set.get(DOTTED)?.description).toBe('A tool whose name has punctuation');
    expect(set.get('mcp__modern__dotted_name_with-slash')?.description).toBe('Collides with dotted.name/with-slash after normalization');
    expect(set.notices.filter((notice) => notice.includes('dotted_name_with-slash'))).toEqual([]);
    expect((await makeExecutor().resultOf(set, 'mcp__modern__dotted_name_with-slash', {})).output).toBe('dotted collision');
    expect(callRecords(recordFile, 'dotted_name_with-slash')).toHaveLength(1);
  });

  it('cuts an over-long name to 64 characters with an 8-hex sha256 suffix of the original name', async () => {
    const { set, recordFile } = await modernSet();
    const name = expectedLongName();
    expect(name).toHaveLength(64);
    expect(set.get(name)?.name).toBe(name);
    const result = await makeExecutor().resultOf(set, name, {});
    expect(result.output).toBe('long');
    expect(callRecords(recordFile, MODERN_FIXTURE_LONG_TOOL_NAME)).toHaveLength(1);
  });

  it('lists exactly the registrable modern tools in name order', async () => {
    const { set } = await modernSet();
    expect(set.tools.map((tool) => tool.name)).toEqual([
      'mcp__modern__echo',
      'mcp__modern__add',
      'mcp__modern__slow',
      'mcp__modern__fail',
      'mcp__modern__crash',
      'mcp__modern__image',
      'mcp__modern__structured',
      'mcp__modern__trigger_list_changed',
      'mcp__modern__read_only',
      'mcp__modern__draft07',
      DOTTED,
      expectedLongName(),
      'mcp__modern__catastrophic_output',
      'mcp__modern__content_kinds',
      'mcp__modern__patterned',
      'mcp__modern__dotted_name_with-slash',
    ].sort());
  });
});

describe('MCP tool definitions', () => {
  it('strips control characters other than newline and tab and caps the description at 2048 characters', async () => {
    const { set } = await modernSet();
    const stripped = `Line1\nTab\therebellred${'d'.repeat(3000)}`;
    expect(MODERN_FIXTURE_HOSTILE_DESCRIPTION.length).toBeGreaterThan(stripped.length);
    const description = set.get('mcp__modern__content_kinds')?.description;
    expect(description).toBe(`${stripped.slice(0, 2047)}…`);
    expect(description).toHaveLength(2048);
  });

  it('falls back to the title, then the name, when the description is absent', async () => {
    const { set } = await modernSet();
    expect(set.get('mcp__modern__patterned')?.description).toBe('Patterned Tool');
    const legacy = await makePool([entry('legacy', legacyConfig())]).snapshot();
    expect(legacy.get('mcp__legacy__bare')?.description).toBe('bare');
  });

  it.each([
    ['mcp__modern__echo', 'other', 'write'],
    ['mcp__modern__read_only', 'read', 'read_only'],
    ['mcp__modern__content_kinds', 'read', 'read_only'],
    ['mcp__modern__patterned', 'read', 'write'],
  ])('maps annotations of %s to kind %s and side effect %s', async (name, kind, sideEffect) => {
    const { set } = await modernSet();
    expect(set.get(name)).toMatchObject({ kind, sideEffect });
  });

  it('uses an mcp subject with the normalized tool part, the stdio idle window and the overall limit, not the request timeout', async () => {
    const { set } = await modernSet({ requestTimeoutMs: 45_000 });
    const tool = set.get(DOTTED);
    expect(tool?.subject({}, { cwd: '/', workingDirectory: '/', home: '/', roots: [] })).toEqual({ kind: 'mcp', server: 'modern', tool: DOTTED_PART });
    expect(tool?.idleTimeoutMs).toBe(MCP_TOOL_IDLE_TIMEOUT_MS.stdio);
    expect(tool?.timeoutMs).toBe(MCP_TOOL_TOTAL_TIMEOUT_MS);
    expect(tool?.prepare).toBeUndefined();
    expect(tool?.reconcile).toBeUndefined();
  });
});

describe('MCP result mapping', () => {
  it.each([
    ['image', 'mcp__modern__image', {}, 'completed', `[image image/png, ${Buffer.byteLength(MODERN_FIXTURE_IMAGE_BYTES)} bytes]`],
    ['structuredContent only', 'mcp__modern__structured', {}, 'completed', '{"answer":42,"label":"forty-two"}'],
    ['isError', 'mcp__modern__fail', {}, 'failed', 'fixture failure'],
    ['audio', 'mcp__modern__content_kinds', { kind: 'audio' }, 'completed', `[audio audio/wav, ${Buffer.byteLength(MODERN_FIXTURE_AUDIO_BYTES)} bytes]`],
    ['resource_link', 'mcp__modern__content_kinds', { kind: 'resource_link' }, 'completed', '[resource file:///fixture/link.txt]'],
    ['embedded text', 'mcp__modern__content_kinds', { kind: 'embedded_text' }, 'completed', 'embedded text'],
    [
      'embedded blob',
      'mcp__modern__content_kinds',
      { kind: 'embedded_blob' },
      'completed',
      `[resource file:///fixture/blob.bin, ${Buffer.byteLength(MODERN_FIXTURE_BLOB_BYTES)} bytes]`,
    ],
    ['empty', 'mcp__modern__content_kinds', { kind: 'empty' }, 'completed', '(no output)'],
    ['mixed blocks', 'mcp__modern__content_kinds', { kind: 'mixed' }, 'completed', 'first\n[image image/png, 17 bytes]\nsecond'],
    ['isError with several texts', 'mcp__modern__content_kinds', { kind: 'error' }, 'failed', 'bad\nworse'],
    ['text with structuredContent', 'mcp__modern__content_kinds', { kind: 'text_and_structured' }, 'completed', 'summary'],
    ['canonical structuredContent', 'mcp__modern__content_kinds', { kind: 'unsorted_structured' }, 'completed', '{"a":{"c":3,"d":2},"z":1}'],
    [
      'image placeholder followed by structuredContent',
      'mcp__modern__content_kinds',
      { kind: 'image_and_structured' },
      'completed',
      `[image image/png, ${Buffer.byteLength(MODERN_FIXTURE_IMAGE_BYTES)} bytes]\n{"a":2,"b":1}`,
    ],
  ])('maps %s', async (_label, name, args, status, output) => {
    const { set } = await modernSet();
    const result = await makeExecutor().resultOf(set, name, args);
    expect(result).toEqual({ status, output, content: [{ type: 'content', content: { type: 'text', text: output } }] });
  });

  it('never retries a read-only MCP tool that reports isError', async () => {
    const { set, recordFile } = await modernSet();
    const result = await makeExecutor().resultOf(set, 'mcp__modern__content_kinds', { kind: 'error' });
    expect(result.status).toBe('failed');
    expect(callRecords(recordFile, 'content_kinds')).toHaveLength(1);
  });

  it('refuses catastrophic_output promptly because its nested-quantifier pattern runs in the linear engine', async () => {
    const { set } = await modernSet();
    const startedAt = performance.now();
    const result = await makeExecutor().resultOf(set, 'mcp__modern__catastrophic_output', {});
    expect(performance.now() - startedAt).toBeLessThan(2000);
    expect(result.status).toBe('failed');
    expect(result.output).toContain("Structured content does not match the tool's output schema");
  });
});

describe('MCP trace context', () => {
  it('passes traceparent and tracestate from BatchInput.traceparentFor into _meta', async () => {
    const { set, recordFile } = await modernSet();
    const seen: string[] = [];
    await makeExecutor().resultOf(set, 'mcp__modern__echo', { text: 'x' }, {
      traceparentFor: (callId: string) => {
        seen.push(callId);
        return { traceparent: TRACEPARENT, tracestate: 'vendor=fixture' };
      },
    });
    expect(seen).toContain('call-1');
    const [call] = callRecords(recordFile, 'echo');
    expect(call?.type === 'call' ? call.meta : undefined).toEqual({ traceparent: TRACEPARENT, tracestate: 'vendor=fixture', progressToken: expect.anything() });
  });

  it('omits tracestate when only traceparent is given', async () => {
    const { set, recordFile } = await modernSet();
    await makeExecutor().resultOf(set, 'mcp__modern__echo', { text: 'x' }, { traceparentFor: () => ({ traceparent: TRACEPARENT }) });
    const [call] = callRecords(recordFile, 'echo');
    expect(call?.type === 'call' ? call.meta : undefined).toEqual({ traceparent: TRACEPARENT, progressToken: expect.anything() });
  });

  it('sends no trace context when traceparentFor is absent', async () => {
    const { set, recordFile } = await modernSet();
    await makeExecutor().resultOf(set, 'mcp__modern__echo', { text: 'x' });
    const [call] = callRecords(recordFile, 'echo');
    const meta = call?.type === 'call' ? call.meta : undefined;
    expect(meta?.['traceparent']).toBeUndefined();
    expect(meta?.['tracestate']).toBeUndefined();
  });
});

describe('MCP timeouts and cancellation', () => {
  it('times out at the run deadline with the executor message and the server records the cancellation', async () => {
    const { set, recordFile } = await modernSet();
    const harness = makeExecutor();
    const result = await harness.resultOf(set, 'mcp__modern__slow', {}, { deadlineAt: harness.clock.now() + 500 });
    expect(result).toEqual({ status: 'failed', output: `mcp__modern__slow timed out after 500 ms. ${UNKNOWN_EFFECTS}` });
    expect(await waitForRecord(recordFile, (record) => record.type === 'cancelled')).toMatchObject({ type: 'cancelled', tool: 'slow' });
  });

  it('ends a stdio call that sends no progress at mcp.toolIdleTimeoutMs with the idle text, and the server records the cancellation', async () => {
    const { set, recordFile } = await modernSet({ toolIdleTimeoutMs: 300 });
    const result = await makeExecutor().resultOf(set, 'mcp__modern__slow', {});
    expect(result).toEqual({
      status: 'failed',
      output: 'MCP server "modern" sent no response or progress for 300 ms, so the call to slow was stopped. The server may have run it; check before repeating it. To wait longer, raise mcp.toolIdleTimeoutMs.',
    });
    expect(await waitForRecord(recordFile, (record) => record.type === 'cancelled')).toMatchObject({ type: 'cancelled', tool: 'slow' });
  });

  it('reports cancellation on abort and the server records the cancellation', async () => {
    const { set, recordFile } = await modernSet();
    const harness = makeExecutor();
    const controller = new AbortController();
    const pending = harness.resultOf(set, 'mcp__modern__slow', {}, { signal: controller.signal });
    await waitForRecord(recordFile, (record) => record.type === 'call' && record.tool === 'slow');
    controller.abort();
    expect(await pending).toEqual({ status: 'failed', output: `mcp__modern__slow was cancelled. ${UNKNOWN_EFFECTS}` });
    expect(await waitForRecord(recordFile, (record) => record.type === 'cancelled')).toMatchObject({ type: 'cancelled', tool: 'slow' });
  });
});

describe('MCP listing snapshots', () => {
  it('keeps the run-start tool list in a pinned snapshot after list_changed', async () => {
    const recordFile = makeRecordFile();
    const harness = makePool([entry('modern', modernConfig(recordFile))]);
    const pinned = await harness.snapshot();
    const executor = makeExecutor();
    expect((await executor.resultOf(pinned, 'mcp__modern__trigger_list_changed', {})).output).toBe('list changed');
    const fresh = await harness.snapshot();
    expect(pinned.get('mcp__modern__added_later')).toBeUndefined();
    expect(fresh.get('mcp__modern__added_later')?.name).toBe('mcp__modern__added_later');
    expect(fresh.digest).not.toBe(pinned.digest);
    const stale = await executor.resultOf(pinned, 'mcp__modern__added_later', {});
    expect(stale.status).toBe('failed');
    expect(stale.output.startsWith('Unknown tool "mcp__modern__added_later"')).toBe(true);
    expect((await executor.resultOf(fresh, 'mcp__modern__added_later', {})).output).toBe('added later');
    expect(readRecords(recordFile).filter((record) => record.type === 'list').length).toBeGreaterThan(3);
  });
});
