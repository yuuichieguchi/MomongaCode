import path from 'node:path';
import type { Word } from './shell.ts';

type WrapperSpec = {
  flags?: string;
  valued?: string;
  attachedOnly?: string;
  longFlags?: string[];
  longValued?: string[];
  exactFlags?: string[];
  exactValued?: string[];
  payloadShort?: string;
  payloadLong?: string[];
  positionals?: number;
  assignments?: boolean;
  digitFlags?: boolean;
};

const WRAPPER_SPECS: Readonly<Record<string, WrapperSpec>> = {
  env: {
    flags: 'i0v',
    valued: 'uCPa',
    payloadShort: 'S',
    longFlags: ['ignore-environment', 'null', 'debug'],
    longValued: ['unset', 'chdir', 'argv0'],
    payloadLong: ['split-string'],
    assignments: true,
  },
  xargs: {
    flags: '0oprtxh',
    valued: 'IELPnsdaJ',
    attachedOnly: 'ile',
    longFlags: ['null', 'no-run-if-empty', 'verbose', 'interactive', 'exit', 'open-tty', 'show-limits', 'replace', 'eof', 'max-lines', 'help', 'version'],
    longValued: ['max-args', 'max-procs', 'delimiter', 'arg-file', 'max-chars', 'process-slot-var'],
  },
  timeout: {
    flags: 'v',
    valued: 'sk',
    longFlags: ['foreground', 'preserve-status', 'verbose'],
    longValued: ['signal', 'kill-after'],
    positionals: 1,
  },
  sudo: {
    flags: 'AbBEHiKknPSsVv',
    valued: 'uCDghprtUTR',
    longFlags: ['askpass', 'background', 'bell', 'preserve-env', 'login', 'non-interactive', 'preserve-groups', 'set-home', 'shell', 'stdin', 'reset-timestamp', 'remove-timestamp'],
    longValued: ['user', 'group', 'close-from', 'chdir', 'host', 'prompt', 'role', 'type', 'other-user', 'chroot', 'command-timeout'],
    assignments: true,
  },
  doas: { flags: 'nsL', valued: 'uC' },
  nice: { valued: 'n', longValued: ['adjustment'], digitFlags: true },
  ionice: { flags: 't', valued: 'cnpPu', longValued: ['class', 'classdata', 'pid', 'pgid', 'uid'], longFlags: ['ignore'] },
  stdbuf: { valued: 'ioe', longValued: ['input', 'output', 'error'] },
  flock: {
    flags: 'sxenuoF',
    valued: 'wE',
    payloadShort: 'c',
    longFlags: ['shared', 'exclusive', 'nonblock', 'nb', 'unlock', 'close', 'no-fork', 'verbose'],
    longValued: ['timeout', 'wait', 'conflict-exit-code'],
    payloadLong: ['command'],
    positionals: 1,
  },
  chroot: { longFlags: ['skip-chdir'], longValued: ['userspec', 'groups'], positionals: 1 },
  script: { flags: 'aeFkqrdf', valued: 'tEIOBT', payloadShort: 'c', payloadLong: ['command'], positionals: 1 },
  'sandbox-exec': { valued: 'fpnD' },
  watch: {
    flags: 'bcCegpqtx',
    valued: 'n',
    attachedOnly: 'd',
    longFlags: ['beep', 'color', 'no-color', 'errexit', 'chgexit', 'precise', 'no-title', 'exec', 'differences', 'equexit'],
    longValued: ['interval'],
  },
  parallel: {
    flags: 'kXmqvtu0gzdU',
    valued: 'jnNLSaIsrC',
    longFlags: ['will-cite', 'keep-order', 'null', 'halt', 'bar', 'progress', 'eta', 'dry-run', 'tag', 'group', 'ungroup', 'line-buffer', 'citation', 'semaphore'],
    longValued: ['jobs', 'arg-file', 'max-args', 'max-replace-args', 'delimiter', 'sshlogin', 'joblog', 'results', 'timeout', 'retries', 'colsep', 'header'],
  },
  caffeinate: { flags: 'dimsu', valued: 'tw' },
  time: { flags: 'apvlh', valued: 'fo', longFlags: ['append', 'portability', 'verbose'], longValued: ['format', 'output'] },
  nohup: {},
  command: { flags: 'pvV' },
  builtin: {},
  exec: { flags: 'cl', valued: 'a' },
  busybox: {},
  setsid: { flags: 'cfw', longFlags: ['ctty', 'fork', 'wait'] },
  arch: { exactFlags: ['-arm64', '-x86_64', '-x86_64h', '-i386', '-32', '-64'], exactValued: ['-arch'] },
  unbuffer: { flags: 'p' },
};

