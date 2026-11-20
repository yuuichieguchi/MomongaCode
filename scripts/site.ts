import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { readEmbeddedReleaseRepo } from './release-key.ts';
import { INSTALLERS, INSTALLER_CONTENT_TYPE, SITE_ORIGIN, SITE_OUTPUT } from './site-target.ts';
import { iconFigure, landingFigure } from './site/figure.ts';
import { docsLayout, groupHeading, hasGroupList, page } from './site/layout.ts';
import type { Assets, Chrome } from './site/layout.ts';
import { codeBlock, marked, plainText, renderBlocks, sourceText, squash } from './site/markdown.ts';
import type { Block } from './site/markdown.ts';
import { assertDistinctAddresses, linkResolver, readSources, urlOfKey } from './site/pages.ts';
import type { DocPage, SiteFacts, SourceSet } from './site/pages.ts';
import { iconCss, themeCss } from './site/style.ts';
import { firstSentence, joinLastWords, joinLastWordsOfTokens, sentenceHtml } from './site/sentence.ts';
import type { Segment } from './site/sentence.ts';
import { contentHash, escapeHtml, shownTitle } from './site/text.ts';

const FOOTER_SECTIONS = ['Contributing', 'License', 'Disclaimer'] as const;

const readVersion = (root: string): string => {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, 'packages/cli/package.json'), 'utf8'));
  const version = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'version') : undefined;
  if (typeof version !== 'string' || version === '') throw new Error('packages/cli/package.json has no version');
  return version;
};

const bundleClient = async (root: string): Promise<string> => {
  const result = await build({
    entryPoints: [path.join(root, 'site/client/main.ts')],
    absWorkingDir: root,
    tsconfig: path.join(root, 'site/tsconfig.json'),
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    logLevel: 'error',
  });
  const [output, ...rest] = result.outputFiles;
  if (output === undefined || rest.length > 0) throw new Error(`the site script bundle produced ${result.outputFiles.length} files, expected 1`);
  return output.text;
};

const hashed = (name: string, extension: string, content: string): { key: string; content: string } => ({ key: `assets/${name}.${contentHash(content)}.${extension}`, content });

const sectionOf = (source: SourceSet, number: number): DocPage => {
  const found = source.pages.find((each) => squash(plainText(source.spec.file, each.heading.tokens)).startsWith(`${number}. `));
  if (found === undefined) throw new Error(`${source.spec.file} has no section ${number}`);
  return found;
};

const assertUniqueIds = (key: string, html: string): void => {
  const seen = new Set<string>();
  for (const match of html.matchAll(/\sid="([^"]*)"/g)) {
    const id = match[1] as string;
    if (seen.has(id)) throw new Error(`${key} has the id ${id} twice`);
    seen.add(id);
  }
};

const installBlock = (): string => {
  const idOf = (file: string): string => file.replace(/\./g, '-');
  const tabs = INSTALLERS.map(
    (installer, index) =>
      `<button type="button" role="tab" id="${idOf(installer.file)}-tab" aria-controls="${idOf(installer.file)}-panel" aria-selected="${index === 0}" data-ui>${escapeHtml(installer.tab)}</button>`,
  );
  const panels = INSTALLERS.map(
    (installer) =>
      `<div class="install-panel" role="tabpanel" id="${idOf(installer.file)}-panel" aria-labelledby="${idOf(installer.file)}-tab"><p class="install-label" data-ui>${escapeHtml(installer.tab)}</p>${sourceText(codeBlock(installer.command, installer.language))}</div>`,
  );
  return ['<div class="install">', `<div class="tabs" role="tablist" hidden data-needs-script>${tabs.join('')}</div>`, ...panels, '</div>'].join('\n');
};

type Card = { href: string; title: string; sentence: readonly Segment[] };

const cardHtml = (card: Card): string =>
  `<a class="card" href="${escapeHtml(card.href)}"><h3 class="card-title" data-source>${escapeHtml(card.title)}</h3><p class="card-text" data-source>${sentenceHtml(joinLastWords(card.sentence))}</p></a>`;

const tileHtml = (href: string, title: string): string => `<a class="tile" href="${escapeHtml(href)}"><span class="tile-title" data-source>${escapeHtml(title)}</span></a>`;

