import { Box, Text } from 'ink';
import type { ImageAttachment } from '@momonga/protocol';
import { describeAttachment } from '../../images.ts';
import type { PastedSpan } from '../editor.ts';
import type { KeyTable } from '../keys/table.ts';
import { ChoiceRow } from '../select.tsx';

export type Attachment = { file: string; image: ImageAttachment; label?: string };

export const heldAttachments = (attachments: readonly Attachment[], spans: readonly PastedSpan[]): Attachment[] => attachments.filter((attachment) => attachment.label === undefined || spans.some((span) => span.label === attachment.label));

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

export function AtList({ labels, index }: { labels: readonly string[]; index: number }) {
  return (
    <Box flexDirection="column">
      {labels.map((label, at) => (
        <ChoiceRow key={label} selected={at === index} label={label} />
      ))}
    </Box>
  );
}
