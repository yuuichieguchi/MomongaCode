import { crc32, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GREYSCALE_8_BIT = Buffer.from([8, 0, 0, 0, 0]);

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
};

export const solidPngDataUrl = (side: number): string => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  const rows = Buffer.alloc((side + 1) * side);
  const png = Buffer.concat([
    SIGNATURE,
    chunk('IHDR', Buffer.concat([header, GREYSCALE_8_BIT])),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
};
