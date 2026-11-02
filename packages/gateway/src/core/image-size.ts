const HEADER_BYTES = 65_536;
const BASE64_CHARS_PER_BYTE = 4 / 3;

export type ImageDimensions = { width: number; height: number };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const JPEG_STANDALONE_MARKERS = new Set([0x01, 0xd8, ...Array.from({ length: 8 }, (_, index) => 0xd0 + index)]);

const pngDimensions = (bytes: Buffer): ImageDimensions | undefined =>
  bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : undefined;

const gifDimensions = (bytes: Buffer): ImageDimensions | undefined =>
  bytes.length >= 10 && bytes.subarray(0, 4).toString('latin1') === 'GIF8' ? { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) } : undefined;

const jpegDimensions = (bytes: Buffer): ImageDimensions | undefined => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] as number;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (JPEG_STANDALONE_MARKERS.has(marker)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (JPEG_START_OF_FRAME.has(marker)) {
      return offset + 9 <= bytes.length ? { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) } : undefined;
    }
    offset += 2 + length;
  }
  return undefined;
};

const webpDimensions = (bytes: Buffer): ImageDimensions | undefined => {
  if (bytes.length < 30 || bytes.subarray(0, 4).toString('latin1') !== 'RIFF' || bytes.subarray(8, 12).toString('latin1') !== 'WEBP') return undefined;
  const chunk = bytes.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  return undefined;
};

export const dimensionsOfBase64 = (data: string): ImageDimensions | undefined => {
  const bytes = Buffer.from(data.slice(0, Math.ceil(HEADER_BYTES * BASE64_CHARS_PER_BYTE)), 'base64');
  const found = pngDimensions(bytes) ?? gifDimensions(bytes) ?? jpegDimensions(bytes) ?? webpDimensions(bytes);
  return found === undefined || found.width === 0 || found.height === 0 ? undefined : found;
};
