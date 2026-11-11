import { createHash } from 'node:crypto';
import type { ContentPart } from './open-responses.ts';
import type { AttachedFilePart, ImageAttachment, MessageAttachment, UserShellRecord } from './run-types.ts';

export const TOOL_OUTPUT_TAG = 'tool_output';

export const ATTACHED_FILE_TAG = 'attached_file';

export const USER_SHELL_TAG = 'user_shell_command';

const LONGER_BOUNDARY_STEP = 8;

export const sessionFenceOf = (session: { fenceNonce: string }): string => session.fenceNonce;

const boundaryFor = (text: string, sessionBoundary: string): string => {
  if (!text.includes(sessionBoundary)) return sessionBoundary;
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  for (let length = LONGER_BOUNDARY_STEP; length <= digest.length; length += LONGER_BOUNDARY_STEP) {
    const longer = `${sessionBoundary}${digest.slice(0, length)}`;
    if (!text.includes(longer)) return longer;
  }
  throw new Error('an untrusted text contains the session boundary followed by its own full sha256, so no longer boundary can be derived from it');
};

export const fenceUntrusted = (tag: string, attributes: Readonly<Record<string, string>>, text: string, sessionBoundary: string): string => {
  const boundary = boundaryFor(text, sessionBoundary);
  const named = Object.entries(attributes).map(([name, value]) => ` ${name}=${JSON.stringify(value)}`).join('');
  return `<${tag}${named} boundary="${boundary}">\n${text}\n</${tag} boundary="${boundary}">`;
};

export const imageDataUrl = (image: ImageAttachment): string => `data:${image.mediaType};base64,${image.data}`;

export const userShellText = (record: Pick<UserShellRecord, 'command' | 'exitCode' | 'output'>, sessionBoundary: string): string =>
  fenceUntrusted(USER_SHELL_TAG, { command: record.command, exit_code: record.exitCode === null ? '' : String(record.exitCode) }, record.output, sessionBoundary);

export const attachedFileText = (part: AttachedFilePart, sessionBoundary: string): string => fenceUntrusted(ATTACHED_FILE_TAG, { path: part.path }, part.content, sessionBoundary);

export const attachmentText = (part: MessageAttachment, sessionBoundary: string): string => (part.type === 'attached_file' ? attachedFileText(part, sessionBoundary) : part.text);

export type UserMessageExtras = { attachments?: readonly MessageAttachment[] | undefined };

export const includedShellTexts = (shell: readonly UserShellRecord[] | undefined, sessionBoundary: string): string[] =>
  (shell ?? []).filter((record) => record.include).map((record) => userShellText(record, sessionBoundary));

export const userMessageContent = (text: string, images: readonly ImageAttachment[] | undefined, extras: UserMessageExtras, sessionBoundary: string): ContentPart[] => [
  { type: 'input_text', text },
  ...(extras.attachments ?? []).map((part): ContentPart => ({ type: 'input_text', text: attachmentText(part, sessionBoundary) })),
  ...(images ?? []).map((image): ContentPart => ({ type: 'input_image', image_url: imageDataUrl(image) })),
];
