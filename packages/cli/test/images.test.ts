import { describe, expect, it } from 'vitest';
import { UnsupportedImage, describeAttachment, mediaTypeOf, pastedImagePaths, readImageAttachment } from '../src/images.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0]);
const GIF = Uint8Array.from(Buffer.from('GIF89a....'));
const WEBP = Uint8Array.from(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '));

describe('mediaTypeOf', () => {
  it('recognises the supported formats by their signature and not by a file name', () => {
    expect([PNG, JPEG, GIF, WEBP].map(mediaTypeOf)).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    expect(mediaTypeOf(Uint8Array.from(Buffer.from('plain text')))).toBeUndefined();
  });
});

describe('readImageAttachment', () => {
  it('resolves the path against the working directory and returns the base64 payload with the sniffed media type', async () => {
    const asked: string[] = [];
    const files = {
      readBytes: async (file: string) => {
        asked.push(file);
        return PNG;
      },
    };
    const attachment = await readImageAttachment(files, '/work', 'shots/a.png');
    expect(asked).toEqual(['/work/shots/a.png']);
    expect(attachment).toEqual({ mediaType: 'image/png', data: Buffer.from(PNG).toString('base64') });
    expect(describeAttachment('shots/a.png', attachment)).toBe('a.png (image/png, 11 bytes)');
  });

  it('refuses a file that is not an image even when its name says so', async () => {
    const files = { readBytes: async () => Uint8Array.from(Buffer.from('not an image')) };
    await expect(readImageAttachment(files, '/work', 'fake.png')).rejects.toBeInstanceOf(UnsupportedImage);
  });

  it('propagates a read failure', async () => {
    const failure = new Error('ENOENT');
    const files = {
      readBytes: async (): Promise<Uint8Array> => {
        throw failure;
      },
    };
    await expect(readImageAttachment(files, '/work', 'a.png')).rejects.toBe(failure);
  });
});

describe('pastedImagePaths', () => {
  it('reads a dropped path in the quoted and backslash-escaped forms terminals produce', () => {
    expect(pastedImagePaths('/tmp/a.png')).toEqual(['/tmp/a.png']);
    expect(pastedImagePaths("'/tmp/my shot.PNG'\n")).toEqual(['/tmp/my shot.PNG']);
    expect(pastedImagePaths('/tmp/my\\ shot.jpg')).toEqual(['/tmp/my shot.jpg']);
    expect(pastedImagePaths('/tmp/a.png\n/tmp/b.webp\n')).toEqual(['/tmp/a.png', '/tmp/b.webp']);
  });

  it('leaves any other paste to the editor', () => {
    expect(pastedImagePaths('hello')).toBeUndefined();
    expect(pastedImagePaths('/tmp/a.png and more')).toBeUndefined();
    expect(pastedImagePaths('/tmp/a.png\nnotes')).toBeUndefined();
    expect(pastedImagePaths('')).toBeUndefined();
  });
});
