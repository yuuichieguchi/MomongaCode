import fs from 'node:fs';
import path from 'node:path';
import type { Token, Tokens } from 'marked';
import { marked, plainText, readDocument, squash } from './markdown.ts';
import type { Block, LinkTarget, SourceDocument } from './markdown.ts';
import { NUMBERED, githubSlug } from './text.ts';

export type SourceSpec = { file: string; group: string; splitDepth: number; keyPrefix: string; home: string };

const SOURCES: readonly SourceSpec[] = [
  { file: 'README.md', group: 'Guide', splitDepth: 2, keyPrefix: 'docs/', home: 'index.html' },
  { file: 'docs/reference.md', group: 'Reference', splitDepth: 2, keyPrefix: 'docs/reference/', home: 'docs/reference/index.html' },
  { file: 'docs/threat-model.md', group: 'Threat model', splitDepth: 1, keyPrefix: 'docs/', home: 'docs/threat-model.html' },
];

export type DocPage = { key: string; url: string; title: string; spec: SourceSpec; document: SourceDocument; heading: Tokens.Heading; blocks: readonly Block[] };

export type SourceSet = { spec: SourceSpec; document: SourceDocument; preamble: readonly Block[]; pages: readonly DocPage[] };

export const urlOfKey = (key: string): string => {
  if (key === 'index.html') return '/';
  if (key.endsWith('/index.html')) return `/${key.slice(0, -'index.html'.length)}`;
  if (!key.endsWith('.html')) throw new Error(`${key} is not a page`);
  return `/${key.slice(0, -'.html'.length)}`;
};

export const readSources = (root: string): SourceSet[] =>
  SOURCES.map((spec) => {
    const document = readDocument(spec.file, fs.readFileSync(path.join(root, spec.file), 'utf8'));
    const preamble: Block[] = [];
    const pages: (DocPage & { blocks: Block[] })[] = [];
    for (const block of document.blocks) {
      const { token } = block;
      if (token.type === 'heading' && token.depth === spec.splitDepth) {
        const title = squash(plainText(spec.file, token.tokens));
        const key = `${spec.keyPrefix}${githubSlug(title.replace(NUMBERED, ''))}.html`;
        pages.push({ key, url: urlOfKey(key), title, spec, document, heading: token, blocks: [block] });
        continue;
      }
      const page = pages.at(-1);
      if (page === undefined) preamble.push(block);
      else page.blocks.push(block);
    }
    if (pages.length === 0) throw new Error(`${spec.file} has no heading of depth ${spec.splitDepth}, so it makes no page`);
    return { spec, document, preamble, pages };
  });

const headingsOf = (document: SourceDocument, blocks: readonly Block[]): string[] => {
  const ids: string[] = [];
  const visit = (tokens: readonly Token[]): void => {
    for (const each of tokens) {
      const token = marked(document.file, each);
      if (token.type === 'heading') {
        const id = document.headingIds.get(token);
        if (id === undefined) throw new Error(`${document.file}: a heading has no id`);
        ids.push(id);
      }
      if (token.type === 'list') visit(token.items.flatMap((item) => item.tokens));
      if (token.type === 'blockquote') visit(token.tokens);
    }
  };
  visit(blocks.map((block) => block.token));
  return ids;
};

export type SiteFacts = { root: string; repo: string; version: string };

export const linkResolver = (sources: readonly SourceSet[], facts: SiteFacts): LinkTarget => {
  const owners = new Map<string, { home: string; pages: Map<string, string> }>();
  for (const source of sources) {
    const pages = new Map<string, string>();
    for (const page of source.pages) for (const id of headingsOf(source.document, page.blocks)) pages.set(id, page.key);
    owners.set(source.spec.file, { home: source.spec.home, pages });
  }
  return (from, href) => {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return href;
    const hash = href.indexOf('#');
    const target = hash === -1 ? href : href.slice(0, hash);
    const anchor = hash === -1 ? undefined : href.slice(hash + 1);
    const file = target === '' ? from : path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
    const owner = owners.get(file);
    if (owner !== undefined) {
      if (anchor === undefined) return urlOfKey(owner.home);
      const key = owner.pages.get(anchor);
      if (key === undefined) throw new Error(`${from}: the link ${href} names #${anchor}, which no page of ${file} has`);
      return `${urlOfKey(key)}#${anchor}`;
    }
    if (file.startsWith('../') || path.posix.isAbsolute(file)) throw new Error(`${from}: the link ${href} leaves the repository`);
    if (!fs.existsSync(path.join(facts.root, file))) throw new Error(`${from}: the link ${href} names ${file}, which does not exist`);
    return `https://github.com/${facts.repo}/blob/v${facts.version}/${file}${anchor === undefined ? '' : `#${anchor}`}`;
  };
};
