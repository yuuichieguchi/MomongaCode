const SIGNATURE = 'DIRC';
const HEADER_BYTES = 12;
const VERSION_OFFSET = 4;
const COUNT_OFFSET = 8;
const MODE_OFFSET = 24;
const OBJECT_NAME_OFFSET = 40;
const OBJECT_NAME_BYTES = 20;
const FLAGS_OFFSET = OBJECT_NAME_OFFSET + OBJECT_NAME_BYTES;
const FIXED_BYTES = FLAGS_OFFSET + 2;
const EXTENDED_FLAG = 0x4000;
const EXTENDED_FLAGS_BYTES = 2;
const NAME_LENGTH_MASK = 0xfff;
const ENTRY_ALIGNMENT = 8;
const FILE_TYPE_MASK = 0o170000;
const GITLINK_TYPE = 0o160000;
const PREFIX_COMPRESSED_VERSION = 4;
const SUPPORTED_VERSIONS: readonly number[] = [2, 3, 4];
const VARINT_CONTINUE = 0x80;
const VARINT_PAYLOAD = 0x7f;
const VARINT_SHIFT = 7;

export type GitlinkRead = { paths: string[] } | { unreadable: true };

const UNREADABLE: GitlinkRead = { unreadable: true };

type Varint = { value: number; next: number };

const readVarint = (data: Buffer, at: number): Varint | undefined => {
  let cursor = at;
  let byte = data[cursor];
  if (byte === undefined) return undefined;
  let value = byte & VARINT_PAYLOAD;
  while ((byte & VARINT_CONTINUE) !== 0) {
    cursor += 1;
    byte = data[cursor];
    if (byte === undefined) return undefined;
    value = ((value + 1) << VARINT_SHIFT) | (byte & VARINT_PAYLOAD);
  }
  return { value, next: cursor + 1 };
};

export const gitlinksOfIndex = (data: Buffer): GitlinkRead => {
  if (data.length < HEADER_BYTES || data.toString('latin1', 0, SIGNATURE.length) !== SIGNATURE) return UNREADABLE;
  const version = data.readUInt32BE(VERSION_OFFSET);
  if (!SUPPORTED_VERSIONS.includes(version)) return UNREADABLE;
  const count = data.readUInt32BE(COUNT_OFFSET);
  const compressed = version === PREFIX_COMPRESSED_VERSION;
  const paths: string[] = [];
  let at = HEADER_BYTES;
  let previous: Uint8Array = Buffer.alloc(0);
  for (let entry = 0; entry < count; entry += 1) {
    if (at + FIXED_BYTES > data.length) return UNREADABLE;
    const mode = data.readUInt32BE(at + MODE_OFFSET);
    const flags = data.readUInt16BE(at + FLAGS_OFFSET);
    let cursor = at + FIXED_BYTES + ((flags & EXTENDED_FLAG) !== 0 && version >= 3 ? EXTENDED_FLAGS_BYTES : 0);
    let name: Uint8Array;
    if (compressed) {
      const strip = readVarint(data, cursor);
      if (strip === undefined || strip.value > previous.length) return UNREADABLE;
      const end = data.indexOf(0, strip.next);
      if (end === -1) return UNREADABLE;
      name = Buffer.concat([previous.subarray(0, previous.length - strip.value), data.subarray(strip.next, end)]);
      cursor = end + 1;
    } else {
      const end = data.indexOf(0, cursor);
      if (end === -1 || ((flags & NAME_LENGTH_MASK) !== NAME_LENGTH_MASK && end - cursor !== (flags & NAME_LENGTH_MASK))) return UNREADABLE;
      name = data.subarray(cursor, end);
      cursor = at + Math.ceil((end + 1 - at) / ENTRY_ALIGNMENT) * ENTRY_ALIGNMENT;
    }
    previous = name;
    at = cursor;
    if ((mode & FILE_TYPE_MASK) !== GITLINK_TYPE) continue;
    const text = Buffer.from(name).toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(name)) return UNREADABLE;
    paths.push(text);
  }
  return { paths };
};
