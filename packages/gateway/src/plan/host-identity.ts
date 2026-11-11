import { createHash, generateKeyPair } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { AUTH_DOCUMENT_MAX_BYTES, isRecord, systemRandom, writeFileAtomically } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { parsePlanJson } from './plan-json.ts';
import { describeError } from './record-io.ts';

export type HostIdentity = { hostId: string };

const HOST_ID_PREFIX = 'urn:ietf:params:oauth:jwk-thumbprint:sha-256:';
const FILE_MODE = 0o600;

const REQUIRED_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  EC: ['crv', 'kty', 'x', 'y'],
  RSA: ['e', 'kty', 'n'],
  OKP: ['crv', 'kty', 'x'],
  oct: ['k', 'kty'],
};

const generateKeyPairAsync = promisify(generateKeyPair);

export const jwkThumbprint = (jwk: Readonly<Record<string, unknown>>): string => {
  const kty = jwk['kty'];
  const members = typeof kty === 'string' && Object.hasOwn(REQUIRED_MEMBERS, kty) ? REQUIRED_MEMBERS[kty] : undefined;
  if (members === undefined) throw new Error(`a JWK thumbprint needs a known kty, got ${JSON.stringify(kty)}`);
  const parts = members.map((name) => {
    const value = jwk[name];
    if (typeof value !== 'string') throw new Error(`a ${String(kty)} JWK needs the string member ${name}`);
    return `${JSON.stringify(name)}:${JSON.stringify(value)}`;
  });
  return createHash('sha256').update(`{${parts.join(',')}}`, 'utf8').digest('base64url');
};

export const hostIdOf = (jwk: Readonly<Record<string, unknown>>): string => `${HOST_ID_PREFIX}${jwkThumbprint(jwk)}`;

const newHostFile = async (): Promise<{ hostId: string; text: string }> => {
  const { privateKey } = await generateKeyPairAsync('ec', { namedCurve: 'P-256' });
  const jwk: JsonWebKey = privateKey.export({ format: 'jwk' });
  const hostId = hostIdOf(jwk);
  return { hostId, text: JSON.stringify({ hostId, privateKey: jwk }) };
};

const hostFileError = (file: string, problem: string): Error => new Error(`the plan host identity file ${file} ${problem}; run \`momonga auth reset-host\` to create a new host identity`);

const readHostFile = async (fileSystem: FileSystem, file: string): Promise<string | undefined> => {
  try {
    return await fileSystem.readOwnerOnlyTextFile(file, 'it', AUTH_DOCUMENT_MAX_BYTES);
  } catch (error) {
    throw hostFileError(file, `cannot be read (${describeError(error)})`);
  }
};

const parseHostFile = (file: string, text: string): HostIdentity => {
  const parsed = parsePlanJson(text, (problem) => hostFileError(file, problem));
  if (!isRecord(parsed) || typeof parsed['hostId'] !== 'string' || !isRecord(parsed['privateKey'])) throw hostFileError(file, 'has an unrecognised shape');
  const key = parsed['privateKey'];
  if (key['kty'] !== 'EC' || key['crv'] !== 'P-256' || typeof key['d'] !== 'string') throw hostFileError(file, 'does not hold an EC P-256 private key');
  if (hostIdOf(key) !== parsed['hostId']) throw hostFileError(file, 'holds a host ID that does not match its key');
  return { hostId: parsed['hostId'] };
};

export const ensureHostIdentity = async (fileSystem: FileSystem, file: string, { accountsExist }: { accountsExist: boolean }): Promise<HostIdentity> => {
  const existing = await readHostFile(fileSystem, file);
  if (existing !== undefined) return parseHostFile(file, existing);
  if (accountsExist) throw hostFileError(file, 'is missing while plan accounts exist');
  await fileSystem.mkdirPrivate(path.dirname(file));
  const created = await newHostFile();
  const outcome = await writeFileAtomically(fileSystem, systemRandom, file, created.text, { mode: FILE_MODE, publish: 'create' });
  if (outcome.created) return { hostId: created.hostId };
  const raced = await readHostFile(fileSystem, file);
  if (raced === undefined) throw hostFileError(file, 'disappeared while it was being created');
  return parseHostFile(file, raced);
};

export const resetHostIdentity = async (fileSystem: FileSystem, file: string): Promise<HostIdentity> => {
  await fileSystem.mkdirPrivate(path.dirname(file));
  const created = await newHostFile();
  await writeFileAtomically(fileSystem, systemRandom, file, created.text, { mode: FILE_MODE });
  return { hostId: created.hostId };
};
