import type { ContentPart } from './open-responses.ts';
import type { AttachedFilePart, ImageAttachment, MessageAttachment, UserShellRecord } from './run-types.ts';

export const TOOL_OUTPUT_TAG = 'tool_output';

export const ATTACHED_FILE_TAG = 'attached_file';

export const USER_SHELL_TAG = 'user_shell_command';

export const FORGE_ISSUE_TAG = 'forge_issue';

export const sessionFenceOf = (session: { fenceNonce: string }): string => session.fenceNonce;

export const FENCE_BOUNDARY_MARKER = '[fence-boundary]';

const withoutBoundary = (text: string, boundary: string): string => text.replaceAll(boundary, FENCE_BOUNDARY_MARKER);

export const fenceUntrusted = (tag: string, attributes: Readonly<Record<string, string>>, text: string, boundary: string): string => {
  const named = Object.entries(attributes).map(([name, value]) => ` ${name}=${JSON.stringify(value)}`).join('');
  return `<${tag}${named} boundary="${boundary}">\n${withoutBoundary(text, boundary)}\n</${tag} boundary="${boundary}">`;
};

export const imageDataUrl = (image: ImageAttachment): string => `data:${image.mediaType};base64,${image.data}`;

export const userShellText = (record: Pick<UserShellRecord, 'command' | 'exitCode' | 'output'>, sessionBoundary: string): string =>
  fenceUntrusted(USER_SHELL_TAG, { command: record.command, exit_code: record.exitCode === null ? '' : String(record.exitCode) }, record.output, sessionBoundary);

export const attachedFileText = (part: AttachedFilePart, sessionBoundary: string): string => fenceUntrusted(ATTACHED_FILE_TAG, { path: part.path }, part.content, sessionBoundary);

export const attachmentText = (part: MessageAttachment, sessionBoundary: string): string => {
  if (part.type === 'attached_file') return attachedFileText(part, sessionBoundary);
  if (part.type === 'forge_issue') return fenceUntrusted(FORGE_ISSUE_TAG, { issue: part.issue }, part.content, sessionBoundary);
  return part.text;
};

export type UserMessageExtras = { attachments?: readonly MessageAttachment[] | undefined };

export const includedShellTexts = (shell: readonly UserShellRecord[] | undefined, sessionBoundary: string): string[] =>
  (shell ?? []).filter((record) => record.include).map((record) => userShellText(record, sessionBoundary));

export const userMessageContent = (text: string, images: readonly ImageAttachment[] | undefined, extras: UserMessageExtras, sessionBoundary: string): ContentPart[] => [
  { type: 'input_text', text },
  ...(extras.attachments ?? []).map((part): ContentPart => ({ type: 'input_text', text: attachmentText(part, sessionBoundary) })),
  ...(images ?? []).map((image): ContentPart => ({ type: 'input_image', image_url: imageDataUrl(image) })),
];
