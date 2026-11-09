import { X509Certificate, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

const length = (size: number): Buffer => {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};

const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);

const oid = (dotted: string): Buffer => {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const group: number[] = [arc & 0x7f];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) group.unshift(0x80 | (value & 0x7f));
    bytes.push(...group);
  }
  return tlv(0x06, Buffer.from(bytes));
};

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const COMMON_NAME = '2.5.4.3';
const BASIC_CONSTRAINTS = '2.5.29.19';
const KEY_USAGE = '2.5.29.15';
const SUBJECT_ALT_NAME = '2.5.29.17';
const NOT_BEFORE = '000101000000Z';
const NOT_AFTER = '491231235959Z';

const name = (commonName: string): Buffer => sequence(tlv(0x31, sequence(oid(COMMON_NAME), tlv(0x0c, Buffer.from(commonName, 'utf8')))));

const extension = (id: string, critical: boolean, value: Buffer): Buffer =>
  sequence(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));

const pem = (der: Buffer): string => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;

const certificate = (subject: string, issuer: string, subjectKey: KeyObject, issuerKey: KeyObject, extensions: Buffer[]): string => {
  const algorithm = sequence(oid(ECDSA_WITH_SHA256));
  const serial = Buffer.concat([Buffer.from([0x01]), randomBytes(8)]);
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))),
    tlv(0x02, serial),
    algorithm,
    name(issuer),
    sequence(tlv(0x17, Buffer.from(NOT_BEFORE)), tlv(0x17, Buffer.from(NOT_AFTER))),
    name(subject),
    subjectKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, sequence(...extensions)),
  );
  const signature = sign('sha256', tbs, issuerKey);
  return pem(sequence(tbs, algorithm, tlv(0x03, Buffer.from([0x00]), signature)));
};

export type MintedServer = { readonly caPem: string; readonly certPem: string; readonly keyPem: string };

export const mintServerCertificate = (host: string): MintedServer => {
  const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const leaf = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caName = 'MomongaCode test CA';
  const caPem = certificate(caName, caName, ca.publicKey, ca.privateKey, [
    extension(BASIC_CONSTRAINTS, true, sequence(tlv(0x01, Buffer.from([0xff])))),
    extension(KEY_USAGE, true, tlv(0x03, Buffer.from([0x01, 0x06]))),
  ]);
  const certPem = certificate(host, caName, leaf.publicKey, ca.privateKey, [
    extension(BASIC_CONSTRAINTS, true, sequence()),
    extension(SUBJECT_ALT_NAME, false, sequence(tlv(0x82, Buffer.from(host, 'ascii')))),
  ]);
  if (!new X509Certificate(certPem).verify(new X509Certificate(caPem).publicKey)) throw new Error('the minted certificate does not verify against its CA');
  return { caPem, certPem, keyPem: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
};
