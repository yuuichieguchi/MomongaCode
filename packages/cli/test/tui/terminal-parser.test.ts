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
const plain = { ctrl: false, alt: false, shift: false };
const named = (name: KeyName, mods: Partial<typeof plain> = {}): TerminalEvent => ({ type: 'key', name, ...plain, ...mods });
const text = (value: string, mods: Partial<typeof plain> = {}): TerminalEvent => ({ type: 'key', text: value, ...plain, ...mods });
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
    ['an arrow release under the kitty flags', `${ESC}[1;1:3A`, []],
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
    ['xterm modifyOtherKeys ctrl+i', `${ESC}[27;5;105~`, [text('i', { ctrl: true })]],
    ['focus in', `${ESC}[I`, [{ type: 'focus', direction: 'in' }]],
    ['focus out', `${ESC}[O`, [{ type: 'focus', direction: 'out' }]],
    ['cursor position reply', `${ESC}[12;40R`, [{ type: 'report', kind: 'cursor-position', row: 12, col: 40 }]],
    ['kitty flags reply', `${ESC}[?7u`, [{ type: 'report', kind: 'kitty-keys', flags: 7 }]],
    ['DECRQM reply not recognised', `${ESC}[?1049;0$y`, [{ type: 'report', kind: 'mode', mode: 1049, value: 0 }]],
    ['OSC 11 reply ended by BEL', `${ESC}]11;rgb:ffff/ffff/ffff\u0007`, [{ type: 'report', kind: 'background-color', color: 'rgb:ffff/ffff/ffff' }]],
    ['mouse middle press', `${ESC}[<1;2;3M`, [{ type: 'mouse', kind: 'press', button: 'middle', col: 2, row: 3, ...plain }]],
    ['mouse right press', `${ESC}[<2;2;3M`, [{ type: 'mouse', kind: 'press', button: 'right', col: 2, row: 3, ...plain }]],
    ['mouse drag', `${ESC}[<32;3;4M`, [{ type: 'mouse', kind: 'move', button: 'left', col: 3, row: 4, ...plain }]],
    ['mouse move without a button', `${ESC}[<35;3;4M`, [{ type: 'mouse', kind: 'move', button: 'none', col: 3, row: 4, ...plain }]],
    ['mouse wheel down', `${ESC}[<65;1;1M`, [{ type: 'mouse', kind: 'wheel', button: 'wheel-down', col: 1, row: 1, ...plain }]],
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
  it('is held at the end of a read and emitted when the next read is not a continuation', () => {
    const parser = createInputParser();
    expect(parser.push(bytesOf(ESC))).toEqual([]);
    expect(parser.push(bytesOf('a'))).toEqual([named('escape'), text('a')]);
  });

  it('stays held across an empty read', () => {
    const parser = createInputParser();
    expect(parser.push(bytesOf(ESC))).toEqual([]);
    expect(parser.push(new Uint8Array(0))).toEqual([]);
    expect(parser.push(bytesOf(ESC))).toEqual([named('escape')]);
    expect(parser.push(bytesOf('\r'))).toEqual([named('escape'), named('enter')]);
  });

  it.each([
    ['a CSI sequence', '[A', [named('up')]],
    ['an SS3 sequence', 'OP', [named('f1')]],
    ['an OSC reply', ']11;rgb:0000/0000/0000\u0007', [{ type: 'report', kind: 'background-color', color: 'rgb:0000/0000/0000' }]],
  ] as [string, string, TerminalEvent[]][])('is joined with a next read that begins %s', (_name, continuation, expected) => {
    expect(parseText(ESC, continuation)).toEqual(expected);
  });

  it('is Alt with the next character of the same read', () => {
    expect(parseText(`${ESC}a`)).toEqual([text('a', { alt: true })]);
  });
});

describe('sequences that are not recognised', () => {
  it('turns an unknown complete sequence into text', () => {
    expect(parseText(`${ESC}[5n`)).toEqual(textOf(`${ESC}[5n`));
  });

  it('turns an unknown OSC into text', () => {
    expect(parseText(`${ESC}]52;c;AA==\u0007`)).toEqual(textOf(`${ESC}]52;c;AA==\u0007`));
  });

  it('abandons a sequence at a byte that cannot continue it and parses that byte on its own', () => {
    expect(parseText(`${ESC}[1\r`)).toEqual([...textOf(`${ESC}[1`), named('enter')]);
  });

  it(`abandons a sequence that passes ${MAX_SEQUENCE_BYTES} bytes without a final byte`, () => {
    const overlong = `${ESC}[${'1'.repeat(300)}`;
    expect(parseText(overlong)).toEqual(textOf(overlong));
    expect(parse(...[...bytesOf(overlong)].map((byte) => Uint8Array.of(byte)))).toEqual(textOf(overlong));
  });

  it('emits the abandoned bytes as soon as the bound is reached', () => {
    const parser = createInputParser();
    expect(parser.push(bytesOf(`${ESC}[${'1'.repeat(MAX_SEQUENCE_BYTES - 3)}`))).toEqual([]);
    expect(parser.push(bytesOf('1'))).toEqual(textOf(`${ESC}[${'1'.repeat(MAX_SEQUENCE_BYTES - 2)}`));
  });

  it('keeps a sequence of exactly the bound', () => {
    const longest = `${ESC}[<${'0'.repeat(MAX_SEQUENCE_BYTES - 8)};1;1M`;
    expect(Buffer.byteLength(longest)).toBe(MAX_SEQUENCE_BYTES);
    expect(parseText(longest)).toEqual([{ type: 'mouse', kind: 'press', button: 'left', col: 1, row: 1, ...plain }]);
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

  it('ends an unterminated paste after 8 MiB and parses normally again', () => {
    const parser = createInputParser();
    const chunk = bytesOf('x'.repeat(64 * 1024));
    const events: TerminalEvent[] = [...parser.push(bytesOf(START))];
    for (let sent = 0; sent < PASTE_ABANDON_BYTES; sent += chunk.length) events.push(...parser.push(chunk));
    expect(events).toEqual([{ type: 'paste', text: '', overflow: true }]);
    expect(parser.push(bytesOf(`\r${ESC}[A`))).toEqual([named('enter'), named('up')]);
  });

  it('ends an unterminated paste at the same byte whatever the chunking', () => {
    const tail = 'abc';
    const whole = bytesOf(`${START}${'x'.repeat(PASTE_ABANDON_BYTES)}${tail}`);
    expect(parse(whole)).toEqual([{ type: 'paste', text: '', overflow: true }, ...textOf(tail)]);
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
