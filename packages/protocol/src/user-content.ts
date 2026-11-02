import type { ContentPart } from './open-responses.ts';
import type { ImageAttachment } from './run-types.ts';

export const imageDataUrl = (image: ImageAttachment): string => `data:${image.mediaType};base64,${image.data}`;

export const userMessageContent = (text: string, images: readonly ImageAttachment[] | undefined): ContentPart[] => [
  { type: 'input_text', text },
  ...(images ?? []).map((image): ContentPart => ({ type: 'input_image', image_url: imageDataUrl(image) })),
];
