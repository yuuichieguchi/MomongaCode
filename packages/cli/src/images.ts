import path from 'node:path';
import type { ImageAttachment, ImageMediaType } from '@momonga/protocol';
import type { CliFiles } from './ports.ts';

export class UnsupportedImage extends Error {
  constructor(file: string) {
    super(`${file} is not a PNG, JPEG, GIF or WebP image`);
    this.name = 'UnsupportedImage';
  }
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean => signature.every((byte, index) => bytes[offset + index] === byte);

const ASCII = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

export const mediaTypeOf = (bytes: Uint8Array): ImageMediaType | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ASCII('GIF87a')) || startsWith(bytes, ASCII('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ASCII('RIFF')) && startsWith(bytes, ASCII('WEBP'), 8)) return 'image/webp';
  return undefined;
};

export const readImageAttachment = async (files: Pick<CliFiles, 'readBytes'>, cwd: string, file: string): Promise<ImageAttachment> => {
  const resolved = path.resolve(cwd, file);
  const bytes = await files.readBytes(resolved);
  const mediaType = mediaTypeOf(bytes);
  if (mediaType === undefined) throw new UnsupportedImage(resolved);
  return { mediaType, data: Buffer.from(bytes).toString('base64') };
};

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;

const SURROUNDING_QUOTES = /^(['"])(.*)\1$/;

const BACKSLASH_ESCAPE = /\\(.)/g;

const normalized = (line: string): string => {
  const trimmed = line.trim();
  const unquoted = SURROUNDING_QUOTES.exec(trimmed)?.[2] ?? trimmed;
  return unquoted.replace(BACKSLASH_ESCAPE, '$1');
};

export const pastedImagePaths = (pasted: string): string[] | undefined => {
  const lines = pasted.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return undefined;
  const paths = lines.map(normalized);
  return paths.every((candidate) => IMAGE_EXTENSION.test(candidate)) ? paths : undefined;
};

export const describeAttachment = (file: string, image: ImageAttachment): string => {
  const bytes = Buffer.from(image.data, 'base64').length;
  return `${path.basename(file)} (${image.mediaType}, ${bytes} bytes)`;
};
