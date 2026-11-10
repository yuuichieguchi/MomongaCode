import { Text } from 'ink';
import type { ImageAttachment } from '@momonga/protocol';
import { describeAttachment } from '../../images.ts';
import type { KeyTable } from '../keys/table.ts';

export type Attachment = { file: string; image: ImageAttachment };

export const attachmentLine = (attachment: Attachment, keys: KeyTable): string => {
  const key = keys.keyHint('editor.deleteBefore');
  return `attached ${describeAttachment(attachment.file, attachment.image)}${key === '' ? '' : ` (${key} on an empty input removes the last)`}`;
};

export function AttachmentLines({ attachments, keys }: { attachments: readonly Attachment[]; keys: KeyTable }) {
  return (
    <>
      {attachments.map((attachment, index) => (
        <Text key={index} dimColor wrap="truncate">{attachmentLine(attachment, keys)}</Text>
      ))}
    </>
  );
}
