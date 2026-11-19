import { createHash } from 'node:crypto';

const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

export const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (character) => HTML_ESCAPES[character] as string);

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export const decodeEntities = (text: string): string =>
  text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return NAMED_ENTITIES[name] ?? whole;
  });

export const githubSlug = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');

export const githubSlugger = (): ((base: string) => string) => {
  const counts = new Map<string, number>();
  const taken = new Set<string>();
  return (base) => {
    let count = counts.get(base) ?? 0;
    let id = count === 0 ? base : `${base}-${count}`;
    while (taken.has(id)) {
      count += 1;
      id = `${base}-${count}`;
    }
    counts.set(base, count + 1);
    taken.add(id);
    return id;
  };
};

export const contentHash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

export const shownTitle = (sourceTitle: string): string => sourceTitle.replace(/^\d+\.\s+/, '');

export const tokenClass = (token: string): string => `t-${token.replace(/\./g, '-')}`;