const featureLeads = (source: SourceSet, features: DocPage): string[] =>
  features.blocks.flatMap(({ token }) => {
    if (token.type !== 'list') return [];
    return token.items.map((item) => {
      const [first] = item.tokens;
      const block = first === undefined ? undefined : marked(source.spec.file, first);
      if (block === undefined || (block.type !== 'text' && block.type !== 'paragraph') || block.tokens === undefined) throw new Error(`${source.spec.file}: a feature item has no text`);
      const [lead] = block.tokens;
      const strong = lead === undefined ? undefined : marked(source.spec.file, lead);
      if (strong?.type !== 'strong') throw new Error(`${source.spec.file}: a feature item has no bold lead`);
      return squash(plainText(source.spec.file, strong.tokens)).replace(/\.$/, '');
    });
  });

const areaCards = (source: SourceSet, why: DocPage): Card[] =>
  why.blocks.flatMap(({ token }, index) => {
    if (token.type !== 'heading' || token.depth !== 3) return [];
    const id = source.document.headingIds.get(token);
    const paragraph = why.blocks.slice(index + 1).find((block) => block.token.type !== 'space')?.token;
    if (id === undefined || paragraph?.type !== 'paragraph') throw new Error(`${source.spec.file}: the area ${token.text} has no id or no paragraph under it`);
    return [{ href: `${why.url}#${id}`, title: squash(plainText(source.spec.file, token.tokens)), sentence: firstSentence(source.spec.file, paragraph.tokens) }];
  });

const sectionHeading = (source: SourceSet, section: DocPage): string => {
  const heading = section.blocks.find((block) => block.token.type === 'heading')?.token;
  if (heading?.type !== 'heading') throw new Error(`${source.spec.file}: the section ${section.title} has no heading`);
  return `<h2 data-source>${escapeHtml(shownTitle(squash(plainText(source.spec.file, heading.tokens))))}</h2>`;
};

const introOf = (source: SourceSet, section: DocPage): string => {
  const paragraph = section.blocks.find((block) => block.token.type === 'paragraph')?.token;
  if (paragraph?.type !== 'paragraph') throw new Error(`${source.spec.file}: the section ${section.title} has no paragraph`);
  return `<p class="landing-intro" data-source>${sentenceHtml(joinLastWords(firstSentence(source.spec.file, paragraph.tokens)))}</p>`;
};

type Front = { title: Block; lead: Block; name: string; description: string };

const frontOf = (guide: SourceSet): Front => {
  const title = guide.preamble.find((block) => block.token.type === 'heading');
  const lead = guide.preamble.find((block) => block.token.type === 'paragraph');
  if (title?.token.type !== 'heading' || lead?.token.type !== 'paragraph') throw new Error(`${guide.spec.file} has no title and first paragraph before its first section`);
  return { title, lead, name: squash(plainText(guide.spec.file, title.token.tokens)), description: squash(plainText(guide.spec.file, lead.token.tokens)) };
};

const heroStage = (): string =>
  [
    '<div class="hero-stage" data-stage>',
    '<div class="stage-bar" aria-hidden="true"><span class="stage-dots"><span class="stage-dot stage-dot-close"></span><span class="stage-dot stage-dot-min"></span><span class="stage-dot stage-dot-max"></span></span><span class="stage-live"></span></div>',
    `<div class="stage-body"><div class="stage-bob">${landingFigure()}</div></div>`,
    '<div class="stage-prompt" aria-hidden="true"><span class="stage-cursor"></span></div>',
    '</div>',
  ].join('\n');

const pageDescription = (doc: DocPage, fallback: string): string => {
  const paragraph = doc.blocks.find((block) => block.token.type === 'paragraph')?.token;
  return paragraph?.type === 'paragraph' ? squash(plainText(doc.spec.file, paragraph.tokens)) : fallback;
};

const landing = (chrome: Chrome, guide: SourceSet, front: Front, facts: SiteFacts, link: ReturnType<typeof linkResolver>): string => {
  const { title, lead } = front;
  const installation = sectionOf(guide, 1);
  const lastCode = installation.blocks.findLastIndex((block) => block.token.type === 'code');
  if (lastCode === -1) throw new Error(`${guide.spec.file} section 1 has no install command`);
  const after: Block[] = installation.blocks.slice(lastCode + 1);
  const why = sectionOf(guide, 2);
  const features = sectionOf(guide, 4);
  const joined = (block: Block): Block => (block.token.type === 'paragraph' ? { ...block, token: { ...block.token, tokens: joinLastWordsOfTokens(guide.spec.file, block.token.tokens) } } : block);
  const rendered = (blocks: readonly Block[]): string => sourceText(renderBlocks(guide.document, blocks, link, 1, '/').html);
  const release = `https://github.com/${facts.repo}/releases/tag/v${facts.version}`;
  const body = [
    '<main id="content" class="landing">',
    '<section class="hero">',
    heroStage(),
    rendered([title, joined(lead)]),
    `<p class="version"><a href="${escapeHtml(release)}" data-ui>v${escapeHtml(facts.version)}</a></p>`,
    installBlock(),
    rendered(after.map(joined)),
    '</section>',
    `<section class="landing-section">${sectionHeading(guide, why)}${introOf(guide, why)}<div class="cards">${areaCards(guide, why)
      .map((card) => cardHtml(card))
      .join('')}</div></section>`,
    `<section class="landing-section">${sectionHeading(guide, features)}<div class="tiles">${featureLeads(guide, features)
      .map((lead) => tileHtml(features.url, lead))
      .join('')}</div></section>`,
    '</main>',
  ].join('\n');
  return page(chrome, {
    title: front.name,
    body,
    menu: false,
    className: 'page-landing',
    meta: { canonical: `${SITE_ORIGIN}/`, ogTitle: front.name, description: front.description, type: 'website' },
  });
};

