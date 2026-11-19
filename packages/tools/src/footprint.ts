import path from 'node:path';
import type { PermissionSubject } from '@momonga/policy';

export type Footprint = { reads: readonly string[]; writes: readonly string[] };

export const EVERY_LOCAL_PATH = 'local:*';

const LOCAL_PREFIX = 'local:';

export const EVERYTHING = '*';

export const EMPTY_FOOTPRINT: Footprint = { reads: [], writes: [] };

const UNNAMED_FOOTPRINT: Footprint = { reads: [EVERYTHING], writes: [EVERYTHING] };

export const isUnnamed = (footprint: Footprint): boolean => footprint.writes.includes(EVERYTHING);

const localOf = (cwd: string, target: string): string => `${LOCAL_PREFIX}${path.resolve(cwd, target)}`;

const refOf = (place: string, ref: string): string => `ref:${place}:${ref}`;

export const footprintOf = (subject: PermissionSubject, cwd: string): Footprint => {
  switch (subject.kind) {
    case 'path': {
      const paths = subject.paths.map((target) => localOf(cwd, target));
      return subject.access === 'read' ? { reads: paths, writes: [] } : { reads: [], writes: paths };
    }
    case 'command':
      return { reads: [EVERY_LOCAL_PATH], writes: [EVERY_LOCAL_PATH] };
    case 'repo': {
      if (subject.remote === null) return { reads: [EVERY_LOCAL_PATH], writes: [EVERY_LOCAL_PATH] };
      const places = subject.destinations.length === 0 ? [subject.remote] : subject.destinations;
      return { reads: [EVERY_LOCAL_PATH], writes: places.flatMap((place) => subject.refs.map((ref) => refOf(place, ref))) };
    }
    case 'forge':
      return { reads: [], writes: [`pr:${subject.host}/${subject.repo}#${subject.pr === undefined ? 'new' : String(subject.pr)}`] };
    case 'mcp':
      return UNNAMED_FOOTPRINT;
    case 'memory':
    case 'history':
    case 'governance':
    case 'agent':
    case 'none':
      return EMPTY_FOOTPRINT;
  }
};

const isLocal = (resource: string): boolean => resource.startsWith(LOCAL_PREFIX);

const within = (outer: string, inner: string): boolean => inner === outer || inner.startsWith(`${outer}${path.sep}`);

const touches = (left: string, right: string): boolean => {
  if (left === right || left === EVERYTHING || right === EVERYTHING) return true;
  if (!isLocal(left) || !isLocal(right)) return false;
  if (left === EVERY_LOCAL_PATH || right === EVERY_LOCAL_PATH) return true;
  const first = left.slice(LOCAL_PREFIX.length);
  const second = right.slice(LOCAL_PREFIX.length);
  return within(first, second) || within(second, first);
};

const meets = (writes: readonly string[], others: readonly string[]): boolean => writes.some((written) => others.some((other) => touches(written, other)));

export const footprintsConflict = (left: Footprint, right: Footprint): boolean =>
  meets(left.writes, [...right.reads, ...right.writes]) || meets(right.writes, [...left.reads, ...left.writes]);

export type HeldFootprint = { callId: string; footprint: Footprint };

export const blockerOf = (footprint: Footprint, held: readonly HeldFootprint[]): HeldFootprint | undefined => held.find((entry) => footprintsConflict(footprint, entry.footprint));

export const blockedByHeldText = (callId: string, footprint: Footprint): string =>
  `Not run: blocked by the held call ${callId} (${isUnnamed(footprint) ? 'the effects of this call cannot be named, so it may touch what that call changes' : 'same path or ref'}), which waits for a person to approve it. Do not repeat this call until that one has been decided; continue with work that does not depend on it.`;
