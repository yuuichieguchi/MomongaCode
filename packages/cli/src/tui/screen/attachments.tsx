import { Text } from 'ink';
import type { ImageAttachment } from '@momonga/protocol';
import { describeAttachment } from '../../images.ts';

export type Attachment = { file: string; image: ImageAttachment };

export function AttachmentLines({ attachments }: { attachments: readonly Attachment[] }) {
  return (
    <>
      {attachments.map((attachment, index) => (
        <Text key={index} dimColor wrap="truncate">{`attached ${describeAttachment(attachment.file, attachment.image)} (backspace on an empty input removes the last)`}</Text>
      ))}
    </>
  );
}
