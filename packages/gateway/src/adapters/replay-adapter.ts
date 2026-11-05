import fs from 'node:fs';
import nodePath from 'node:path';
import { canonicalJson, modeIsPrivate, sha256Hex } from '@momonga/foundation';
import { TERMINAL_STREAM_EVENT_TYPES } from '@momonga/protocol';
import type {
  AdapterContext,
  AdapterRequest,
  Capabilities,
  ClassifiedError,
  ProviderAdapter,
  StreamEvent,
} from '@momonga/protocol';

import { createStoredDataChecks } from '../core/validation.ts';

const RECORD_FILE_MODE = 0o600;
const RECORD_DIRECTORY_MODE = 0o700;

export type ReplayAdapterOptions = {
  path: string;
  mode: 'record' | 'strict';
  inner?: ProviderAdapter;
  capabilities?: Capabilities;
};

type ReplayEntry = { digest: string; events: StreamEvent[] };

class ReplayMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayMismatchError';
  }
}

const digestOf = (request: AdapterRequest): string => sha256Hex(canonicalJson(request));

const parseEntry = (line: string, path: string, lineNumber: number): ReplayEntry => {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null) throw new TypeError(`${path}:${lineNumber} is not a JSON object`);
  const { digest, events } = parsed as Record<string, unknown>;
  if (typeof digest !== 'string' || !Array.isArray(events)) {
    throw new TypeError(`${path}:${lineNumber} lacks a digest string and an events array`);
  }
  const problem = createStoredDataChecks().streamEvents(events);
  if (problem !== undefined) throw new TypeError(`${path}:${lineNumber} has invalid recorded events: ${problem}`);
  return { digest, events: events as StreamEvent[] };
};

const ensureRecordingDirectory = (file: string): void => {
  const directory = nodePath.dirname(file);
  if (!fs.existsSync(directory)) {
    const parent = nodePath.dirname(directory);
    if (!fs.existsSync(parent)) throw new Error(`parent directory ${parent} of the recording directory ${directory} does not exist`);
    fs.mkdirSync(directory, { mode: RECORD_DIRECTORY_MODE });
    fs.chmodSync(directory, RECORD_DIRECTORY_MODE);
    return;
  }
  const stat = fs.statSync(directory);
  if (!modeIsPrivate(stat, 'directory')) {
    throw new Error(`recording directory ${directory} has mode ${(stat.mode & 0o777).toString(8)} but must be 0700; run: chmod 700 ${directory}`);
  }
};

const loadEntries = (path: string): ReplayEntry[] => {
  if (!fs.existsSync(path)) throw new Error(`replay recording ${path} does not exist`);
  return fs
    .readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line, index) => parseEntry(line, path, index + 1));
};

const appendEntry = (path: string, entry: ReplayEntry & { request: AdapterRequest }): void => {
  const descriptor = fs.openSync(path, 'a', RECORD_FILE_MODE);
  try {
    fs.writeSync(descriptor, `${canonicalJson(entry)}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
};

export const createReplayAdapter = (options: ReplayAdapterOptions): ProviderAdapter => {
  const { path, mode, inner } = options;
  if (mode === 'record' && inner === undefined) {
    throw new TypeError('createReplayAdapter: record mode requires an inner adapter to record from');
  }
  if (mode === 'record') ensureRecordingDirectory(path);
  const entries = mode === 'strict' ? loadEntries(path) : [];
  let cursor = 0;

  async function* record(source: ProviderAdapter, request: AdapterRequest, ctx: AdapterContext): AsyncGenerator<StreamEvent> {
    const events: StreamEvent[] = [];
    for await (const event of source.create(request, ctx)) {
      events.push(event);
      if ((TERMINAL_STREAM_EVENT_TYPES as readonly string[]).includes(event.type)) {
        appendEntry(path, { digest: digestOf(request), request, events });
      }
      yield event;
    }
  }

  async function* replay(request: AdapterRequest): AsyncGenerator<StreamEvent> {
    const entry = entries[cursor];
    const digest = digestOf(request);
    if (entry === undefined) {
      throw new ReplayMismatchError(`replay recording ${path} is exhausted after ${entries.length} entries; request digest ${digest} has no recorded response`);
    }
    if (entry.digest !== digest) {
      throw new ReplayMismatchError(`replay entry ${cursor + 1} of ${path} expects request digest ${entry.digest} but the request has digest ${digest}`);
    }
    cursor += 1;
    yield* entry.events;
  }

  return {
    kind: 'replay',
    capabilities: async (target) => {
      if (inner !== undefined) return inner.capabilities(target);
      if (options.capabilities === undefined) throw new TypeError('createReplayAdapter: strict mode without an inner adapter needs a capabilities option to answer capabilities()');
      return options.capabilities;
    },
    create: (request, ctx) => (inner !== undefined && mode === 'record' ? record(inner, request, ctx) : replay(request)),
    classify: (error): ClassifiedError => {
      if (error instanceof ReplayMismatchError) {
        return { retryable: false, error: { type: 'model_error', code: 'replay_mismatch', message: error.message, param: null } };
      }
      if (inner !== undefined) return inner.classify(error);
      return {
        retryable: false,
        error: { type: 'model_error', code: 'replay_error', message: error instanceof Error ? error.message : String(error), param: null },
      };
    },
  };
};
