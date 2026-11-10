import { ESTIMATED_CHARACTERS_PER_TOKEN, floorRatio, imageMediaTypeOf } from '@momonga/protocol';
import type { AttachmentNotePart, ImageAttachment, MessageAttachment, Ratio } from '@momonga/protocol';

export const ATTACH_FILE_SHARE: Ratio = { num: 1, den: 10 };
export const ATTACH_TOTAL_SHARE: Ratio = { num: 1, den: 4 };
export const ATTACH_MAX_FILES = 16;
export const ATTACH_DIR_ENTRIES = 200;
export const ATTACH_SNIFF_BYTES = 8 * 1024;
export const ATTACH_READ_FACTOR = 4;

const LINE_NUMBER_COLUMNS = 6;
const FENCE = /^\s*(```|~~~)/;
const MENTION = /(?:^|(?<=\s))@(?:"([^"\n]+)"|([^\s"`]+))/g;
const CODE_SPAN = /`[^`\n]*`/g;

const withoutCode = (text: string): string => {
  let fenced = false;
  return text
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return '';
      }
      return fenced ? '' : line.replace(CODE_SPAN, (span) => ' '.repeat(span.length));
    })
    .join('\n');
};

export const mentionsOf = (text: string): string[] => {
  const paths = [...withoutCode(text).matchAll(MENTION)].map((match) => match[1] ?? match[2] ?? '');
  return paths.filter((path, index) => path !== '' && paths.indexOf(path) === index);
};

export type AttachLimits = { perFile: number; total: number; maxFiles: number; readBytes: number };

export const attachLimitsFor = (ceiling: number): AttachLimits => {
  const perFile = floorRatio(ATTACH_FILE_SHARE, ceiling);
  return { perFile, total: floorRatio(ATTACH_TOTAL_SHARE, ceiling), maxFiles: ATTACH_MAX_FILES, readBytes: ATTACH_READ_FACTOR * ESTIMATED_CHARACTERS_PER_TOKEN * perFile };
};

export const admits = (limits: AttachLimits, admitted: number, estimate: number): boolean => estimate <= limits.perFile && admitted + estimate <= limits.total;

export const numberedContent = (text: string): string => {
  if (text === '') return '';
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line, index) => `${String(index + 1).padStart(LINE_NUMBER_COLUMNS)}\t${line}`).join('\n');
};

export const directoryListing = (entries: readonly string[]): string => {
  const rest = entries.length - ATTACH_DIR_ENTRIES;
  return [...entries.slice(0, ATTACH_DIR_ENTRIES), ...(rest > 0 ? [`… +${rest} more`] : [])].join('\n');
};

const cannotAttach = (path: string, cause: string): AttachmentNotePart => ({
  type: 'attachment_note',
  path,
  text: `The user referenced ${path}, which cannot be attached (${cause}). Do not try to read it unless asked.`,
  shown: `${path}: not attached (${cause})`,
});

const DENIED_BY_RULE = 'denied by a rule';
const COULD_NOT_BE_READ = 'it could not be read';

const tooLarge = (path: string, tokens: number, room: number): AttachmentNotePart => ({
  type: 'attachment_note',
  path,
  text: `Note: ${path} is about ${tokens} tokens, more than the ${room} tokens that fit with the rest of the context. It was not attached. Read the range you need with the read tool.`,
  shown: `${path}: too large to attach (${tokens} tokens > ${room}); the model was told to read what it needs`,
});

const tooMany = (path: string): AttachmentNotePart => ({
  type: 'attachment_note',
  path,
  text: `Note: ${path} was not attached: at most ${ATTACH_MAX_FILES} files are attached to one message. Read it with the read tool.`,
  shown: `${path}: not attached (at most ${ATTACH_MAX_FILES} files per message)`,
});

const notText = (path: string): AttachmentNotePart => {
  const text = `${path} is not a text file`;
  return { type: 'attachment_note', path, text, shown: text };
};

export type AttachTarget = { absolute: string; shown: string; kind: 'file' | 'directory'; size: number };

export type AttachHost = {
  readonly ceiling: number;
  readonly trusted: boolean;
  readonly imageInput: boolean;
  tokens(text: string): number;
  resolve(path: string): Promise<AttachTarget | 'outside' | undefined>;
  floor(absolute: string): Promise<'allowed' | 'denied'>;
  read(absolute: string, maxBytes: number): Promise<Uint8Array>;
  list(absolute: string): Promise<readonly string[]>;
};

export type AttachedMentions = { attachments: MessageAttachment[]; images: ImageAttachment[] };

const decoder = new TextDecoder('utf-8', { fatal: true });

const textOf = (bytes: Uint8Array): string | undefined => {
  if (bytes.subarray(0, ATTACH_SNIFF_BYTES).includes(0)) return undefined;
  try {
    return decoder.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
};

type Loaded = { kind: 'content'; content: string } | { kind: 'image'; image: ImageAttachment } | { kind: 'note'; note: AttachmentNotePart };

const loadFile = async (target: AttachTarget, host: AttachHost, limits: AttachLimits, room: number): Promise<Loaded> => {
  if (target.size > limits.readBytes) return { kind: 'note', note: tooLarge(target.shown, Math.ceil(target.size / ESTIMATED_CHARACTERS_PER_TOKEN), room) };
  let bytes: Uint8Array;
  try {
    bytes = await host.read(target.absolute, limits.readBytes);
  } catch {
    return { kind: 'note', note: cannotAttach(target.shown, COULD_NOT_BE_READ) };
  }
  const mediaType = imageMediaTypeOf(bytes);
  if (mediaType !== undefined) return host.imageInput ? { kind: 'image', image: { mediaType, data: Buffer.from(bytes).toString('base64') } } : { kind: 'note', note: notText(target.shown) };
  const text = textOf(bytes);
  return text === undefined ? { kind: 'note', note: notText(target.shown) } : { kind: 'content', content: numberedContent(text) };
};

const loadDirectory = async (target: AttachTarget, host: AttachHost): Promise<Loaded> => {
  try {
    return { kind: 'content', content: directoryListing(await host.list(target.absolute)) };
  } catch {
    return { kind: 'note', note: cannotAttach(target.shown, COULD_NOT_BE_READ) };
  }
};

export const attachMentions = async (text: string, host: AttachHost): Promise<AttachedMentions> => {
  const limits = attachLimitsFor(host.ceiling);
  const attachments: MessageAttachment[] = [];
  const images: ImageAttachment[] = [];
  let admitted = 0;
  let files = 0;
  for (const mention of mentionsOf(text)) {
    const target = await host.resolve(mention);
    if (target === undefined) continue;
    if (target === 'outside' || !host.trusted || (await host.floor(target.absolute)) === 'denied') {
      attachments.push(cannotAttach(target === 'outside' ? mention : target.shown, DENIED_BY_RULE));
      continue;
    }
    const shown = target.kind === 'directory' && !target.shown.endsWith('/') ? `${target.shown}/` : target.shown;
    if (files >= limits.maxFiles) {
      attachments.push(tooMany(shown));
      continue;
    }
    const room = Math.min(limits.perFile, limits.total - admitted);
    const loaded = target.kind === 'directory' ? await loadDirectory(target, host) : await loadFile(target, host, limits, room);
    if (loaded.kind === 'note') {
      attachments.push(loaded.note);
      continue;
    }
    if (loaded.kind === 'image') {
      images.push(loaded.image);
      files += 1;
      continue;
    }
    const estimate = host.tokens(loaded.content);
    if (!admits(limits, admitted, estimate)) {
      attachments.push(tooLarge(shown, estimate, room));
      continue;
    }
    admitted += estimate;
    files += 1;
    attachments.push({ type: 'attached_file', path: shown, content: loaded.content, truncated: false });
  }
  return { attachments, images };
};
