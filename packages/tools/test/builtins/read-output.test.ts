import { describe, expect, it } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { catN, makeBuiltins, range, resultOf } from './fixtures.ts';

const UNKNOWN_HANDLE = 'a'.repeat(64);

describe('ReadOutput', () => {
  it.runIf(process.platform === 'darwin')('reads back a truncated Bash output exactly', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const tools = await makeBuiltins({ maxInlineOutputChars: 2000, realSandbox: true });
    const bashResult = resultOf(await tools.run('Bash', { command: 'seq 1 3000' }, {}, 'allow_once'));
    expect(bashResult).toMatchObject({ status: 'completed', truncated: true });
    const handle = bashResult.handle as string;
    expect(handle).toMatch(/^[0-9a-f]{64}$/);
    expect(tools.blobs.stored.get(handle)?.text.trimEnd()).toBe(range(1, 3000).join('\n'));
    const pages: string[] = [];
    let offset = 1;
    for (let guard = 0; guard < 200; guard += 1) {
      const page = resultOf(await tools.run('ReadOutput', { handle, offset, limit: 2000 }));
      expect(page).toMatchObject({ status: 'completed' });
      expect(page.handle).toBeUndefined();
      const note = /\n\[Showed lines \d+–\d+\. Continue with offset=(\d+)\.\]$/.exec(page.output);
      if (note === null) {
        pages.push(page.output);
        break;
      }
      pages.push(page.output.slice(0, note.index));
      offset = Number(note[1]);
    }
    expect(pages.join('\n').replace(/\n {2}3001\t$/, '')).toBe(catN(range(1, 3000).map(String)));
  });

  it('reads 2000 lines by default and notes where to continue', async () => {
    const tools = await makeBuiltins({ maxInlineOutputChars: 100_000 });
    const { handle } = tools.blobs.port.put(range(1, 2500).map((n) => `out ${n}`).join('\n'), { mediaType: 'text/plain; charset=utf-8' });
    const result = resultOf(await tools.run('ReadOutput', { handle }));
    expect(result.output).toBe(`${catN(range(1, 2000).map((n) => `out ${n}`))}\n[Showed lines 1–2000. Continue with offset=2001.]`);
  });

  it('adds no continuation note when the blob ends exactly at the line limit', async () => {
    const tools = await makeBuiltins({ maxInlineOutputChars: 100_000 });
    const { handle } = tools.blobs.port.put(range(1, 2000).map((n) => `out ${n}`).join('\n'), { mediaType: 'text/plain; charset=utf-8' });
    const result = resultOf(await tools.run('ReadOutput', { handle }));
    expect(result.output).toBe(catN(range(1, 2000).map((n) => `out ${n}`)));
  });

  it('pages itself within the default budget and continues exactly where it stopped', async () => {
    const tools = await makeBuiltins();
    const lines = range(1, 2200).map((n) => `${String(n).padStart(5, '0')} ${'y'.repeat(40)}`);
    const { handle } = tools.blobs.port.put(lines.join('\n'), { mediaType: 'text/plain; charset=utf-8' });
    const pages: string[] = [];
    let offset = 1;
    for (let guard = 0; guard < 20; guard += 1) {
      const result = resultOf(await tools.run('ReadOutput', { handle, offset, limit: 2200 - offset + 1 }));
      expect(result.handle).toBeUndefined();
      expect(result.output.length).toBeLessThanOrEqual(30_000);
      const note = /\n\[Showed lines (\d+)–(\d+)\. Continue with offset=(\d+)\.\]$/.exec(result.output);
      if (note === null) {
        pages.push(result.output);
        break;
      }
      expect(Number(note[1])).toBe(offset);
      pages.push(result.output.slice(0, note.index));
      offset = Number(note[3]);
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join('\n')).toBe(catN(lines));
  });

  it('honors offset and limit', async () => {
    const tools = await makeBuiltins();
    const { handle } = tools.blobs.port.put('a\nb\nc\nd\ne', { mediaType: 'text/plain; charset=utf-8' });
    const result = resultOf(await tools.run('ReadOutput', { handle, offset: 2, limit: 3 }));
    expect(result).toMatchObject({ status: 'completed', output: `${catN(['b', 'c', 'd'], 2)}\n[Showed lines 2–4. Continue with offset=5.]` });
  });

  it('cuts long lines like Read', async () => {
    const tools = await makeBuiltins();
    const { handle } = tools.blobs.port.put(`${'z'.repeat(2100)}\nshort`, { mediaType: 'text/plain; charset=utf-8' });
    const result = resultOf(await tools.run('ReadOutput', { handle }));
    expect(result.output).toBe(`     1\t${'z'.repeat(2000)}… [line truncated]\n     2\tshort`);
  });

  it('reports an offset past the end', async () => {
    const tools = await makeBuiltins();
    const { handle } = tools.blobs.port.put('a\nb\nc', { mediaType: 'text/plain; charset=utf-8' });
    const result = resultOf(await tools.run('ReadOutput', { handle, offset: 5 }));
    expect(result.output).toMatch(/^offset 5 is past the end of the .+ \(3 lines\)$/);
  });

  it('fails for an unknown handle', async () => {
    const tools = await makeBuiltins();
    const result = resultOf(await tools.run('ReadOutput', { handle: UNKNOWN_HANDLE }));
    expect(result).toEqual({ status: 'failed', output: 'Unknown output handle' });
  });

  it.each(['ABC', 'g'.repeat(64), 'A'.repeat(64), 'a'.repeat(63)])('rejects a malformed handle %s', async (handle) => {
    const tools = await makeBuiltins();
    const result = resultOf(await tools.run('ReadOutput', { handle }));
    expect(result.status).toBe('failed');
    expect(result.output).not.toBe('Unknown output handle');
  });

  it('needs no permission in any mode', async () => {
    const tools = await makeBuiltins();
    const { handle } = tools.blobs.port.put('x', { mediaType: 'text/plain; charset=utf-8' });
    const result = resultOf(await tools.run('ReadOutput', { handle }, { mode: 'plan' }));
    expect(result).toMatchObject({ status: 'completed', output: '     1\tx' });
  });
});
