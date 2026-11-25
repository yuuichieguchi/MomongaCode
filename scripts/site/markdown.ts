import { lexer } from 'marked';
import type { MarkedToken, Token, Tokens } from 'marked';
import { highlightCode } from '../../packages/cli/src/tui/screen/highlight.ts';
import type { SearchRecord } from '../../site/client/search.ts';
import { decodeEntities, escapeHtml, githubSlug, githubSlugger, shownTitle, tokenClass } from './text.ts';

export type Block = { token: MarkedToken; line: number };

export type SourceDocument = { file: string; blocks: readonly Block[]; headingIds: ReadonlyMap<Tokens.Heading, string>; sourceAnchors: ReadonlyMap<string, string>; rowIds: ReadonlyMap<readonly Tokens.TableCell[], string> };

const MARKED_TYPES: ReadonlySet<string> = new Set(['blockquote', 'br', 'checkbox', 'code', 'codespan', 'def', 'del', 'em', 'escape', 'heading', 'hr', 'html', 'image', 'link', 'list', 'list_item', 'paragraph', 'space', 'strong', 'table', 'text']);

const isMarked = (token: Token): token is MarkedToken => MARKED_TYPES.has(token.type);

export const marked = (file: string, token: Token): MarkedToken => {
  if (!isMarked(token)) throw new Error(`${file}: the markdown token ${token.type} is not built into the site`);
  return token;
};

const childrenOf = (token: MarkedToken): Token[] => {
  switch (token.type) {
    case 'list':
      return token.items;
    case 'table':
      return [...token.header, ...token.rows.flat()].flatMap((cell) => cell.tokens);
    default:
      return 'tokens' in token && token.tokens !== undefined ? token.tokens : [];
  }
};

const eachToken = (file: string, tokens: readonly Token[], visit: (token: MarkedToken) => void): void => {
  for (const each of tokens) {
    const token = marked(file, each);
    visit(token);
    eachToken(file, childrenOf(token), visit);
  }
};

export const plainText = (file: string, tokens: readonly Token[]): string =>
  tokens
    .map((each) => {
      const token = marked(file, each);
      switch (token.type) {
        case 'text':
          return token.tokens === undefined ? decodeEntities(token.text) : plainText(file, token.tokens);
        case 'escape':
        case 'codespan':
          return token.text;
        case 'br':
          return ' ';
        case 'link':
        case 'strong':
        case 'em':
        case 'del':
          return plainText(file, token.tokens);
        case 'image':
          return decodeEntities(token.text);
        default:
          throw new Error(`${file}: the inline token ${token.type} has no text in the site`);
      }
    })
    .join('');

export const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const readDocument = (file: string, markdown: string): SourceDocument => {
  const blocks: Block[] = [];
  let cursor = 0;
  for (const each of lexer(markdown)) {
    const token = marked(file, each);
    const at = markdown.indexOf(token.raw, cursor);
    if (at === -1) throw new Error(`${file}: the markdown block ${JSON.stringify(token.raw.slice(0, 40))} was not found in the file`);
    const line = markdown.slice(0, at).split('\n').length;
    cursor = at + token.raw.length;
    blocks.push({ token, line });
    eachToken(file, [token], (inner) => {
      if (inner.type !== 'html') return;
      const offset = token.raw.indexOf(inner.raw);
      throw new Error(`${file}:${line + token.raw.slice(0, Math.max(0, offset)).split('\n').length - 1}: raw HTML is not built into the site: ${inner.raw.trim()}`);
    });
  }
  const slug = githubSlugger();
  const sourceSlug = githubSlugger();
  const tokens = blocks.map((block) => block.token);
  const headingIds = new Map<Tokens.Heading, string>();
  const sourceAnchors = new Map<string, string>();
  eachToken(file, tokens, (token) => {
    if (token.type !== 'heading') return;
    const sourceTitle = squash(plainText(file, token.tokens));
    const id = slug(githubSlug(shownTitle(sourceTitle)));
    headingIds.set(token, id);
    sourceAnchors.set(sourceSlug(githubSlug(sourceTitle)), id);
  });
  const rowIds = new Map<readonly Tokens.TableCell[], string>();
  let heading: string | undefined;
  eachToken(file, tokens, (token) => {
    if (token.type === 'heading') heading = headingIds.get(token);
    if (token.type !== 'table') return;
    if (heading === undefined) throw new Error(`${file}: a table stands before any heading`);
    for (const row of token.rows) {
      const first = row[0];
      if (first === undefined) throw new Error(`${file}: a table row has no cell`);
      rowIds.set(row, slug(`${heading}-${githubSlug(squash(plainText(file, first.tokens)))}`));
    }
  });
  return { file, blocks, headingIds, sourceAnchors, rowIds };
};

