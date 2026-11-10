import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const TUI = path.resolve(import.meta.dirname, '..', 'packages', 'cli', 'src', 'tui');

const OWNERS = ['keys/', 'terminal/'];

const KEY_WORDS = 'esc|escape|enter|return|tab|backspace|delete|space|up|down|left|right|pageup|pagedown|home|end';

const FOLLOWED = ' to | on an? | again| submits| cancels| copies| stops| shows| removes| closes';

const LITERAL_KEY: readonly RegExp[] = [
  /\b(?:key|pressed|event)\.(?:upArrow|downArrow|leftArrow|rightArrow|pageUp|pageDown|return|escape|backspace|tab|home|end|delete)\b/,
  new RegExp(`\\.name\\s*[!=]==\\s*['"\`](?:${KEY_WORDS})['"\`]`),
  /\.(?:ctrl|alt|shift|meta)\b[^;\n]*[!=]==\s*['"`][a-zA-Z_]['"`]/,
  /[!=]==\s*['"`][a-zA-Z_]['"`][^;\n]*\.(?:ctrl|alt|shift|meta)\b/,
  /\b(?:input|text)(?:\.toLowerCase\(\))?\s*===\s*['"`][a-zA-Z]['"`]/,
];

const WRITTEN_KEY: readonly RegExp[] = [
  /['"`>(\s](?:ctrl|alt|shift|cmd|opt|option|meta)\+[a-z0-9_[\]]/i,
  new RegExp(`['"\`]\\s*(?:${KEY_WORDS}|up/down)(?::\\s|${FOLLOWED})`, 'i'),
  new RegExp(`\\(\\s*(?:${KEY_WORDS}|up/down)(?:${FOLLOWED})`, 'i'),
  new RegExp(`\\b[Pp]ress (?:${KEY_WORDS})\\b`),
  /[.!?] (?:Esc|Enter|Tab|Backspace) [a-z]/,
  /\b1-9 or [a-z]/,
];

const comparesAKey = (source: string): boolean => LITERAL_KEY.some((pattern) => pattern.test(source));

const writesAKey = (source: string): boolean => WRITTEN_KEY.some((pattern) => pattern.test(source));

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

const offenders = (found: (source: string) => boolean): string[] =>
  sourceFiles(TUI)
    .map((file) => ({ name: path.relative(TUI, file).split(path.sep).join('/'), lines: fs.readFileSync(file, 'utf8').split('\n') }))
    .filter(({ name }) => !OWNERS.some((owner) => name.startsWith(owner)))
    .flatMap(({ name, lines }) => lines.flatMap((line, index) => (found(line) ? [`${name}:${index + 1}`] : [])));

describe('the key table is the only place of the screens that names a key', () => {
  it('recognises each way of comparing a key and leaves the table lookups alone', () => {
    for (const compared of [
      'if (key.escape) close();',
      'if (key.return && text === "") submit();',
      'else if (pressed.upArrow) place(shown, shown.top - 1);',
      "if (key.ctrl && input === 'c') return false;",
      "if (input === 'k') return moved(spec, state, capacity, up);",
      "if (event.name === 'pageup' && !event.ctrl) return { kind: 'rows', rows: -half };",
      "const isCopy = 'text' in event && event.text.toLowerCase() === 'c' && event.ctrl;",
      "const isEscape = (event: KeyEvent): boolean => 'name' in event && event.name === 'escape';",
    ])
      expect(comparesAKey(compared), compared).toBe(true);
    for (const looked of [
      "const action = keys.actionOf(['select'], event);",
      "if (action === 'select.escape') return back();",
      'if (!modified && !facts.inputEmpty) return false;',
      "return spec.escape === 'inactive' ? { state } : decided;",
      "if (command.name === 'model') return picker;",
      "if (source[position] === '_') return 1;",
      'return actOnViewport(action, event.ctrl);',
      "decideOn: 'enter',",
    ])
      expect(comparesAKey(looked), looked).toBe(false);
  });

  it('recognises a key written into a text by hand and leaves the generated hints alone', () => {
    for (const written of [
      "const HINT = 'esc to return';",
      "const choose = '1-9 or enter to choose';",
      "export const VIEWER_KEY = 'ctrl+o';",
      '<Text>{`… ${more} more lines (ctrl+o shows all)`}</Text>',
      "const TEXT = 'A task is running. Esc stops it.';",
      "const leftOf = `mode: ${mode} (shift+tab)`;",
      "confirm: (row) => `press enter again to sign out ${row.label}`,",
      "const LINE = '(backspace on an empty input removes the last)';",
      "const cancel = ['enter submits the pasted URL', 'esc cancels'];",
      "...(spec.alt === undefined ? [] : [`tab: ${spec.alt.label}`]),",
    ])
      expect(writesAKey(written), written).toBe(true);
    for (const generated of [
      '...keyed(keys.keyHint(\'select.escape\'), (key) => `${key}: go back`),',
      'return `${key} to cancel`;',
      "if (text.trim() === '') return 'enter the context window as a whole number of tokens';",
      "decideOn: 'enter',",
      "escape: 'back',",
      "const description = 'show or switch the screen mode: fullscreen, or scrollback';",
      "const STARTING = 'starting the momonga daemon';",
    ])
      expect(writesAKey(generated), generated).toBe(false);
  });

  it('finds no compared key in any file of the screens outside the key table and the terminal layer', () => {
    expect(offenders(comparesAKey)).toEqual([]);
  });

  it('finds no key written into a text by hand in any file of the screens outside the key table and the terminal layer', () => {
    expect(offenders(writesAKey)).toEqual([]);
  });
});