const indexHeading = (heading: string): string => `<h1 data-ui>${escapeHtml(heading)}</h1>`;

const titleList = (pages: readonly DocPage[]): string => `<ul class="index-list">${pages.map((each) => `<li><a href="${escapeHtml(each.url)}" data-source>${escapeHtml(each.title)}</a></li>`).join('')}</ul>`;

const sitemap = (urls: readonly string[]): string =>
  ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls.map((url) => `<url><loc>${escapeHtml(`${SITE_ORIGIN}${url}`)}</loc></url>`), '</urlset>', ''].join('\n');

export const llmsLinkText = (title: string): string => title.replace(/[[\]\\]/g, (character) => `\\${character}`);

const llms = (name: string, description: string, sources: readonly SourceSet[]): string =>
  [
    `# ${name}`,
    '',
    `> ${description}`,
    '',
    `- [${llmsLinkText(name)}](${SITE_ORIGIN}/)`,
    `- [Docs](${SITE_ORIGIN}/docs/)`,
    ...sources.flatMap((source) => [
      '',
      `## ${source.spec.group}`,
      '',
      ...(source.spec.home.endsWith('/index.html') ? [`- [${llmsLinkText(source.spec.group)}](${SITE_ORIGIN}${urlOfKey(source.spec.home)})`] : []),
      ...source.pages.map((each) => `- [${llmsLinkText(each.title)}](${SITE_ORIGIN}${each.url})`),
    ]),
    '',
  ].join('\n');

const HEADERS = (installers: readonly string[]): string =>
  [...installers.flatMap((file) => [`/${file}`, `  Content-Type: ${INSTALLER_CONTENT_TYPE}`]), '/assets/*', '  Cache-Control: public, max-age=31536000, immutable', ''].join('\n');

