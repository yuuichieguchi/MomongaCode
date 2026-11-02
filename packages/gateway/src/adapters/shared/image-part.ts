import type { AdapterInputItem, Capabilities, ContentPart, InputImagePart } from '@momonga/protocol';
import { inputHasImages } from '../../core/input.ts';
import { UnsupportedInputError } from './failures.ts';

export type ImageSource = { kind: 'base64'; mediaType: string; data: string } | { kind: 'url'; url: string };

const DATA_URL = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/s;
const REMOTE_URL = /^https?:\/\//i;

export const isImagePart = (part: ContentPart): part is InputImagePart => part.type === 'input_image';

export const hasImagePart = (content: string | readonly ContentPart[]): boolean => typeof content !== 'string' && content.some(isImagePart);

export const imageUrlOf = (part: InputImagePart): string => {
  if (part.image_url === undefined || part.image_url === null || part.image_url === '') {
    throw new UnsupportedInputError('invalid_image', 'input_image requires a non-empty image_url', 'input');
  }
  return part.image_url;
};

export const imageSourceOf = (part: InputImagePart): ImageSource => {
  const url = imageUrlOf(part);
  const data = DATA_URL.exec(url);
  if (data !== null) return { kind: 'base64', mediaType: data[1] as string, data: data[2] as string };
  if (REMOTE_URL.test(url)) return { kind: 'url', url };
  throw new UnsupportedInputError('invalid_image', 'input_image image_url must be an http(s) URL or a base64 data: URL', 'input');
};

export const assertImageInputSupported = (input: readonly AdapterInputItem[], capabilities: Pick<Capabilities, 'imageInput'>): void => {
  if (!capabilities.imageInput && inputHasImages(input)) {
    throw new UnsupportedInputError('capability_unsupported', 'this target does not support image input', 'input');
  }
};
