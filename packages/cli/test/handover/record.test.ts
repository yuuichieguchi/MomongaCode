import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDOVER_FORMAT, HANDOVER_RECORD_MAX_BYTES, encodeRecord, parseRecord, recordFileOf, recordNameOf } from '../../src/handover/record.ts';
import type { AcpRecord, StreamRecord, TuiRecord } from '../../src/handover/record.ts';

const COMMON = { format: HANDOVER_FORMAT, fromVersion: '1.2.3', toVersion: '1.2.4', session: 'session-1', lastSeq: { 'run-1': 9, 'run-2': 4 } } as const;

const SCREENLESS: TuiRecord = {
  ...COMMON,
  kind: 'tui',
  neg: 'kitty',
  hint: 'shift+enter',
  size: { columns: 120, rows: 40 },
  input: { text: 'half a prompt', cursor: 4, historyIndex: 2 },
  attachments: [{ file: '/work/shot.png', sha256: 'ab'.repeat(32) }],
  notes: [
    { anchor: null, kind: 'info', level: 'info', text: 'screen: fullscreen' },
    { anchor: { runId: 'run-1', seq: 9 }, kind: 'notice', level: 'error', text: 'model information unavailable: offline' },
    { anchor: { runId: 'run-1', seq: 9 }, kind: 'info', level: 'info', text: 'permission mode: plan' },
    { anchor: { runId: 'run-2', seq: 4 }, kind: 'notice', level: 'warning', text: 'startup notices unavailable: offline' },
  ],
};

const TUI: TuiRecord = { ...SCREENLESS, view: { key: { runId: 'run-1', seq: 5, index: 1 }, rowOffset: 3, following: false }, toggles: { thoughts: { t1: true, t2: false } } };

const SCROLLBACK: TuiRecord = { ...SCREENLESS, printed: 7 };

const ACP: AcpRecord = { ...COMMON, session: 'acp-41', kind: 'acp', initialize: { protocolVersion: 1, clientCapabilities: { session: { notices: {} } } }, sessions: ['session-1', 'session-2'], input: 'eyJqc29ucnBjIg==' };

const ATTACH: StreamRecord = { ...COMMON, kind: 'attach', runId: 'run-2', output: 'stream-json', verbose: true };

const HEADLESS: StreamRecord = { ...COMMON, kind: 'headless', runId: 'run-1', output: 'json', verbose: false };

const textOf = (record: TuiRecord | AcpRecord | StreamRecord): string => {
  const encoded = encodeRecord(record, { writer: 4242, reader: 4242, namespace: 'single' });
  if (encoded.kind !== 'fits') throw new Error('the record did not fit');
  return encoded.text;
};

describe('the handover record (16.4, red test 7)', () => {
  it.each([
    ['a fullscreen TUI', TUI],
    ['a scrollback TUI', SCROLLBACK],
    ['an ACP bridge', ACP],
    ['an attach', ATTACH],
    ['a headless run', HEADLESS],
    ['a headless run already quiescent', { ...HEADLESS, quiescent: { onQuiescent: 'report' as const } }],
  ])('round trips every field of %s, with the notes in order and their anchors', (_name, record) => {
    expect(parseRecord(textOf(record))).toEqual({ kind: 'record', record });
  });

  it('holds no screen mode and no terminal modes', () => {
    const fields = Object.keys(JSON.parse(textOf(TUI)) as Record<string, unknown>);
    expect(fields).not.toContain('screen');
    expect(fields).not.toContain('modes');
  });

  it('ignores fields it does not know', () => {
    const widened = JSON.stringify({ ...(JSON.parse(textOf(TUI)) as Record<string, unknown>), addedLater: { deep: [1, 2] } });
    expect(parseRecord(widened)).toEqual({ kind: 'record', record: TUI });
  });

  it('has printed only under scrollback and the view only under fullscreen', () => {
    const both = JSON.stringify({ ...(JSON.parse(textOf(TUI)) as Record<string, unknown>), printed: 3 });
    expect(parseRecord(both)).toEqual({ kind: 'refused', reason: 'the record holds both a viewport and a printed count' });
  });

  it('lives under run/handover, named by the session and the kind of client', () => {
    const file = recordFileOf({ run: '/home/u/.momonga/run' }, 'tui', 'session-1');
    expect(file).toBe(path.join('/home/u/.momonga/run', 'handover', 'session-1.tui.json'));
    expect(recordNameOf(file)).toEqual({ session: 'session-1', kind: 'tui' });
  });

  it('gives a TUI and an attach client of one session a record each', () => {
    const run = { run: '/home/u/.momonga/run' };
    const tui = recordFileOf(run, 'tui', 'session-1');
    const attach = recordFileOf(run, 'attach', 'session-1');
    expect(tui).not.toBe(attach);
    expect([recordNameOf(tui), recordNameOf(attach)]).toEqual([
      { session: 'session-1', kind: 'tui' },
      { session: 'session-1', kind: 'attach' },
    ]);
  });

  it('names no session for a file it did not name', () => {
    expect(recordNameOf('/home/u/.momonga/run/handover/session-1.json')).toBeUndefined();
    expect(recordNameOf('/home/u/.momonga/run/handover/session-1.shell.json')).toBeUndefined();
  });
});

describe('a record the new process refuses (red test 17)', () => {
  it.each([
    ['not JSON', '{', 'the record is not JSON'],
    ['an unknown format', JSON.stringify({ ...TUI, format: 'handover/9' }), 'the record format handover/9 is not known to this version'],
    ['no format', JSON.stringify({ session: 's' }), 'the record names no format'],
    ['an unknown kind', JSON.stringify({ ...TUI, kind: 'telepathy' }), 'the record kind telepathy is not known to this version'],
    ['a missing field', JSON.stringify({ ...TUI, input: undefined }), 'the record field input is missing or malformed'],
  ])('refuses %s and says why', (_name, text, reason) => {
    expect(parseRecord(text)).toEqual({ kind: 'refused', reason });
  });
});

describe('the size bound (16.4, O2, red test 18)', () => {
  it('is 1 MiB', () => {
    expect(HANDOVER_RECORD_MAX_BYTES).toBe(1024 * 1024);
  });

  it('refuses to encode a record larger than the bound and drops nothing', () => {
    const large: TuiRecord = { ...TUI, input: { text: 'x'.repeat(HANDOVER_RECORD_MAX_BYTES), cursor: 0, historyIndex: null } };
    const encoded = encodeRecord(large, { writer: 4242, reader: 4242, namespace: 'single' });
    expect(encoded.kind).toBe('too-large');
    expect(large.input.text).toHaveLength(HANDOVER_RECORD_MAX_BYTES);
  });

  it('counts bytes, not characters', () => {
    const wide: TuiRecord = { ...TUI, input: { text: 'あ'.repeat(HANDOVER_RECORD_MAX_BYTES / 3), cursor: 0, historyIndex: null } };
    expect(encodeRecord(wide, { writer: 4242, reader: 4242, namespace: 'single' }).kind).toBe('too-large');
  });

  it('refuses to read a record larger than the bound', () => {
    expect(parseRecord(' '.repeat(HANDOVER_RECORD_MAX_BYTES + 1))).toEqual({ kind: 'refused', reason: 'the record is larger than 1 MiB' });
  });
});
