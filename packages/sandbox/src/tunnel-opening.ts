import net from 'node:net';
import { parseHostEntry } from '@momonga/foundation';


export type TunnelOpening =
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'tls'; readonly name: string | undefined }
  | { readonly kind: 'http'; readonly host: string | undefined }
  | { readonly kind: 'other' };

const INCOMPLETE: TunnelOpening = { kind: 'incomplete' };
const OTHER: TunnelOpening = { kind: 'other' };

const TLS_HANDSHAKE_RECORD = 0x16;
const TLS_CLIENT_HELLO = 0x01;
const TLS_RECORD_HEADER_LENGTH = 5;
const TLS_HANDSHAKE_HEADER_LENGTH = 4;
const TLS_RANDOM_LENGTH = 32;
const TLS_VERSION_LENGTH = 2;
const SERVER_NAME_EXTENSION = 0x0000;
const SERVER_NAME_HOST = 0x00;

const HTTP_HEAD_END = '\r\n\r\n';
const HTTP_LINE_END = '\r\n';
const HTTP_REQUEST_LINE = /^[A-Z]+ \S+ HTTP\/1\.[01]$/;
const HTTP_METHOD_START = /^[A-Z]/;

class Malformed extends Error {}

const reader = (bytes: Buffer) => {
  let offset = 0;
  const take = (count: number): Buffer => {
    if (offset + count > bytes.length) throw new Malformed();
    const taken = bytes.subarray(offset, offset + count);
    offset += count;
    return taken;
  };
  return {
    take,
    u8: (): number => take(1).readUInt8(0),
    u16: (): number => take(2).readUInt16BE(0),
    rest: (): number => bytes.length - offset,
  };
};

const handshakeBytes = (bytes: Buffer): Buffer | undefined => {
  const parts: Buffer[] = [];
  let offset = 0;
  let collected = 0;
  let needed: number | undefined;
  while (needed === undefined || collected < needed) {
    if (offset + TLS_RECORD_HEADER_LENGTH > bytes.length) return undefined;
    if (bytes.readUInt8(offset) !== TLS_HANDSHAKE_RECORD) throw new Malformed();
    const length = bytes.readUInt16BE(offset + 3);
    if (offset + TLS_RECORD_HEADER_LENGTH + length > bytes.length) return undefined;
    const payload = bytes.subarray(offset + TLS_RECORD_HEADER_LENGTH, offset + TLS_RECORD_HEADER_LENGTH + length);
    parts.push(payload);
    collected += payload.length;
    offset += TLS_RECORD_HEADER_LENGTH + length;
    if (needed === undefined && collected >= TLS_HANDSHAKE_HEADER_LENGTH) {
      const joined = Buffer.concat(parts);
      if (joined.readUInt8(0) !== TLS_CLIENT_HELLO) throw new Malformed();
      needed = TLS_HANDSHAKE_HEADER_LENGTH + joined.readUIntBE(1, 3);
    }
  }
  return Buffer.concat(parts).subarray(TLS_HANDSHAKE_HEADER_LENGTH, needed);
};

const serverNameOf = (hello: Buffer): string | undefined => {
  const read = reader(hello);
  read.take(TLS_VERSION_LENGTH + TLS_RANDOM_LENGTH);
  read.take(read.u8());
  read.take(read.u16());
  read.take(read.u8());
  if (read.rest() === 0) return undefined;
  const extensions = reader(read.take(read.u16()));
  while (extensions.rest() > 0) {
    const type = extensions.u16();
    const data = extensions.take(extensions.u16());
    if (type !== SERVER_NAME_EXTENSION) continue;
    const list = reader(data);
    const names = reader(list.take(list.u16()));
    while (names.rest() > 0) {
      const kind = names.u8();
      const name = names.take(names.u16());
      if (kind === SERVER_NAME_HOST) return name.toString('latin1');
    }
    return undefined;
  }
  return undefined;
};

const tlsOpeningOf = (bytes: Buffer): TunnelOpening => {
  try {
    const hello = handshakeBytes(bytes);
    return hello === undefined ? INCOMPLETE : { kind: 'tls', name: serverNameOf(hello) };
  } catch (error) {
    if (error instanceof Malformed) return OTHER;
    throw error;
  }
};

const httpOpeningOf = (bytes: Buffer): TunnelOpening => {
  const text = bytes.toString('latin1');
  const lineEnd = text.indexOf(HTTP_LINE_END);
  if (lineEnd === -1) return INCOMPLETE;
  if (!HTTP_REQUEST_LINE.test(text.slice(0, lineEnd))) return OTHER;
  const headEnd = text.indexOf(HTTP_HEAD_END);
  if (headEnd === -1) return INCOMPLETE;
  const hosts = text
    .slice(lineEnd + HTTP_LINE_END.length, headEnd)
    .split(HTTP_LINE_END)
    .filter((line) => line.slice(0, line.indexOf(':')).trim().toLowerCase() === 'host')
    .map((line) => line.slice(line.indexOf(':') + 1).trim());
  const [host] = hosts;
  return { kind: 'http', host: hosts.length === 1 ? host : undefined };
};

export const tunnelOpeningOf = (bytes: Buffer): TunnelOpening => {
  if (bytes.length === 0) return INCOMPLETE;
  if (bytes.readUInt8(0) === TLS_HANDSHAKE_RECORD) return tlsOpeningOf(bytes);
  if (HTTP_METHOD_START.test(String.fromCharCode(bytes.readUInt8(0)))) return httpOpeningOf(bytes);
  return OTHER;
};

const hostOf = (text: string | undefined): string | undefined => (text === undefined ? undefined : parseHostEntry(text)?.host);

export const tunnelOpeningAdmits = (granted: string, opening: TunnelOpening): boolean => {
  const host = granted.toLowerCase();
  switch (opening.kind) {
    case 'tls':
      if (net.isIP(host) !== 0) return opening.name === undefined;
      return opening.name !== undefined && parseHostEntry(opening.name)?.port === undefined && hostOf(opening.name) === host;
    case 'http':
      return hostOf(opening.host) === host;
    case 'incomplete':
    case 'other':
      return false;
  }
};
