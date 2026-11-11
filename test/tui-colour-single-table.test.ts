import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const TUI = path.resolve(import.meta.dirname, '..', 'packages', 'cli', 'src', 'tui');

const THE_TABLE = 'screen/theme.ts';

const PENDING: Readonly<Record<string, string>> = {};

const COLOUR_NAMES = 'black|red|green|yellow|blue|magenta|cyan|white|gray|grey';

const RAW_COLOUR: readonly RegExp[] = [
  /\b\w*[cC]olor=(?:\{\s*)?['"`]/,
  /\b(?:color|\w+Color):\s*['"`]/,
  /['"`]#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})['"`]/,
  new RegExp(`['"\`](?:${COLOUR_NAMES})(?:Bright)?['"\`]`),
  new RegExp(`['"\`](?:bg(?:${COLOUR_NAMES.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())})(?:Bright)?)['"\`]`),
  /['"`](?:ansi256|rgb)\(/,
  /\\(?:u001b|x1b|e)\[(?:[0-9;]*;)?(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])(?:;[0-9;]*)?m/i,
];

const namesAColour = (source: string): boolean => RAW_COLOUR.some((pattern) => pattern.test(source));

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

const filesNamingAColour = (): string[] =>
  sourceFiles(TUI)
    .filter((file) => namesAColour(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(TUI, file).split(path.sep).join('/'))
    .sort();

describe('the token table is the only place of the screens that names a colour', () => {
  it('recognises each way of naming a colour and leaves the attributes alone', () => {
    for (const named of [
      '<Text color="red">x</Text>',
      "<Text color={'red'}>x</Text>",
      '<Box borderColor="gray">',
      '<Text backgroundColor="#102030">x</Text>',
      "const style = { color: 'cyan' };",
      "const tint = '#a9744f';",
      "return 'green';",
      "return 'redBright';",
      "const background = 'bgBlue';",
      "const paint = 'ansi256(73)';",
      "const paint = 'rgb(1, 2, 3)';",
      "const red = '\\u001b[31m';",
      "const tint = '\\u001b[1;38;2;1;2;3m';",
    ])
      expect(namesAColour(named), named).toBe(true);
    for (const plain of [
      '<Text dimColor>x</Text>',
      '<Text bold inverse underline>x</Text>',
      '<Box {...borderOf(\'border\')}>',
      'backgroundColor: string | undefined;',
      "startup={{ color: (env['NO_COLOR'] ?? '') === '' }}",
      'const { color } = styleOfToken(token, appearance);',
      "const bold = '\\u001b[1m';",
      "const clear = '\\u001b[2J\\u001b[3J\\u001b[H';",
      "wrapText(text, width, { token: 'error' })",
    ])
      expect(namesAColour(plain), plain).toBe(false);
  });

  it('holds for every file of the screens except the table and the files still pending', () => {
    expect(filesNamingAColour()).toEqual([...Object.keys(PENDING), THE_TABLE].sort());
  });
});
