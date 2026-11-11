import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_SEQUENCE_BYTES, PASTE_ABANDON_BYTES, PASTE_MAX_BYTES } from '../../src/tui/terminal/constants.ts';
import type { KeyName, TerminalEvent } from '../../src/tui/terminal/events.ts';
import { createInputParser } from '../../src/tui/terminal/parser.ts';

type Fixture = { name: string; bytes: Buffer; events: unknown[]; splitAfterEscape: unknown[] | undefined };

const FIXTURE_DIRECTORY = path.join(import.meta.dirname, 'fixtures', 'terminal-protocols');

const fixtureOf = (file: string): Fixture => {
  const parsed: unknown = JSON.parse(readFileSync(path.join(FIXTURE_DIRECTORY, file), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${file} is not a fixture object`);
  const { name, hex, events, splitAfterEscape } = Object.fromEntries(Object.entries(parsed));
  if (typeof name !== 'string' || typeof hex !== 'string' || !Array.isArray(events)) throw new Error(`${file} lacks name, hex or events`);
  if (splitAfterEscape !== undefined && !Array.isArray(splitAfterEscape)) throw new Error(`${file} has a splitAfterEscape that is not a list`);
  return { name, bytes: Buffer.from(hex, 'hex'), events, splitAfterEscape };
};

const fixtures: Fixture[] = readdirSync(FIXTURE_DIRECTORY).sort().map(fixtureOf);

const ESC = '\u001b';
const plain = { ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false };
const unmodified = { ctrl: false, alt: false, shift: false };
const named = (name: KeyName, mods: Partial<typeof plain> = {}): TerminalEvent => ({ type: 'key', name, ...plain, ...mods });
const text = (value: string, mods: Partial<typeof plain> = {}): TerminalEvent => ({ type: 'key', text: value, ...plain, ...mods });
const RELEASE: TerminalEvent = { type: 'release' };
const textOf = (value: string): TerminalEvent[] => [...value].map((character) => text(character));
const bytesOf = (value: string): Buffer => Buffer.from(value, 'utf8');

const parse = (...chunks: Uint8Array[]): TerminalEvent[] => {
  const parser = createInputParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
};

const parseText = (...chunks: string[]): TerminalEvent[] => parse(...chunks.map(bytesOf));

const followsEscape = (bytes: Uint8Array, position: number): boolean => bytes[position - 1] === 0x1b;

describe('the recorded sequences of each protocol', () => {
  it('reads the nineteen fixtures of the design', () => {
    expect(fixtures).toHaveLength(19);
  });

  it.each(fixtures)('$name gives its events in one read', (fixture) => {
    expect(parse(fixture.bytes)).toEqual(fixture.events);
  });

  it.each(fixtures)('$name gives the same events split at every byte position', (fixture) => {
    for (let position = 1; position < fixture.bytes.length; position += 1) {
      const expected = fixture.splitAfterEscape !== undefined && followsEscape(fixture.bytes, position) ? fixture.splitAfterEscape : fixture.events;
      expect(parse(fixture.bytes.subarray(0, position), fixture.bytes.subarray(position)), `split at ${position}`).toEqual(expected);
    }
  });

  it.each(fixtures)('$name gives the same events one byte per read', (fixture) => {
    const singles = [...fixture.bytes].map((byte) => Uint8Array.of(byte));
    expect(parse(...singles)).toEqual(fixture.splitAfterEscape ?? fixture.events);
  });

  it('gives the events of every fixture in order when all arrive merged in one read', () => {
    expect(parse(Buffer.concat(fixtures.map((fixture) => fixture.bytes)))).toEqual(fixtures.flatMap((fixture) => fixture.events));
  });
});

describe('keys', () => {
  const cases: [string, string, TerminalEvent[]][] = [
    ['a letter', 'a', [text('a')]],
    ['several letters in one read', 'abc', textOf('abc')],
    ['tab', '\t', [named('tab')]],
    ['shift+tab', `${ESC}[Z`, [named('tab', { shift: true })]],
    ['backspace', '\u007f', [named('backspace')]],
    ['backspace as 0x08', '\b', [named('backspace')]],
    ['ctrl+c', '\u0003', [text('c', { ctrl: true })]],
    ['ctrl+d', '\u0004', [text('d', { ctrl: true })]],
    ['ctrl+z', '\u001a', [text('z', { ctrl: true })]],
    ['ctrl+space', '\u0000', [text(' ', { ctrl: true })]],
    ['alt+a', `${ESC}a`, [text('a', { alt: true })]],
    ['alt+backspace', `${ESC}\u007f`, [named('backspace', { alt: true })]],
    ['down', `${ESC}[B`, [named('down')]],
    ['right', `${ESC}[C`, [named('right')]],
    ['left', `${ESC}[D`, [named('left')]],
    ['home', `${ESC}[H`, [named('home')]],
    ['end', `${ESC}[F`, [named('end')]],
    ['ctrl+right', `${ESC}[1;5C`, [named('right', { ctrl: true })]],
    ['shift+alt+up', `${ESC}[1;4A`, [named('up', { shift: true, alt: true })]],
    ['alt+up as a doubled escape', `${ESC}${ESC}[A`, [named('up', { alt: true })]],
    ['an arrow release under the kitty flags', `${ESC}[1;1:3A`, [RELEASE]],
    ['a delete release under the kitty flags', `${ESC}[3;1:3~`, [RELEASE]],
    ['a letter release under the kitty flags', `${ESC}[97;1:3u`, [RELEASE]],
    ['insert', `${ESC}[2~`, [named('insert')]],
    ['delete', `${ESC}[3~`, [named('delete')]],
    ['shift+delete', `${ESC}[3;2~`, [named('delete', { shift: true })]],
    ['page up', `${ESC}[5~`, [named('pageup')]],
    ['page down', `${ESC}[6~`, [named('pagedown')]],
    ['home as 1~', `${ESC}[1~`, [named('home')]],
    ['end as 4~', `${ESC}[4~`, [named('end')]],
    ['f1 as SS3', `${ESC}OP`, [named('f1')]],
    ['f4 as SS3', `${ESC}OS`, [named('f4')]],
    ['f5', `${ESC}[15~`, [named('f5')]],
    ['f12', `${ESC}[24~`, [named('f12')]],
    ['up as SS3', `${ESC}OA`, [named('up')]],
    ['kitty ctrl+c', `${ESC}[99;5u`, [text('c', { ctrl: true })]],
    ['kitty shift+a with its shifted alternate', `${ESC}[97:65;2u`, [text('A', { shift: true })]],
    ['kitty repeat is a press', `${ESC}[97;1:2u`, [text('a')]],
    ['kitty tab', `${ESC}[9u`, [named('tab')]],
    ['kitty backspace', `${ESC}[127u`, [named('backspace')]],
    ['kitty modifier-only key', `${ESC}[57441;2u`, []],
    ['kitty text of two code points', `${ESC}[97;;12354:12356u`, [text('あい')]],
    ['kitty super+z, the Cmd+Z of a terminal that reports it', `${ESC}[122;9u`, [text('z', { super: true })]],
    ['kitty hyper+a', `${ESC}[97;17u`, [text('a', { hyper: true })]],
    ['kitty meta+a', `${ESC}[97;33u`, [text('a', { meta: true })]],
    ['kitty with every modifier', `${ESC}[97;64u`, [text('a', { shift: true, alt: true, ctrl: true, super: true, hyper: true, meta: true })]],
    ['kitty super+shift+z with its shifted alternate', `${ESC}[122:90;10u`, [text('Z', { shift: true, super: true })]],
    ['kitty ctrl+enter', `${ESC}[13;5u`, [named('enter', { ctrl: true })]],
    ['kitty shift+enter', `${ESC}[13;2u`, [named('enter', { shift: true })]],
    ['kitty super+enter', `${ESC}[13;9u`, [named('enter', { super: true })]],
    ['super+up in the legacy form', `${ESC}[1;9A`, [named('up', { super: true })]],
    ['super+delete in the legacy form', `${ESC}[3;9~`, [named('delete', { super: true })]],
    ['xterm modifyOtherKeys super+z', `${ESC}[27;9;122~`, [text('z', { super: true })]],
    ['xterm modifyOtherKeys ctrl+i', `${ESC}[27;5;105~`, [text('i', { ctrl: true })]],
    ['focus in', `${ESC}[I`, [{ type: 'focus', direction: 'in' }]],
    ['focus out', `${ESC}[O`, [{ type: 'focus', direction: 'out' }]],
    ['cursor position reply', `${ESC}[12;40R`, [{ type: 'report', kind: 'cursor-position', row: 12, col: 40 }]],
    ['kitty flags reply', `${ESC}[?7u`, [{ type: 'report', kind: 'kitty-keys', flags: 7 }]],
    ['DECRQM reply not recognised', `${ESC}[?1049;0$y`, [{ type: 'report', kind: 'mode', mode: 1049, value: 0 }]],
    ['OSC 11 reply ended by BEL', `${ESC}]11;rgb:ffff/ffff/ffff\u0007`, [{ type: 'report', kind: 'background-color', color: 'rgb:ffff/ffff/ffff' }]],
    ['mouse middle press', `${ESC}[<1;2;3M`, [{ type: 'mouse', kind: 'press', button: 'middle', col: 2, row: 3, ...unmodified }]],
    ['mouse right press', `${ESC}[<2;2;3M`, [{ type: 'mouse', kind: 'press', button: 'right', col: 2, row: 3, ...unmodified }]],
    ['mouse drag', `${ESC}[<32;3;4M`, [{ type: 'mouse', kind: 'move', button: 'left', col: 3, row: 4, ...unmodified }]],
    ['mouse move without a button', `${ESC}[<35;3;4M`, [{ type: 'mouse', kind: 'move', button: 'none', col: 3, row: 4, ...unmodified }]],
    ['mouse wheel down', `${ESC}[<65;1;1M`, [{ type: 'mouse', kind: 'wheel', button: 'wheel-down', col: 1, row: 1, ...unmodified }]],
    ['mouse press with ctrl and shift', `${ESC}[<20;1;1M`, [{ type: 'mouse', kind: 'press', button: 'left', col: 1, row: 1, ctrl: true, alt: false, shift: true }]],
    ['mouse press with alt', `${ESC}[<8;1;1M`, [{ type: 'mouse', kind: 'press', button: 'left', col: 1, row: 1, ctrl: false, alt: true, shift: false }]],
    ['a paste end marker without a paste', `${ESC}[201~`, []],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(parseText(input)).toEqual(expected);
  });

  it.each(cases)('%s, one byte per read', (_name, input, expected) => {
    const bytes = bytesOf(input);
    const escapedPrefix = bytes[0] === 0x1b && bytes[1] !== 0x5b && bytes[1] !== 0x4f && bytes[1] !== 0x5d;
    if (escapedPrefix) return;
    expect(parse(...[...bytes].map((byte) => Uint8Array.of(byte)))).toEqual(expected);
  });
});

describe('UTF-8 across reads', () => {
  it('reads Alt with a character whose bytes are split after the ESC of the same read', () => {
    const bytes = bytesOf(`${ESC}é`);
    expect(parse(bytes.subarray(0, 2), bytes.subarray(2))).toEqual([text('é', { alt: true })]);
  });

  it.each(['é', 'あ', '😀', 'aéあ😀b'])('completes %s split at every byte position', (value) => {
    const bytes = bytesOf(value);
    for (let position = 1; position < bytes.length; position += 1) {
      expect(parse(bytes.subarray(0, position), bytes.subarray(position))).toEqual(textOf(value));
    }
  });
});

describe('a lone ESC byte', () => {
  it('is held at the end of a read and emitted when the settle ends with no byte', () => {
    const parser = createInputParser();
    expect(parser.push(bytesOf(ESC))).toEqual([]);
    expect(parser.holdsOpen()).toBe(true);
    expect(parser.settle()).toEqual([named('escape')]);
    expect(parser.holdsOpen()).toBe(false);
    expect(parser.settle()).toEqual([]);
  });

  it('is no longer the start of a sequence once the settle ended', () => {
    const parser = createInputParser();
    parser.push(bytesOf(ESC));
    expect(parser.settle()).toEqual([named('escape')]);
    expect(parser.push(bytesOf('[A'))).toEqual(textOf('[A'));
  });

  it('is emitted before a next read within the settle that is not a continuation', () => {
    const parser = createInputParser();
    expect(parser.push(bytesOf(ESC))).toEqual([]);
    expect(parser.push(bytesOf('a'))).toEqual([named('escape'), text('a')]);
    expect(parser.holdsOpen()).toBe(false);
  });

  it('stays held across an empty read', () => {
    const parser = createInputParser();
    expect(parser.push(bytesOf(ESC))).toEqual([]);
    expect(parser.push(new Uint8Array(0))).toEqual([]);
    expect(parser.holdsOpen()).toBe(true);
    expect(parser.push(bytesOf(ESC))).toEqual([named('escape')]);
    expect(parser.push(bytesOf('\r'))).toEqual([named('escape'), named('enter')]);
  });

  it.each([
    ['a CSI sequence', '[A', [named('up')]],
    ['an SS3 sequence', 'OP', [named('f1')]],
    ['an OSC reply', ']11;rgb:0000/0000/0000\u0007', [{ type: 'report', kind: 'background-color', color: 'rgb:0000/0000/0000' }]],
  ] as [string, string, TerminalEvent[]][])('is joined with a next read within the settle that begins %s', (_name, continuation, expected) => {
    expect(parseText(ESC, continuation)).toEqual(expected);
  });

  it('is an arrow with [A of the same read', () => {
    expect(parseText(`${ESC}[A`)).toEqual([named('up')]);
  });

  it('is Alt with the next character of the same read', () => {
    expect(parseText(`${ESC}x`)).toEqual([text('x', { alt: true })]);
  });

  it.each([
    ['[', text('[', { alt: true })],
    ['O', text('O', { alt: true })],
    [']', text(']', { alt: true })],
  ] as [string, TerminalEvent][])('with %s and nothing after it is the Alt key of a legacy terminal once the settle ends, and the next key is read as a key', (introducer, expected) => {
    const parser = createInputParser();
    expect(parser.push(bytesOf(`${ESC}${introducer}`))).toEqual([]);
    expect(parser.holdsOpen()).toBe(true);
    expect(parser.settle()).toEqual([expected]);
    expect(parser.holdsOpen()).toBe(false);
    expect(parser.push(bytesOf('A'))).toEqual([text('A')]);
  });

  it('with [ whose settle ended is still the start of the paste marker that the next read completes: the paste is one paste and none of its text is a key', () => {
    const parser = createInputParser();
    parser.push(bytesOf(`${ESC}[`));
    expect(parser.settle()).toEqual([text('[', { alt: true })]);
    expect(parser.push(bytesOf(`200~rm -rf x\r1\r${ESC}[201~z`))).toEqual([{ type: 'paste', text: 'rm -rf x\r1\r', overflow: false }, text('z')]);
  });

  it('with [ whose settle ended is still the start of a sequence with parameters that the next read completes', () => {
    const parser = createInputParser();
    parser.push(bytesOf(`${ESC}[`));
    parser.settle();
    expect(parser.push(bytesOf('1;5Cx'))).toEqual([named('right', { ctrl: true }), text('x')]);
  });

  it('with [ whose settle ended is the Alt key of a legacy terminal, and what is typed later is typed keys', () => {
    for (const typed of ['A', 'a', '2', '~', '2x']) {
      const parser = createInputParser();
      parser.push(bytesOf(`${ESC}[`));
      expect(parser.settle()).toEqual([text('[', { alt: true })]);
      expect(parser.push(bytesOf(typed)), typed).toEqual(textOf(typed));
      expect(parser.push(bytesOf('b'))).toEqual([text('b')]);
    }
  });

  it('reads only the very next read as the continuation of an introducer whose settle ended', () => {
    const parser = createInputParser();
    parser.push(bytesOf(`${ESC}[`));
    parser.settle();
    parser.push(bytesOf('a'));
    expect(parser.push(bytesOf('200~'))).toEqual(textOf('200~'));
  });

  it('with [ is still the start of a sequence when its next byte arrives within the settle', () => {
    const parser = createInputParser();
    parser.push(bytesOf(`${ESC}[`));
    expect(parser.push(bytesOf('A'))).toEqual([named('up')]);
    expect(parser.holdsOpen()).toBe(false);
  });

  it('is not held by the settle while a longer sequence is open, a paste is open, or a character is incomplete', () => {
    const open = createInputParser();
    open.push(bytesOf(`${ESC}[1`));
    expect(open.holdsOpen()).toBe(false);
    expect(open.settle()).toEqual([]);
    expect(open.push(bytesOf(';5C'))).toEqual([named('right', { ctrl: true })]);

    const pasting = createInputParser();
    pasting.push(bytesOf(`${ESC}[200~a${ESC}`));
    expect(pasting.holdsOpen()).toBe(false);
    expect(pasting.settle()).toEqual([]);
    expect(pasting.push(bytesOf(`b${ESC}[201~`))).toEqual([{ type: 'paste', text: `a${ESC}b`, overflow: false }]);

    const partial = createInputParser();
    const bytes = bytesOf(`${ESC}é`);
    partial.push(bytes.subarray(0, 2));
    expect(partial.holdsOpen()).toBe(false);
    expect(partial.settle()).toEqual([]);
    expect(partial.push(bytes.subarray(2))).toEqual([text('é', { alt: true })]);
  });
});

describe('sequences that are not recognised', () => {
  it.each([
    ['a device status report', `${ESC}[5n`],
    ['F13', `${ESC}[25~`],
    ['F16', `${ESC}[29~`],
    ['the keypad 5', `${ESC}[E`],
    ['the keypad 5 with ctrl', `${ESC}[1;5E`],
    ['an SS3 key that is not known', `${ESC}OE`],
    ['an OSC 52 clipboard write', `${ESC}]52;c;AA==\u0007`],
    ['an OSC ended by ST', `${ESC}]0;title${ESC}\\`],
    ['a kitty key of a control code point', `${ESC}[1;5u`],
    ['a mouse report with a field missing', `${ESC}[<0;1M`],
    ['a sequence with an intermediate byte', `${ESC}[1 q`],
  ])('drops %s whole and types nothing', (_name, sequence) => {
    expect(parseText(sequence)).toEqual([]);
    expect(parseText(`a${sequence}b`)).toEqual(textOf('ab'));
    expect(parse(...[...bytesOf(`a${sequence}b`)].map((byte) => Uint8Array.of(byte)))).toEqual(textOf('ab'));
  });

  it('drops a C1 control character, alone or after an ESC, and a kitty key whose text holds a control character', () => {
    expect(parseText('a\u009b1mb\u0085c')).toEqual(textOf('a1mbc'));
    expect(parseText(`${ESC}\u009b`)).toEqual([]);
    expect(parseText(`${ESC}[97;;7u`)).toEqual([]);
    expect(parseText(`${ESC}[97;;97:155u`)).toEqual([]);
    expect(parseText(`${ESC}[133u`)).toEqual([]);
    expect(parseText(`${ESC}[97:133;2u`)).toEqual([text('a', { shift: true })]);
  });

  it('drops a sequence at a byte that cannot continue it and parses that byte on its own', () => {
    expect(parseText(`${ESC}[1\r`)).toEqual([named('enter')]);
    expect(parseText(`${ESC}]0;x${ESC}[A`)).toEqual([named('up')]);
  });

  it(`drops a sequence that passes ${MAX_SEQUENCE_BYTES} bytes without a final byte`, () => {
    const overlong = `${ESC}[${'1'.repeat(MAX_SEQUENCE_BYTES - 2)}`;
    expect(parseText(overlong)).toEqual([]);
    expect(parse(...[...bytesOf(overlong)].map((byte) => Uint8Array.of(byte)))).toEqual([]);
  });

  it('reads on as soon as the bound is reached', () => {
    const parser = createInputParser();
    expect(parser.push(bytesOf(`${ESC}[${'1'.repeat(MAX_SEQUENCE_BYTES - 3)}`))).toEqual([]);
    expect(parser.push(bytesOf('1'))).toEqual([]);
    expect(parser.push(bytesOf(`${ESC}[A`))).toEqual([named('up')]);
  });

  it('never gives a key event that holds a control character', () => {
    const alphabet = [0x1b, 0x1b, 0x5b, 0x4f, 0x5d, 0x3c, 0x3f, 0x3b, 0x31, 0x32, 0x39, 0x75, 0x7e, 0x4d, 0x41, 0x45, 0x6e, 0x07, 0x5c, 0x61, 0x20, 0x24, 0x37, 0x33, 0xc2, 0x9b, 0xc2, 0x85];
    let state = 11;
    for (let round = 0; round < 500; round += 1) {
      const bytes = Uint8Array.from({ length: 1 + (round % 40) }, () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return alphabet[Math.floor(state / 65536) % alphabet.length] ?? 0;
      });
      for (const event of parse(bytes)) if (event.type === 'key' && 'text' in event) expect(event.text, `round ${round}`).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    }
  });

  it('keeps a sequence of exactly the bound', () => {
    const longest = `${ESC}[<${'0'.repeat(MAX_SEQUENCE_BYTES - 8)};1;1M`;
    expect(Buffer.byteLength(longest)).toBe(MAX_SEQUENCE_BYTES);
    expect(parseText(longest)).toEqual([{ type: 'mouse', kind: 'press', button: 'left', col: 1, row: 1, ...unmodified }]);
  });
});

describe('bracketed paste', () => {
  const START = `${ESC}[200~`;
  const END = `${ESC}[201~`;

  it('delivers the text between the markers, newlines and control bytes untouched', () => {
    expect(parseText(`${START}one\r\ntwo\u0003${END}x`)).toEqual([{ type: 'paste', text: 'one\r\ntwo\u0003', overflow: false }, text('x')]);
  });

  it('keeps a partial end marker that turns out to be content', () => {
    expect(parseText(`${START}a${ESC}[20`, `0~b${END}`)).toEqual([{ type: 'paste', text: `a${ESC}[200~b`, overflow: false }]);
  });

  it('delivers a paste of exactly 1 MiB', () => {
    const body = 'x'.repeat(PASTE_MAX_BYTES);
    expect(parseText(`${START}${body}${END}`)).toEqual([{ type: 'paste', text: body, overflow: false }]);
  });

  it('counts the limit in bytes, not characters', () => {
    const body = 'あ'.repeat(PASTE_MAX_BYTES / 3 + 1);
    expect(parseText(`${START}${body}${END}`)).toEqual([{ type: 'paste', text: '', overflow: true }]);
  });

  it('discards a paste larger than 1 MiB to its end marker and reports it', () => {
    const parser = createInputParser();
    const chunk = bytesOf('x'.repeat(64 * 1024));
    const events: TerminalEvent[] = [...parser.push(bytesOf(START))];
    for (let sent = 0; sent <= PASTE_MAX_BYTES; sent += chunk.length) events.push(...parser.push(chunk));
    expect(events).toEqual([]);
    expect(parser.push(bytesOf(`${END}a`))).toEqual([{ type: 'paste', text: '', overflow: true }, text('a')]);
  });

  const OVERFLOWED: TerminalEvent = { type: 'paste', text: '', overflow: true };

  it('reports a paste once when 8 MiB arrived with no end marker, and turns nothing of what follows into a key', () => {
    const parser = createInputParser();
    const chunk = bytesOf(`${'x'.repeat(64 * 1024 - 1)}\r`);
    const events: TerminalEvent[] = [...parser.push(bytesOf(START))];
    for (let sent = 0; sent < PASTE_ABANDON_BYTES; sent += chunk.length) events.push(...parser.push(chunk));
    expect(events).toEqual([OVERFLOWED]);
    expect(parser.push(bytesOf(`\rrm -rf x\r${ESC}[A\u0003`))).toEqual([]);
    expect(parser.push(chunk)).toEqual([]);
    expect(parser.holdsOpen()).toBe(true);
  });

  it('ends the dropping of an abandoned paste when the settle ends with no byte, so a terminal that never sends the end marker gets its keys back', () => {
    const parser = createInputParser();
    const events: TerminalEvent[] = [...parser.push(bytesOf(`${START}${'x'.repeat(PASTE_ABANDON_BYTES)}`))];
    expect(events).toEqual([OVERFLOWED]);
    expect(parser.push(bytesOf('still the paste\r'))).toEqual([]);
    expect(parser.holdsOpen()).toBe(true);
    expect(parser.settle()).toEqual([]);
    expect(parser.holdsOpen()).toBe(false);
    expect(parser.push(bytesOf(`a${ESC}[A`))).toEqual([text('a'), named('up')]);
  });

  it('swallows the end marker of an abandoned paste that the settle cut after its first bytes', () => {
    for (const cut of [1, 2, 3, 5]) {
      const parser = createInputParser();
      parser.push(bytesOf(`${START}${'x'.repeat(PASTE_ABANDON_BYTES)}${END.slice(0, cut)}`));
      expect(parser.settle(), `cut ${cut}`).toEqual([]);
      expect(parser.push(bytesOf(`${END.slice(cut)}a`)), `cut ${cut}`).toEqual([text('a')]);
    }
  });

  it('keeps a paste under the limit open however long the input is idle', () => {
    const parser = createInputParser();
    parser.push(bytesOf(`${START}slow `));
    expect(parser.holdsOpen()).toBe(false);
    expect(parser.settle()).toEqual([]);
    expect(parser.push(bytesOf(`paste${END}`))).toEqual([{ type: 'paste', text: 'slow paste', overflow: false }]);
  });

  it('reads keys again after the end marker of an abandoned paste, and reports that paste only once', () => {
    const parser = createInputParser();
    const chunk = bytesOf('x'.repeat(64 * 1024));
    const events: TerminalEvent[] = [...parser.push(bytesOf(START))];
    for (let sent = 0; sent < PASTE_ABANDON_BYTES + chunk.length; sent += chunk.length) events.push(...parser.push(chunk));
    events.push(...parser.push(bytesOf(`left over\r${END}\r${ESC}[A`)));
    expect(events).toEqual([OVERFLOWED, named('enter'), named('up')]);
  });

  it('finds the end marker of an abandoned paste split across reads', () => {
    const parser = createInputParser();
    parser.push(bytesOf(`${START}${'x'.repeat(PASTE_ABANDON_BYTES)}`));
    expect(parser.push(bytesOf(`tail\r${ESC}[20`))).toEqual([]);
    expect(parser.push(bytesOf('1'))).toEqual([]);
    expect(parser.push(bytesOf('~a'))).toEqual([text('a')]);
  });

  it('gives the same events for a paste over 8 MiB whatever the chunking', () => {
    const whole = bytesOf(`${START}${'x'.repeat(PASTE_ABANDON_BYTES)}abc\r${END}z`);
    const expected = [OVERFLOWED, text('z')];
    expect(parse(whole)).toEqual(expected);
    const cut = START.length + PASTE_ABANDON_BYTES;
    for (const position of [cut - 1, cut, cut + 1, cut + 4, whole.length - 3]) expect(parse(whole.subarray(0, position), whole.subarray(position)), `split at ${position}`).toEqual(expected);
  });

  it('keeps nothing of a paste it abandoned', () => {
    const parser = createInputParser();
    parser.push(bytesOf(`${START}${'x'.repeat(PASTE_ABANDON_BYTES)}`));
    expect(parser.push(bytesOf(`${END}${START}small${END}`))).toEqual([{ type: 'paste', text: 'small', overflow: false }]);
  });
});

describe('any byte string (P4)', () => {
  const alphabet = [0x1b, 0x1b, 0x1b, 0x5b, 0x5b, 0x4f, 0x5d, 0x3c, 0x3f, 0x3b, 0x3a, 0x30, 0x31, 0x32, 0x37, 0x39, 0x75, 0x7e, 0x4d, 0x6d, 0x41, 0x52, 0x63, 0x24, 0x79, 0x0d, 0x61, 0x07, 0x5c, 0xc3, 0xa9, 0xe3, 0x81, 0x82, 0xff, 0x00, 0x7f, 0x49];

  const generated = (seed: number, length: number): Uint8Array => {
    let state = seed;
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      bytes[index] = alphabet[Math.floor(state / 65536) % alphabet.length] ?? 0;
    }
    return bytes;
  };

  it('gives the same events for every split that does not follow an ESC byte, and never throws', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const bytes = generated(seed, 1 + (seed % 48));
      const whole = parse(bytes);
      for (let position = 1; position < bytes.length; position += 1) {
        if (followsEscape(bytes, position)) {
          parse(bytes.subarray(0, position), bytes.subarray(position));
          continue;
        }
        expect(parse(bytes.subarray(0, position), bytes.subarray(position)), `seed ${seed} split at ${position}`).toEqual(whole);
      }
    }
  });

  it('gives the same events for the pasted form of every generated string', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const bytes = Buffer.concat([bytesOf(`${ESC}[200~`), generated(seed, 1 + (seed % 48)), bytesOf(`${ESC}[201~`)]);
      const whole = parse(bytes);
      for (let position = 1; position < bytes.length; position += 1) {
        if (followsEscape(bytes, position)) continue;
        expect(parse(bytes.subarray(0, position), bytes.subarray(position)), `seed ${seed} split at ${position}`).toEqual(whole);
      }
    }
  });
});