export const buildSite = async (root: string): Promise<ReadonlyMap<string, Uint8Array>> => {
  const facts: SiteFacts = { root, repo: readEmbeddedReleaseRepo(root), version: readVersion(root) };
  const sources = readSources(root);
  const link = linkResolver(sources, facts);
  const guide = sources.find((source) => source.spec.home === 'index.html');
  if (guide === undefined) throw new Error('no source is the landing page');
  const reference = sources.find((source) => source.spec.home === 'docs/reference/index.html');
  if (reference === undefined) throw new Error('no source is the reference');
  assertDistinctAddresses(sources, [
    { key: 'index.html', name: 'the landing page' },
    { key: 'docs/index.html', name: 'the docs index' },
    { key: reference.spec.home, name: 'the reference index' },
    { key: '404.html', name: 'the page not found' },
  ]);
  const docPages = sources.flatMap((source) => source.pages);
  const footer = FOOTER_SECTIONS.map((label) => {
    const found = docPages.filter((each) => each.title === label);
    if (found.length !== 1) throw new Error(`the footer link ${label} names ${found.length} pages`);
    return { label, url: (found[0] as DocPage).url };
  });

  const front = frontOf(guide);
  const rendered = new Map(docPages.map((each) => [each, renderBlocks(each.document, each.blocks, link, each.spec.splitDepth, each.url)]));
  const css = hashed('site', 'css', `${themeCss()}\n${fs.readFileSync(path.join(root, 'site/styles/site.css'), 'utf8')}`);
  const js = hashed('site', 'js', await bundleClient(root));
  const index = hashed('search-index', 'json', JSON.stringify([...rendered.values()].flatMap((each) => each.records)));
  const ogBytes = fs.readFileSync(path.join(root, 'site/assets/og.png'));
  const og = { key: `assets/og.${contentHash(ogBytes)}.png`, bytes: ogBytes };
  const assets: Assets = { css: `/${css.key}`, js: `/${js.key}`, searchIndex: `/${index.key}`, ogImage: `/${og.key}` };
  const chrome: Chrome = { origin: SITE_ORIGIN, siteName: front.name, assets, repo: facts.repo, sources, footer };

  const pages = new Map<string, string>();
  pages.set('index.html', landing(chrome, guide, front, facts, link));
  pages.set(
    'docs/index.html',
    page(chrome, {
      title: 'Docs',
      body: docsLayout(chrome, '/docs/', [indexHeading('Docs'), ...sources.map((source) => (hasGroupList(source) ? `${groupHeading(source)}\n${titleList(source.pages)}` : groupHeading(source)))].join('\n'), []),
      menu: true,
      className: 'page-docs',
      meta: { canonical: `${SITE_ORIGIN}/docs/`, ogTitle: `Docs — ${front.name}`, description: front.description, type: 'website' },
    }),
  );
  const referenceUrl = urlOfKey(reference.spec.home);
  pages.set(
    reference.spec.home,
    page(chrome, {
      title: reference.spec.group,
      body: docsLayout(chrome, referenceUrl, `${indexHeading(reference.spec.group)}\n${titleList(reference.pages)}`, []),
      menu: true,
      className: 'page-docs',
      meta: { canonical: `${SITE_ORIGIN}${referenceUrl}`, ogTitle: `${reference.spec.group} — ${front.name}`, description: front.description, type: 'website' },
    }),
  );
  for (const [each, result] of rendered)
    pages.set(
      each.key,
      page(chrome, {
        title: each.title,
        body: docsLayout(chrome, each.url, sourceText(result.html), result.toc),
        menu: true,
        className: 'page-docs',
        meta: { canonical: `${SITE_ORIGIN}${each.url}`, ogTitle: `${each.title} — ${front.name}`, description: pageDescription(each, front.description), type: 'article' },
      }),
    );
  pages.set('404.html', page(chrome, { title: 'Page not found', body: '<main id="content" class="not-found"><h1 data-ui>Page not found</h1><p><a href="/docs/" data-ui>Docs</a> <a href="/" data-ui>MomongaCode</a></p></main>', menu: false, className: 'page-not-found' }));
  for (const [key, html] of pages) assertUniqueIds(key, html);

  const listed = [...pages.keys()].filter((key) => key !== '404.html').map(urlOfKey);

  const files = new Map<string, Uint8Array>();
  const text = (key: string, content: string): void => {
    files.set(key, Buffer.from(content, 'utf8'));
  };
  for (const [key, html] of pages) text(key, html);
  for (const installer of INSTALLERS) files.set(installer.file, fs.readFileSync(path.join(root, installer.source)));
  text('favicon.svg', iconFigure(iconCss()));
  text(css.key, css.content);
  text(js.key, js.content);
  text(index.key, index.content);
  files.set(og.key, og.bytes);
  text('_headers', HEADERS(INSTALLERS.map((installer) => installer.file)));
  text('sitemap.xml', sitemap(listed));
  text('llms.txt', llms(front.name, front.description, sources));
  text('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`);
  return files;
};

export const siteOutput = (args: readonly string[], root: string): string | undefined => {
  if (args.length === 0) return path.join(root, SITE_OUTPUT);
  const [flag, output] = args;
  if (args.length !== 2 || flag !== '--output' || output === undefined || output === '') return undefined;
  return path.resolve(output);
};

const isRepositoryOutput = (output: string, root: string): boolean => {
  const own = path.join(root, SITE_OUTPUT);
  return path.resolve(output) === own || (fs.existsSync(output) && fs.existsSync(own) && fs.realpathSync(output) === fs.realpathSync(own));
};

export const writeSite = (files: ReadonlyMap<string, Uint8Array>, output: string, root: string): void => {
  if (isRepositoryOutput(output, root)) fs.rmSync(output, { recursive: true, force: true });
  else if (fs.existsSync(output) && fs.readdirSync(output).length > 0)
    throw new Error(`site.ts: the output directory ${output} is not empty; name an absent or empty directory, or build into ${path.join(root, SITE_OUTPUT)}`);
  for (const [key, bytes] of files) {
    const file = path.join(output, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, '..');
  const output = siteOutput(process.argv.slice(2), root);
  if (output === undefined) {
    process.stderr.write('usage: node scripts/site.ts [--output <directory>]\n');
    process.exit(2);
  }
  writeSite(await buildSite(root), output, root);
}