export type LinkTarget = (from: string, href: string) => string;

export type TocEntry = { id: string; title: string };

export type RenderedPage = { html: string; toc: readonly TocEntry[]; records: readonly SearchRecord[] };

type RenderState = { document: SourceDocument; link: LinkTarget; topDepth: number; url: string; toc: TocEntry[]; records: SearchRecord[]; section: SearchRecord | undefined };

export const sourceText = (html: string): string => `<div data-source>${html}</div>`;

const highlighted = (code: string, language: string): string => {
  const spans = highlightCode(code, language);
  if (spans === undefined) return escapeHtml(code);
  let html = '';
  let position = 0;
  for (const [start, end, tokens] of spans) {
    html += escapeHtml(code.slice(position, start));
    html += `<span class="${tokens.map(tokenClass).join(' ')}">${escapeHtml(code.slice(start, end))}</span>`;
    position = end;
  }
  return html + escapeHtml(code.slice(position));
};

const COPY_ICON =
  '<svg class="copy-icon copy-icon-idle" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M3.5 11H3a1.5 1.5 0 0 1-1.5-1.5V3A1.5 1.5 0 0 1 3 1.5h6.5A1.5 1.5 0 0 1 11 3v.5"/></svg>';
const COPIED_ICON =
  '<svg class="copy-icon copy-icon-done" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';

export const codeBlock = (code: string, language: string): string =>
  `<div class="code-block"><pre><code${language === '' ? '' : ` class="language-${escapeHtml(language)}"`}>${highlighted(code, language)}</code></pre><button type="button" class="copy" data-copy hidden data-ui>${COPY_ICON}${COPIED_ICON}<span class="sr-only">Copy</span></button><span class="sr-only" role="status" aria-live="polite" data-copy-status></span></div>`;

const imageHtml = (state: RenderState, token: Tokens.Image, block: boolean): string => {
  const href = decodeEntities(token.href);
  const src = state.link(state.document.file, href);
  if (!src.startsWith('/assets/')) throw new Error(`${state.document.file}: the image ${href} must resolve to a file in site/assets/`);
  const alt = escapeHtml(decodeEntities(token.text));
  const title = token.title !== null && token.title !== '' ? decodeEntities(token.title) : undefined;
  if (block) {
    const caption = title === undefined ? '' : `<figcaption>${escapeHtml(title)}</figcaption>`;
    return `<figure class="screenshot-frame"><img class="screenshot" src="${escapeHtml(src)}" alt="${alt}" loading="lazy" decoding="async">${caption}</figure>`;
  }
  const titleAttr = title === undefined ? '' : ` title="${escapeHtml(title)}"`;
  return `<img class="screenshot" src="${escapeHtml(src)}" alt="${alt}" loading="lazy" decoding="async"${titleAttr}>`;
};

const inline = (state: RenderState, tokens: readonly Token[]): string =>
  tokens
    .map((each) => {
      const token = marked(state.document.file, each);
      switch (token.type) {
        case 'text':
          return token.tokens === undefined ? escapeHtml(decodeEntities(token.text)) : inline(state, token.tokens);
        case 'escape':
          return escapeHtml(token.text);
        case 'codespan':
          return `<code>${escapeHtml(token.text)}</code>`;
        case 'strong':
          return `<strong>${inline(state, token.tokens)}</strong>`;
        case 'em':
          return `<em>${inline(state, token.tokens)}</em>`;
        case 'del':
          return `<del>${inline(state, token.tokens)}</del>`;
        case 'br':
          return '<br>';
        case 'link':
          return `<a href="${escapeHtml(state.link(state.document.file, token.autolink === true ? token.href : decodeEntities(token.href)))}">${inline(state, token.tokens)}</a>`;
        case 'image':
          return imageHtml(state, token, false);
        default:
          throw new Error(`${state.document.file}: the inline token ${token.type} is not built into the site`);
      }
    })
    .join('');

