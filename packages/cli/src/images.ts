import path from 'node:path';
import { imageMediaTypeOf } from '@momonga/protocol';
import type { ImageAttachment } from '@momonga/protocol';
import type { CliFiles } from './ports.ts';

export class UnsupportedImage extends Error {
  constructor(file: string) {
    super(`${file} is not a PNG, JPEG, GIF or WebP image`);
    this.name = 'UnsupportedImage';
  }
}

export const mediaTypeOf = imageMediaTypeOf;

export const readImageAttachment = async (files: Pick<CliFiles, 'readFile'>, cwd: string, file: string): Promise<ImageAttachment> => {
  const resolved = path.resolve(cwd, file);
  const bytes = await files.readFile(resolved);
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
