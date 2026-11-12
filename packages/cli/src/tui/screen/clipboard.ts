import { PROMPT_IMAGE_MAX_BYTES, imageMediaTypeOf } from '@momonga/protocol';
import type { ImageAttachment } from '@momonga/protocol';
import { COPY_MAX_BYTES, OSC52_MAX_RAW_BYTES } from './constants.ts';

export type ClipboardHost = {
  env: Readonly<Record<string, string | undefined>>;
  findProgram(name: string): string | undefined;
  pipe(file: string, args: readonly string[], payload: string): Promise<void>;
  writeTerminal(text: string): void;
};

type ProgramRoute = { name: string; kind: 'program'; args: readonly string[]; needsEnv: readonly string[]; writesThisMachine: boolean };

type TerminalRoute = { name: 'osc52'; kind: 'terminal' };

export type ClipboardRoute = ProgramRoute | TerminalRoute;

const hostProgram = (name: string, args: readonly string[] = [], needsEnv: readonly string[] = []): ProgramRoute => ({ name, kind: 'program', args, needsEnv, writesThisMachine: true });

export const CLIPBOARD_ROUTES: readonly ClipboardRoute[] = [
  hostProgram('pbcopy'),
  hostProgram('wl-copy', [], ['WAYLAND_DISPLAY']),
  hostProgram('xclip', ['-selection', 'clipboard'], ['DISPLAY']),
  hostProgram('xsel', ['--clipboard', '--input'], ['DISPLAY']),
  hostProgram('clip.exe'),
  { name: 'tmux', kind: 'program', args: ['load-buffer', '-w', '-'], needsEnv: ['TMUX'], writesThisMachine: false },
  { name: 'osc52', kind: 'terminal' },
];

const isSet = (host: ClipboardHost, name: string): boolean => (host.env[name] ?? '') !== '';

const overSsh = (host: ClipboardHost): boolean => isSet(host, 'SSH_CONNECTION') || isSet(host, 'SSH_TTY');

export type ChosenRoute = { name: string; kind: 'program'; file: string; args: readonly string[] } | TerminalRoute;

const usable = (host: ClipboardHost, route: ClipboardRoute): ChosenRoute | undefined => {
  if (route.kind === 'terminal') return route;
  if (route.writesThisMachine && overSsh(host)) return undefined;
  if (!route.needsEnv.every((name) => isSet(host, name))) return undefined;
  const file = host.findProgram(route.name);
  return file === undefined ? undefined : { name: route.name, kind: 'program', file, args: route.args };
};

export const chooseClipboardRoute = (host: ClipboardHost): ChosenRoute => {
  for (const route of CLIPBOARD_ROUTES) {
    const chosen = usable(host, route);
    if (chosen !== undefined) return chosen;
  }
  throw new Error('the clipboard routes end with one that is always usable');
};

export type ClipboardReadHost = {
  env: Readonly<Record<string, string | undefined>>;
  findProgram(name: string): string | undefined;
  capture(file: string, args: readonly string[], maxBytes: number, signal: AbortSignal): Promise<Uint8Array | undefined>;
};

type ReadCommand = { program: string; args: readonly string[] };

type ImageDecoding = 'raw' | 'applescript-data';

export type ClipboardReadRoute = { needsEnv: readonly string[]; image: ReadCommand & { decoding: ImageDecoding }; text: ReadCommand };

export const CLIPBOARD_READ_ROUTES: readonly ClipboardReadRoute[] = [
  { needsEnv: [], image: { program: 'osascript', args: ['-e', 'get the clipboard as «class PNGf»'], decoding: 'applescript-data' }, text: { program: 'pbpaste', args: [] } },
  { needsEnv: ['WAYLAND_DISPLAY'], image: { program: 'wl-paste', args: ['--type', 'image/png'], decoding: 'raw' }, text: { program: 'wl-paste', args: ['--no-newline'] } },
  { needsEnv: ['DISPLAY'], image: { program: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'], decoding: 'raw' }, text: { program: 'xclip', args: ['-selection', 'clipboard', '-o'] } },
];

export type ClipboardContent = { kind: 'image'; image: ImageAttachment } | { kind: 'text'; text: string } | { kind: 'empty' } | { kind: 'unsupported' };

const APPLESCRIPT_DATA = /«data \w{4}([0-9A-Fa-f]*)»/;

const decodedImage = (bytes: Uint8Array, decoding: ImageDecoding): Uint8Array => {
  if (decoding === 'raw') return bytes;
  const hex = APPLESCRIPT_DATA.exec(Buffer.from(bytes).toString('utf8'))?.[1];
  return hex === undefined ? new Uint8Array() : Buffer.from(hex, 'hex');
};

export const readClipboardThroughRoutes = async (host: ClipboardReadHost, signal: AbortSignal): Promise<ClipboardContent> => {
  for (const route of CLIPBOARD_READ_ROUTES) {
    if (!route.needsEnv.every((name) => (host.env[name] ?? '') !== '')) continue;
    const imageProgram = host.findProgram(route.image.program);
    const textProgram = host.findProgram(route.text.program);
    if (imageProgram === undefined || textProgram === undefined) continue;
    const captured = await host.capture(imageProgram, route.image.args, PROMPT_IMAGE_MAX_BYTES * (route.image.decoding === 'raw' ? 1 : 2) + 64, signal);
    const bytes = captured === undefined ? new Uint8Array() : decodedImage(captured, route.image.decoding);
    const mediaType = imageMediaTypeOf(bytes);
    if (mediaType !== undefined) return { kind: 'image', image: { mediaType, data: Buffer.from(bytes).toString('base64') } };
    const text = await host.capture(textProgram, route.text.args, PROMPT_IMAGE_MAX_BYTES, signal);
    return text === undefined || text.byteLength === 0 ? { kind: 'empty' } : { kind: 'text', text: Buffer.from(text).toString('utf8') };
  }
  return { kind: 'unsupported' };
};

export type CopyOutcome = { kind: 'copied'; characters: number } | { kind: 'failed'; cause: string } | { kind: 'too-large'; bytes: number; through: 'terminal' | 'any' };

const OSC = '\u001b]';
const BEL = '\u0007';

export const osc52Of = (text: string): string => `${OSC}52;c;${Buffer.from(text, 'utf8').toString('base64')}${BEL}`;

const charactersOf = (text: string): number => [...text].length;

export const copyThroughRoutes = async (host: ClipboardHost, text: string): Promise<CopyOutcome> => {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > COPY_MAX_BYTES) return { kind: 'too-large', bytes, through: 'any' };
  const route = chooseClipboardRoute(host);
  if (route.kind === 'terminal') {
    if (bytes > OSC52_MAX_RAW_BYTES) return { kind: 'too-large', bytes, through: 'terminal' };
    host.writeTerminal(osc52Of(text));
    return { kind: 'copied', characters: charactersOf(text) };
  }
  try {
    await host.pipe(route.file, route.args, text);
  } catch (error) {
    return { kind: 'failed', cause: error instanceof Error ? error.message : String(error) };
  }
  return { kind: 'copied', characters: charactersOf(text) };
};

export const copyMessage = (outcome: CopyOutcome): string => {
  switch (outcome.kind) {
    case 'copied':
      return `Copied ${outcome.characters} characters`;
    case 'failed':
      return `Could not copy: ${outcome.cause}`;
    case 'too-large':
      return outcome.through === 'terminal' ? `Too large to copy through the terminal (${outcome.bytes} bytes)` : `Too large to copy (${outcome.bytes} bytes)`;
  }
};
