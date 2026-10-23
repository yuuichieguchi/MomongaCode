import { isLoopbackHost } from '@momonga/foundation';
import type { GatewayOptions } from '../types.ts';

const MIN_HMAC_KEY_BYTES = 32;
const NON_LITERAL_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '[::1]']);

export const isLoopbackAddress = (address: string): boolean => isLoopbackHost(address) && !NON_LITERAL_LOOPBACK_HOSTS.has(address);

const requirePositiveInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`createGateway: ${name} must be a positive integer, got ${value}`);
};

export const checkGatewayOptions = (options: GatewayOptions): void => {
  const { config, adapters, debugTcp } = options;
  const targetNames = Object.keys(config.models.targets);
  for (const [name, target] of Object.entries(config.models.targets)) {
    if (!Object.hasOwn(adapters, name)) {
      throw new Error(`createGateway: target "${name}" has no adapter keyed by its name`);
    }
    requirePositiveInteger(`models.targets.${name}.maxConcurrency`, target.maxConcurrency);
    requirePositiveInteger(`models.targets.${name}.admissionTimeoutMs`, target.admissionTimeoutMs);
  }
  for (const [alias, names] of Object.entries(config.models.aliases)) {
    if (names.length === 0) throw new Error(`createGateway: alias "${alias}" lists no targets`);
    for (const name of names) {
      if (!targetNames.includes(name)) throw new Error(`createGateway: alias "${alias}" references unknown target "${name}"`);
    }
  }
  requirePositiveInteger('retry.maxAttempts', config.retry.maxAttempts);
  requirePositiveInteger('limits.maxBodyBytes', config.limits.maxBodyBytes);
  requirePositiveInteger('limits.maxIdempotencyFrameBytes', config.limits.maxIdempotencyFrameBytes);
  requirePositiveInteger('limits.idempotencyReaderStallMs', config.limits.idempotencyReaderStallMs);
  requirePositiveInteger('idempotency.ttlMs', config.idempotency.ttlMs);
  requirePositiveInteger('closeGraceMs', config.closeGraceMs);
  requirePositiveInteger('sseKeepAliveMs', config.sseKeepAliveMs);
  requirePositiveInteger('detachedMaxMs', config.detachedMaxMs);
  if (options.hmacKey.length < MIN_HMAC_KEY_BYTES) {
    throw new Error(`createGateway: hmacKey must be at least ${MIN_HMAC_KEY_BYTES} bytes, got ${options.hmacKey.length}`);
  }
  if (debugTcp !== undefined) {
    if (!isLoopbackAddress(debugTcp.host)) {
      throw new Error(`createGateway: debugTcp host "${debugTcp.host}" is not a loopback address; use 127.0.0.1 or ::1`);
    }
    if (debugTcp.token === '') throw new Error('createGateway: debugTcp token must not be empty');
  }
};
