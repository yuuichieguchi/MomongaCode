import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sessionRootsOf } from '@momonga/foundation';
import type { FileSystem, PathResolver } from '@momonga/foundation';
import type { Link, Span } from './wrap.ts';

export type FileLinks = ReadonlyMap<string, string>;

export const NO_FILE_LINKS: FileLinks = new Map();

export const FILE_LINK_CANDIDATES_MAX = 64;

export const FILE_LINK_NAME_MAX = 1024;

const POSITION = /:\d+(?::\d+)?$/;
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const TOKEN = /\S+/g;
const CODE_SPAN = /(`+)([^`\n]+?)\1(?!`)/g;
const LEADING = /^[("'[{<*_`]+/;
const TRAILING = /[)"'\]}>*_`.,;:!?]+$/;
const ESCAPED_CONTROL = /\\u[0-9A-Fa-f]{4}/;

const named = (text: string): string | undefined => {
  const trimmed = text.trim();
  return trimmed === '' || trimmed.length > FILE_LINK_NAME_MAX || CONTROL.test(trimmed) || ESCAPED_CONTROL.test(trimmed) ? undefined : trimmed;
};

const tokenName = (token: string): { offset: number; text: string } | undefined => {
  const lead = LEADING.exec(token)?.[0].length ?? 0;
  const rest = token.slice(lead);
  const text = rest.slice(0, rest.length - (TRAILING.exec(rest)?.[0].length ?? 0));
  return named(text) === undefined ? undefined : { offset: lead, text };
};

export const fileLinkCandidates = (text: string): string[] => {
  const found = new Set<string>();
  for (const match of text.matchAll(CODE_SPAN)) {
    const name = named(match[2] ?? '');
    if (name !== undefined) found.add(name);
  }
  for (const match of text.matchAll(TOKEN)) {
    const name = tokenName(match[0]);
    if (name !== undefined) found.add(name.text);
  }
  return [...found].slice(0, FILE_LINK_CANDIDATES_MAX);
};

const overlaps = (links: readonly Link[], start: number, end: number): boolean => links.some(([from, to]) => from < end && to > start);

export const fileLinksIn = (text: string, files: FileLinks, codeSpans: readonly Span[], taken: readonly Link[]): Link[] => {
  if (files.size === 0) return [];
  const links: Link[] = [];
  const add = (start: number, end: number, written: string): void => {
    const url = files.get(written);
    if (url !== undefined && !overlaps(taken, start, end) && !overlaps(links, start, end)) links.push([start, end, url, 'file']);
  };
  for (const [start, end] of codeSpans) {
    const raw = text.slice(start, end);
    const name = named(raw);
    if (name !== undefined) add(start + raw.indexOf(name), start + raw.indexOf(name) + name.length, name);
  }
  for (const match of text.matchAll(TOKEN)) {
    const name = tokenName(match[0]);
    if (name !== undefined) add(match.index + name.offset, match.index + name.offset + name.text.length, name.text);
  }
  return links;
};

export type FileLinkPlace = { cwd: string; home: string; additionalDirectories: readonly string[] };

export type FileLinkPorts = { paths: Pick<PathResolver, 'realPath' | 'comparableContains' | 'canonicalDirectory' | 'comparablePath'>; files: Pick<FileSystem, 'stat'> };

export type FileLinkVerdict = { kind: 'file'; url: URL } | { kind: 'missing' } | { kind: 'refused' };

const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);
const REFUSED_CODES: ReadonlySet<string> = new Set(['ELOOP', 'EACCES', 'EPERM', 'ENAMETOOLONG']);

const codeOf = (error: unknown): string | undefined => (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined);

const verdictOfFailure = (error: unknown): FileLinkVerdict => {
  const code = codeOf(error);
  if (code !== undefined && MISSING_CODES.has(code)) return { kind: 'missing' };
  if (code !== undefined && REFUSED_CODES.has(code)) return { kind: 'refused' };
  throw error;
};

const absoluteOf = (name: string, place: FileLinkPlace): string => {
  if (name === '~') return place.home;
  if (name.startsWith('~/')) return path.join(place.home, name.slice(2));
  return path.resolve(place.cwd, name);
};

export type FileLinkRoots = { place: FileLinkPlace; roots: readonly string[] };

export const fileLinkRootsOf = async (place: FileLinkPlace, ports: FileLinkPorts): Promise<FileLinkRoots> => {
  const resolved = await sessionRootsOf(place.cwd, place.additionalDirectories, ports.paths);
  if (!resolved.ok) throw new Error(`the folder ${resolved.root} of this session could not be resolved: ${resolved.reason}`);
  return { place, roots: resolved.roots };
};

export const fileLinkOf = async (written: string, { place, roots }: FileLinkRoots, ports: FileLinkPorts): Promise<FileLinkVerdict> => {
  const name = named(written);
  if (name === undefined || name !== written) return { kind: 'refused' };
  const absolute = absoluteOf(name.replace(POSITION, ''), place);
  try {
    const real = await ports.paths.realPath(absolute);
    if (!(await ports.files.stat(real)).isFile()) return { kind: 'refused' };
    for (const root of roots) if (await ports.paths.comparableContains(root, real)) return { kind: 'file', url: pathToFileURL(real) };
    return { kind: 'refused' };
  } catch (error) {
    return verdictOfFailure(error);
  }
};

export const resolveFileLinks = async (candidates: readonly string[], roots: FileLinkRoots, ports: FileLinkPorts): Promise<FileLinks> => {
  const links = new Map<string, string>();
  for (const candidate of candidates.slice(0, FILE_LINK_CANDIDATES_MAX)) {
    const verdict = await fileLinkOf(candidate, roots, ports);
    if (verdict.kind === 'file') links.set(candidate, verdict.url.href);
  }
  return links;
};

export const isFileUrl = (url: URL): boolean => url.protocol === 'file:' && url.host === '';

export const pathOfFileUrl = (url: URL): string => fileURLToPath(url);

export type OpenFileUrl = (url: URL, watch: AbortSignal, onFailure: (message: string) => void, kind: 'file') => void;

export const fileNoLongerExists = (file: string): string => `${file} no longer exists`;

export const fileOutsideFolders = (file: string): string => `${file} is not a file inside this session's folders`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const openedFileLink = async (url: URL, roots: () => Promise<FileLinkRoots>, ports: FileLinkPorts, open: OpenFileUrl, watch: AbortSignal, onFailure: (message: string) => void): Promise<void> => {
  const file = pathOfFileUrl(url);
  const verdict = await fileLinkOf(file, await roots(), ports);
  if (watch.aborted) return;
  if (verdict.kind === 'missing') onFailure(fileNoLongerExists(file));
  else if (verdict.kind === 'refused') onFailure(fileOutsideFolders(file));
  else open(verdict.url, watch, onFailure, 'file');
};

export const openFileLink = (url: URL, roots: () => Promise<FileLinkRoots>, ports: FileLinkPorts, open: OpenFileUrl, watch: AbortSignal, onFailure: (message: string) => void): void => {
  if (!isFileUrl(url)) {
    onFailure(`${url.href} is not a file link`);
    return;
  }
  void openedFileLink(url, roots, ports, open, watch, onFailure).catch((error: unknown) => {
    if (!watch.aborted) onFailure(messageOf(error));
  });
};
