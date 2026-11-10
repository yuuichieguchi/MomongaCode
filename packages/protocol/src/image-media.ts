import type { ImageMediaType } from './run-types.ts';

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean => signature.every((byte, index) => bytes[offset + index] === byte);

const ASCII = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

export const imageMediaTypeOf = (bytes: Uint8Array): ImageMediaType | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ASCII('GIF87a')) || startsWith(bytes, ASCII('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ASCII('RIFF')) && startsWith(bytes, ASCII('WEBP'), 8)) return 'image/webp';
  return undefined;
};
