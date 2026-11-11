import type { ContentPart } from './open-responses.ts';
import type { AttachedFilePart, ImageAttachment, MessageAttachment, UserShellRecord } from './run-types.ts';

export const imageDataUrl = (image: ImageAttachment): string => `data:${image.mediaType};base64,${image.data}`;

export const userShellText = (record: Pick<UserShellRecord, 'command' | 'exitCode' | 'output'>): string =>
  `<user_shell_command><command>${record.command}</command><exit_code>${record.exitCode === null ? '' : record.exitCode}</exit_code><output>${record.output}</output></user_shell_command>`;

export const attachedFileText = (part: AttachedFilePart): string => `<attached_file path=${JSON.stringify(part.path)}>\n${part.content}\n</attached_file>`;

export const attachmentText = (part: MessageAttachment): string => (part.type === 'attached_file' ? attachedFileText(part) : part.text);

export type UserMessageExtras = { attachments?: readonly MessageAttachment[] | undefined };

export const includedShellTexts = (shell: readonly UserShellRecord[] | undefined): string[] => (shell ?? []).filter((record) => record.include).map(userShellText);

export const userMessageContent = (text: string, images: readonly ImageAttachment[] | undefined, extras: UserMessageExtras = {}): ContentPart[] => [
  { type: 'input_text', text },
  ...(extras.attachments ?? []).map((part): ContentPart => ({ type: 'input_text', text: attachmentText(part) })),
  ...(images ?? []).map((image): ContentPart => ({ type: 'input_image', image_url: imageDataUrl(image) })),
];
