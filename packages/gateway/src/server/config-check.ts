import { isIP } from 'node:net';
import { isLoopbackHost } from '@momonga/foundation';
import type { FixedModelsOptions, GatewayLimits, GatewayOptions } from '../types.ts';

const MIN_HMAC_KEY_BYTES = 32;

export const isLoopbackAddress = (address: string): boolean => (isIP(address) === 4 && isLoopbackHost(address)) || address === '::1';

const requirePositiveInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`createGateway: ${name} must be a positive integer, got ${value}`);
};

const checkModels = (options: FixedModelsOptions): void => {
  const { config, adapters } = options;
  const { targets, chains } = config.models;
  const configured = Object.keys(targets);
  for (const [name, target] of Object.entries(targets)) {
    if (!Object.hasOwn(adapters, name)) throw new Error(`createGateway: model "${name}" has no adapter`);
    requirePositiveInteger(`maxConcurrency of model "${name}"`, target.maxConcurrency);
    requirePositiveInteger(`admissionTimeoutMs of model "${name}"`, target.admissionTimeoutMs);
  }
  for (const name of [...Object.keys(chains), ...Object.values(chains).flat()]) {
    if (!configured.includes(name)) throw new Error(`createGateway: the fallback order names "${name}", which is not a configured model`);
  }
};

export const limitsOf = (options: GatewayOptions): GatewayLimits => ('epochs' in options ? options.limits : options.config);

export const checkGatewayOptions = (options: GatewayOptions): void => {
  const { debugTcp } = options;
  if (!('epochs' in options)) checkModels(options);
  const config = limitsOf(options);
  requirePositiveInteger('retry.maxAttempts', config.retry.maxAttempts);
  requirePositiveInteger('retry.totalWaitMs', config.retry.totalWaitMs);
  requirePositiveInteger('limits.maxBodyBytes', config.limits.maxBodyBytes);
  requirePositiveInteger('limits.maxIdempotencyFrameBytes', config.limits.maxIdempotencyFrameBytes);
  requirePositiveInteger('limits.readerStallMs', config.limits.readerStallMs);
  requirePositiveInteger('idempotency.ttlMs', config.idempotency.ttlMs);
  requirePositiveInteger('closeGraceMs', config.closeGraceMs);
  requirePositiveInteger('sseKeepAliveMs', config.sseKeepAliveMs);
  requirePositiveInteger('detachedMaxMs', config.detachedMaxMs);
  requirePositiveInteger('websocketConnectionMs', config.websocketConnectionMs);
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
