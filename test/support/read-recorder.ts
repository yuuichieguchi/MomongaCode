import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export type Holder = Record<string | symbol, unknown>;
export type Call = (...args: unknown[]) => unknown;

export const RECORDING = Symbol.for('momonga.reuseRecorder');

const pathOf = (value: unknown): string | undefined => {
  if (typeof value === 'string') return path.resolve(value);
  if (value instanceof URL) return value.protocol === 'file:' ? fileURLToPath(value) : undefined;
  if (Buffer.isBuffer(value)) return path.resolve(value.toString('utf8'));
  return undefined;
};

export const keepingProperties = (replacement: Call, original: Call): void => {
  for (const key of Reflect.ownKeys(original)) {
    if (key === 'length' || key === 'name' || key === 'prototype' || key === promisify.custom) continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (descriptor !== undefined) Object.defineProperty(replacement, key, descriptor);
  }
  Object.defineProperty(replacement, RECORDING, { value: true });
};

export const recordReads = (onRead: (file: string) => void): void => {
  const reading = (holder: Holder, name: string | symbol, arguments_: number): void => {
    const original = holder[name] as (Call & { [RECORDING]?: true }) | undefined;
    if (original === undefined || original[RECORDING] === true) return;
    const replacement = function recordingRead(this: unknown, ...args: unknown[]): unknown {
      for (const arg of args.slice(0, arguments_)) {
        const file = pathOf(arg);
        if (file !== undefined) onRead(file);
      }
      return original.apply(this, args);
    };
    keepingProperties(replacement, original);
    const promised = (original as unknown as Holder)[promisify.custom] as Call | undefined;
    if (promised !== undefined) {
      Object.defineProperty(replacement, promisify.custom, {
        value: function recordingPromisedRead(this: unknown, ...args: unknown[]): unknown {
          for (const arg of args.slice(0, arguments_)) {
            const file = pathOf(arg);
            if (file !== undefined) onRead(file);
          }
          return promised.apply(this, args);
        },
      });
    }
    Object.defineProperty(holder, name, { value: replacement, writable: true, configurable: true, enumerable: Object.getOwnPropertyDescriptor(holder, name)?.enumerable === true });
  };

  const FILE_READS = ['readFileSync', 'readFile', 'openSync', 'open', 'readdirSync', 'readdir', 'statSync', 'stat', 'lstatSync', 'lstat', 'existsSync', 'exists', 'accessSync', 'access', 'createReadStream', 'realpathSync', 'realpath', 'opendirSync', 'opendir', 'readlinkSync', 'readlink', 'globSync', 'glob'];
  const PROMISED_READS = ['readFile', 'open', 'readdir', 'stat', 'lstat', 'access', 'realpath', 'opendir', 'readlink', 'glob'];
  for (const name of FILE_READS) reading(fs as unknown as Holder, name, 1);
  for (const name of PROMISED_READS) reading(fs.promises as unknown as Holder, name, 1);
  reading(fs.realpathSync as unknown as Holder, 'native', 1);
  reading(fs.realpath as unknown as Holder, 'native', 1);
  reading(fs as unknown as Holder, 'copyFileSync', 1);
  reading(fs as unknown as Holder, 'cpSync', 1);
  reading(fs.promises as unknown as Holder, 'copyFile', 1);
  reading(fs.promises as unknown as Holder, 'cp', 1);

  registerHooks({
    load: (url, context, nextLoad) => {
      if (url.startsWith('file:')) onRead(fileURLToPath(url));
      return nextLoad(url, context);
    },
  });
};