export const COMMAND_WRAPPERS: ReadonlySet<string> = new Set(Object.keys(WRAPPER_SPECS));

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

export type EffectiveCommand = { index: number; unanalyzable: boolean; payloads: Word[] };

type OptionOutcome = { next: number; unknown: boolean; payload?: Word };

const parseLongOption = (words: Word[], at: number, spec: WrapperSpec): OptionOutcome => {
  const text = (words[at] as Word).value;
  const equals = text.indexOf('=');
  const name = text.slice(2, equals === -1 ? undefined : equals);
  const attached = equals === -1 ? undefined : text.slice(equals + 1);
  const valueWord = (): Word | undefined => (attached === undefined ? words[at + 1] : undefined);
  const consumed = attached === undefined ? 2 : 1;
  if (spec.payloadLong?.includes(name) === true) {
    const payload = attached === undefined ? words[at + 1] : syntheticWord(attached, words[at] as Word);
    return payload === undefined ? { next: at + 1, unknown: true } : { next: at + consumed, unknown: false, payload };
  }
  if (spec.longValued?.includes(name) === true) {
    return attached === undefined && valueWord() === undefined ? { next: at + 1, unknown: true } : { next: at + consumed, unknown: false };
  }
  if (spec.longFlags?.includes(name) === true) return { next: at + 1, unknown: false };
  return { next: at + 1, unknown: true };
};

const syntheticWord = (value: string, origin: Word): Word => ({ value, literal: origin.literal, plain: origin.plain, staticValue: origin.literal ? value : null });

const parseShortCluster = (words: Word[], at: number, spec: WrapperSpec): OptionOutcome => {
  const word = words[at] as Word;
  const text = word.value;
  for (let position = 1; position < text.length; position += 1) {
    const letter = text.charAt(position);
    const rest = text.slice(position + 1);
    if (spec.payloadShort === letter) {
      const payload = rest === '' ? words[at + 1] : syntheticWord(rest, word);
      return payload === undefined ? { next: at + 1, unknown: true } : { next: at + (rest === '' ? 2 : 1), unknown: false, payload };
    }
    if (spec.valued?.includes(letter) === true) {
      if (rest !== '') return { next: at + 1, unknown: false };
      return words[at + 1] === undefined ? { next: at + 1, unknown: true } : { next: at + 2, unknown: false };
    }
    if (spec.attachedOnly?.includes(letter) === true) return { next: at + 1, unknown: false };
    const known = spec.flags?.includes(letter) === true || (spec.digitFlags === true && /[0-9]/.test(letter));
    if (!known) return { next: at + 1, unknown: true };
  }
  return { next: at + 1, unknown: false };
};

const parseOption = (words: Word[], at: number, spec: WrapperSpec): OptionOutcome => {
  const text = (words[at] as Word).value;
  if (spec.exactFlags?.includes(text) === true) return { next: at + 1, unknown: false };
  if (spec.exactValued?.includes(text) === true) {
    return words[at + 1] === undefined ? { next: at + 1, unknown: true } : { next: at + 2, unknown: false };
  }
  return text.startsWith('--') ? parseLongOption(words, at, spec) : parseShortCluster(words, at, spec);
};

export const locateEffectiveCommand = (words: Word[]): EffectiveCommand => {
  const payloads: Word[] = [];
  let index = 0;
  for (;;) {
    while (index < words.length && ASSIGNMENT.test((words[index] as Word).value)) index += 1;
    const word = words[index];
    if (word === undefined) return { index: -1, unanalyzable: false, payloads };
    const spec = word.literal ? WRAPPER_SPECS[path.basename(word.value)] : undefined;
    if (spec === undefined) return { index, unanalyzable: false, payloads };

    let cursor = index + 1;
    let positionalsLeft = spec.positionals ?? 0;
    let optionsOpen = true;
    for (;;) {
      const current = words[cursor];
      if (current === undefined) return { index: -1, unanalyzable: false, payloads };
      const isOption = optionsOpen && current.literal && current.value.startsWith('-') && current.value !== '-';
      if (optionsOpen && current.literal && current.value === '--') {
        optionsOpen = false;
        cursor += 1;
      } else if (current.literal && current.value === '-' && spec.assignments === true) {
        cursor += 1;
      } else if (isOption) {
        const outcome = parseOption(words, cursor, spec);
        if (outcome.unknown) return { index, unanalyzable: true, payloads };
        if (outcome.payload !== undefined) payloads.push(outcome.payload);
        cursor = outcome.next;
      } else if (spec.assignments === true && ASSIGNMENT.test(current.value)) {
        cursor += 1;
      } else if (positionalsLeft > 0) {
        positionalsLeft -= 1;
        cursor += 1;
      } else {
        break;
      }
    }
    index = cursor;
  }
};
