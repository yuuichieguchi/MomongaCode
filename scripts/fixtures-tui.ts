import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TUI_FIXTURE_DIRECTORY = path.join('packages', 'cli', 'test', 'tui', 'fixtures', 'terminal-protocols');

const MODIFIERS = ['ctrl', 'alt', 'shift', 'super', 'hyper', 'meta'] as const;

type Modifier = (typeof MODIFIERS)[number];

type FixtureEvent = Readonly<Record<string, unknown>>;

type TuiFixture = { readonly name: string; readonly source: string; readonly hex: string; readonly events: readonly FixtureEvent[]; readonly splitAfterEscape?: readonly FixtureEvent[] };

const key = (name: string, held: readonly Modifier[] = []): FixtureEvent => ({ type: 'key', name, ...Object.fromEntries(MODIFIERS.map((modifier) => [modifier, held.includes(modifier)])) });

const FIXTURES: readonly TuiFixture[] = [
  { name: "kitty-alt-enter", source: "kitty keyboard protocol page (sw.kovidgoyal.net/kitty/keyboard-protocol)", hex: "1b5b31333b3375", events: [key('enter', ['alt'])] },
  { name: "kitty-enter", source: "kitty keyboard protocol page (sw.kovidgoyal.net/kitty/keyboard-protocol)", hex: "1b5b313375", events: [key('enter')] },
  { name: "kitty-escape", source: "kitty keyboard protocol page (sw.kovidgoyal.net/kitty/keyboard-protocol)", hex: "1b5b323775", events: [key('escape')] },
  { name: "kitty-release", source: "kitty keyboard protocol page (sw.kovidgoyal.net/kitty/keyboard-protocol)", hex: "1b5b31333b323a3375", events: [{"type": "release"}] },
  { name: "kitty-shift-enter", source: "kitty keyboard protocol page (sw.kovidgoyal.net/kitty/keyboard-protocol)", hex: "1b5b31333b3275", events: [key('enter', ['shift'])] },
  { name: "kitty-text", source: "kitty keyboard protocol page (sw.kovidgoyal.net/kitty/keyboard-protocol)", hex: "1b5b39373b3b393775", events: [{"type": "key", "text": "a", "ctrl": false, "alt": false, "shift": false, "super": false, "hyper": false, "meta": false}] },
  { name: "legacy-alt-enter", source: "xterm control sequences (invisible-island.net/xterm/ctlseqs/ctlseqs.html)", hex: "1b0d", events: [key('enter', ['alt'])], splitAfterEscape: [key('escape'), key('enter')] },
  { name: "legacy-ctrl-j", source: "xterm control sequences (invisible-island.net/xterm/ctlseqs/ctlseqs.html)", hex: "0a", events: [{"type": "key", "text": "j", "ctrl": true, "alt": false, "shift": false, "super": false, "hyper": false, "meta": false}] },
  { name: "legacy-enter", source: "xterm control sequences (invisible-island.net/xterm/ctlseqs/ctlseqs.html)", hex: "0d", events: [key('enter')] },
  { name: "legacy-up", source: "xterm control sequences (invisible-island.net/xterm/ctlseqs/ctlseqs.html)", hex: "1b5b41", events: [key('up')] },
  { name: "mouse-press", source: "xterm control sequences (invisible-island.net/xterm/ctlseqs/ctlseqs.html)", hex: "1b5b3c303b31303b354d", events: [{"type": "mouse", "kind": "press", "button": "left", "col": 10, "row": 5, "ctrl": false, "alt": false, "shift": false}] },
  { name: "mouse-release", source: "xterm control sequences (invisible-island.net/xterm/ctlseqs/ctlseqs.html)", hex: "1b5b3c303b31303b356d", events: [{"type": "mouse", "kind": "release", "button": "left", "col": 10, "row": 5, "ctrl": false, "alt": false, "shift": false}] },
  { name: "mouse-wheel", source: "xterm control sequences (invisible-island.net/xterm/ctlseqs/ctlseqs.html)", hex: "1b5b3c36343b31303b354d", events: [{"type": "mouse", "kind": "wheel", "button": "wheel-up", "col": 10, "row": 5, "ctrl": false, "alt": false, "shift": false}] },
  { name: "paste-with-embedded-sequence", source: "xterm control sequences (invisible-island.net/xterm/ctlseqs/ctlseqs.html)", hex: "1b5b3230307e611b5b41621b5b3230317e", events: [{"type": "paste", "text": "a\u001b[Ab", "overflow": false}] },
  { name: "reply-decrqm-1006", source: "xterm control sequences (invisible-island.net/xterm/ctlseqs/ctlseqs.html)", hex: "1b5b3f313030363b312479", events: [{"type": "report", "kind": "mode", "mode": 1006, "value": 1}] },
  { name: "reply-device-attributes", source: "xterm control sequences (invisible-island.net/xterm/ctlseqs/ctlseqs.html)", hex: "1b5b3f313b3263", events: [{"type": "report", "kind": "device-attributes", "attributes": [1, 2]}] },
  { name: "reply-kitty-flags", source: "kitty keyboard protocol page (sw.kovidgoyal.net/kitty/keyboard-protocol)", hex: "1b5b3f3075", events: [{"type": "report", "kind": "kitty-keys", "flags": 0}] },
  { name: "reply-osc-11", source: "xterm control sequences (invisible-island.net/xterm/ctlseqs/ctlseqs.html)", hex: "1b5d31313b7267623a303030302f303030302f303030301b5c", events: [{"type": "report", "kind": "background-color", "color": "rgb:0000/0000/0000"}] },
  { name: "xterm-modify-other-keys-shift-enter", source: "xterm control sequences (invisible-island.net/xterm/ctlseqs/ctlseqs.html)", hex: "1b5b32373b323b31337e", events: [key('enter', ['shift'])] },
];

export const tuiFixtureFiles = (): Readonly<Record<string, string>> => Object.fromEntries(FIXTURES.map((fixture) => [`${fixture.name}.json`, `${JSON.stringify(fixture, null, 2)}\n`]));

const writeTuiFixtures = (root: string): void => {
  const directory = path.join(root, TUI_FIXTURE_DIRECTORY);
  const files = tuiFixtureFiles();
  for (const stale of fs.readdirSync(directory)) if (!(stale in files)) fs.rmSync(path.join(directory, stale));
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), text);
};

if (import.meta.main) writeTuiFixtures(fileURLToPath(new URL('..', import.meta.url)));