const record = (state: RenderState, id: string, title: string, text: string): SearchRecord => {
  const added = { url: `${state.url}#${id}`, title, text };
  state.records.push(added);
  return added;
};

const addText = (state: RenderState, text: string): void => {
  if (state.section === undefined) return;
  state.section.text = squash(`${state.section.text} ${text}`);
};

const tableHtml = (state: RenderState, token: Tokens.Table): string => {
  const align = (cell: Tokens.TableCell): string => (cell.align === null ? '' : ` class="align-${cell.align}"`);
  const head = `<thead><tr>${token.header.map((cell) => `<th${align(cell)}>${inline(state, cell.tokens)}</th>`).join('')}</tr></thead>`;
  const rows = token.rows.map((row) => {
    const first = row[0];
    const id = state.document.rowIds.get(row);
    if (first === undefined || id === undefined) throw new Error(`${state.document.file}: a table row has no id`);
    const title = squash(plainText(state.document.file, first.tokens));
    record(state, id, title, squash(row.slice(1).map((cell) => plainText(state.document.file, cell.tokens)).join(' ')));
    return `<tr id="${escapeHtml(id)}">${row.map((cell) => `<td${align(cell)}>${inline(state, cell.tokens)}</td>`).join('')}</tr>`;
  });
  return `<div class="table-wrap"><table>${head}<tbody>${rows.join('')}</tbody></table></div>`;
};

const blocksHtml = (state: RenderState, tokens: readonly Token[], tight: boolean): string =>
  tokens
    .map((each) => {
      const token = marked(state.document.file, each);
      switch (token.type) {
        case 'space':
        case 'def':
          return '';
        case 'heading': {
          const id = state.document.headingIds.get(token);
          if (id === undefined) throw new Error(`${state.document.file}: a heading has no id`);
          const title = shownTitle(squash(plainText(state.document.file, token.tokens)));
          state.section = record(state, id, title, '');
          const level = Math.min(6, token.depth - state.topDepth + 1);
          if (level === 2) state.toc.push({ id, title });
          return `<h${level} id="${escapeHtml(id)}">${shownTitle(inline(state, token.tokens))}</h${level}>`;
        }
        case 'paragraph': {
          addText(state, plainText(state.document.file, token.tokens));
          const meaningful = token.tokens.filter((child) => !(child.type === 'text' && child.text.trim() === ''));
          if (!tight && meaningful.length === 1 && meaningful[0]?.type === 'image') {
            return imageHtml(state, meaningful[0] as Tokens.Image, true);
          }
          return tight ? inline(state, token.tokens) : `<p>${inline(state, token.tokens)}</p>`;
        }
        case 'text':
          addText(state, token.tokens === undefined ? decodeEntities(token.text) : plainText(state.document.file, token.tokens));
          return token.tokens === undefined ? escapeHtml(decodeEntities(token.text)) : inline(state, token.tokens);
        case 'code':
          addText(state, token.text);
          return codeBlock(token.text, token.lang ?? '');
        case 'blockquote':
          return `<blockquote>${blocksHtml(state, token.tokens, false)}</blockquote>`;
        case 'hr':
          return '<hr>';
        case 'list': {
          const tag = token.ordered ? 'ol' : 'ul';
          const start = token.ordered && token.start !== '' && token.start !== 1 ? ` start="${token.start}"` : '';
          const items = token.items.map((item) => {
            if (item.task) throw new Error(`${state.document.file}: a task list item is not built into the site`);
            return `<li>${blocksHtml(state, item.tokens, !item.loose)}</li>`;
          });
          return `<${tag}${start}>${items.join('')}</${tag}>`;
        }
        case 'table':
          return tableHtml(state, token);
        default:
          throw new Error(`${state.document.file}: the block token ${token.type} is not built into the site`);
      }
    })
    .join(tight ? ' ' : '\n');

export const renderBlocks = (document: SourceDocument, blocks: readonly Block[], link: LinkTarget, topDepth: number, url: string): RenderedPage => {
  const state: RenderState = { document, link, topDepth, url, toc: [], records: [], section: undefined };
  const html = blocksHtml(
    state,
    blocks.map((block) => block.token),
    false,
  );
  return { html, toc: state.toc, records: state.records };
};
