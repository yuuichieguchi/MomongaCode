import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempDir } from '@momonga/testkit';
import { repoRoot } from '../scripts/bundle.ts';
import { readEmbeddedReleaseRepo } from '../scripts/release-key.ts';
import { createTempRoot, removeTempRoot } from '../scripts/support/temp.ts';
import { buildSite, llmsLinkText, siteOutput, writeSite } from '../scripts/site.ts';
import { INSTALLERS, SITE_ORIGIN, SITE_PROJECT } from '../scripts/site-target.ts';
import type { SearchRecord } from '../site/client/search.ts';
import { ART_WIDTH, FIGURE, TAIL_WAG_FRAMES, TAIL_WAG_MS } from '../packages/cli/src/tui/figure.ts';
import { STYLE } from '../packages/cli/src/tui/screen/theme.ts';

const VERSION = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/cli/package.json'), 'utf8')) as { version: string }).version;
const REPO = readEmbeddedReleaseRepo(repoRoot);
const SOURCE_FILES = ['README.md', 'docs/reference.md', 'docs/threat-model.md'] as const;
type SourceFile = (typeof SOURCE_FILES)[number];
const sourceOf = (file: SourceFile): string => fs.readFileSync(path.join(repoRoot, file), 'utf8');

const INTERFACE_STRINGS = [
  'MomongaCode',
  'Docs',
  'GitHub',
  'macOS and Linux',
  'Windows, in PowerShell',
  'Copy',
  'Copied',
  'Auto',
  'Light',
  'Dark',
  'Search',
  'No results',
  'Guide',
  'Reference',
  'Threat model',
  'On this page',
  `v${VERSION}`,
  'Contributing',
  'License',
  'Disclaimer',
  'Page not found',
  'Skip to content',
  'Menu',
];

const SERVED_BESIDE_PAGES = ['install.sh', 'install.ps1', '_headers', '404.html', 'llms.txt', 'sitemap.xml', 'robots.txt', 'favicon.svg'];

type Cell = { glyph: string; token: string };
const FUR = 'banner.fur';
const MEMBRANE = 'banner.membrane';
const FACE = 'banner.face';
const MASK_TOKENS: Record<string, string> = { f: FUR, m: MEMBRANE, c: FACE };
const rowOf = (text: string, mask: string): Map<number, Cell> => {
  const glyphs = [...text];
  const marks = [...mask];
  const cells = new Map<number, Cell>();
  glyphs.forEach((glyph, column) => {
    const mark = marks[column] as string;
    if (mark !== ' ') cells.set(column, { glyph, token: MASK_TOKENS[mark] as string });
  });
  return cells;
};
const EXPECTED_ROWS: readonly Map<number, Cell>[] = [
  rowOf('     ∩   ∩', '     f   f'),
  rowOf('╭────(•ᴥ•)────╮', 'mmmmmfcccfmmmmm'),
  rowOf('╰╮░░░░░░░░░░░╭╯', 'mmmmmmmmmmmmmmm'),
  rowOf(' ╰─╮░░░░░░░╭─╯', ' mmmmmmmmmmmmm'),
  rowOf('   ╰─╮░░░╭─╯', '   mmmmmmmmm'),
  rowOf('     ╰─┬─╯', '     mmfmm'),
];
const EXPECTED_TAIL_REST = rowOf('       ╰─╮', '       fff');
const EXPECTED_TAIL_SWING = rowOf('     ╭─╯', '     fff');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
const stripTags = (html: string): string => decode(html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ''));
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
const attributeOf = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?`, 'i').exec(tag);
  if (match === null) return undefined;
  return decode(match[1] ?? match[2] ?? match[3] ?? '');
};
const idsOf = (html: string): string[] => [...html.matchAll(/<[a-zA-Z][^>]*?\sid="([^"]*)"/g)].map((match) => decode(match[1] as string));
const hrefsOf = (html: string): string[] => [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((match) => decode(match[1] as string));

type MarkedElement = { tag: string; inner: string; start: number; end: number };
const elementsWith = (html: string, attribute: string): MarkedElement[] => {
  const found: MarkedElement[] = [];
  const opening = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\s${attribute}(?=[\\s=>/])[^>]*>`, 'g');
  for (const match of html.matchAll(opening)) {
    const name = (match[1] as string).toLowerCase();
    const start = (match.index ?? 0) + match[0].length;
    const tags = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
    tags.lastIndex = start;
    let depth = 1;
    let end = html.length;
    let outerEnd = html.length;
    for (let next = tags.exec(html); next !== null; next = tags.exec(html)) {
      depth += next[1] === '/' ? -1 : 1;
      if (depth === 0) {
        end = next.index;
        outerEnd = next.index + next[0].length;
        break;
      }
    }
    const selfClosing = match[0].endsWith('/>');
    found.push({ tag: match[0], inner: selfClosing ? '' : html.slice(start, end), start: match.index ?? 0, end: selfClosing ? start : outerEnd });
  }
  return found;
};

const outermost = (elements: readonly MarkedElement[]): MarkedElement[] =>
  elements.filter((element) => !elements.some((other) => other !== element && other.start <= element.start && element.end <= other.end));

const cutOut = (html: string, elements: readonly MarkedElement[], keep: (element: MarkedElement) => string): string => {
  let kept = '';
  let position = 0;
  for (const element of [...outermost(elements)].sort((first, second) => first.start - second.start)) {
    kept += html.slice(position, element.start) + keep(element);
    position = element.end;
  }
  return kept + html.slice(position);
};

const LABEL_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'] as const;

const interfaceTextOf = (html: string): { texts: string[]; titles: string[] } => {
  const head = /<head\b[\s\S]*?<\/head>/.exec(html)?.[0] ?? '';
  const titles = [...head.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/g)].map((match) => squash(decode(match[1] as string)));
  const body = html.slice(html.indexOf('</head>'));
  const withoutFigure = body.replace(/<svg\b[\s\S]*?<\/svg>/g, '');
  const outside = cutOut(withoutFigure, elementsWith(withoutFigure, 'data-source'), (element) =>
    elementsWith(element.tag + element.inner, 'data-ui')
      .map((ui) => `<span>${ui.inner}</span>`)
      .join(''),
  );
  const labels = [...outside.matchAll(/<[a-zA-Z][^>]*>/g)].flatMap((tag) =>
    LABEL_ATTRIBUTES.flatMap((name) => [...tag[0].matchAll(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'g'))].map((match) => squash(decode(match[1] as string)))),
  );
  const texts = outside
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .split(/<[^>]*>/)
    .map((part) => squash(decode(part)))
    .filter((part) => part !== '');
  return { texts: [...texts, ...labels], titles };
};
const outsideFences = (markdown: string): { line: string; number: number }[] => {
  const kept: { line: string; number: number }[] = [];
  let fence: string | undefined;
  markdown.split('\n').forEach((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker !== null) {
      const run = marker[1] as string;
      if (fence === undefined) fence = run;
      else if (run.startsWith(fence)) fence = undefined;
      return;
    }
    if (fence === undefined) kept.push({ line, number: index + 1 });
  });
  return kept;
};

const inlineText = (markdown: string): string =>
  squash(
    markdown
      .split(/(`+[^`]*`+)/)
      .map((part, index) =>
        index % 2 === 1
          ? part.replace(/^`+|`+$/g, '')
          : part
              .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
              .replace(/\*\*|__/g, '')
              .replace(/\\([!-/:-@[-`{-~])/g, '$1'),
      )
      .map(decode)
      .join(''),
  );

const githubSlug = (text: string): string =>
  inlineText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');

type Heading = { level: number; text: string; id: string; line: number };
const headingsOf = (file: SourceFile): Heading[] => {
  const seen = new Map<string, number>();
  const headings: Heading[] = [];
  for (const { line, number } of outsideFences(sourceOf(file))) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match === null) continue;
    const base = githubSlug(match[2] as string);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.push({ level: (match[1] as string).length, text: match[2] as string, id: count === 0 ? base : `${base}-${count}`, line: number });
  }
  return headings;
};

const pageSlugOf = (title: string): string => githubSlug(title.replace(/^\d+\.\s+/, ''));
const guidePages = (): { title: string; key: string; line: number }[] =>
  headingsOf('README.md')
    .filter((heading) => heading.level === 2 && /^\d+\.\s/.test(heading.text))
    .map((heading) => ({ title: heading.text, key: `docs/${pageSlugOf(heading.text)}.html`, line: heading.line }));
const referencePages = (): { title: string; key: string; line: number }[] =>
  headingsOf('docs/reference.md')
    .filter((heading) => heading.level === 2)
    .map((heading) => ({ title: heading.text, key: `docs/reference/${githubSlug(heading.text)}.html`, line: heading.line }));

const pageOfHeading = (file: SourceFile, heading: Heading): string => {
  if (file === 'docs/threat-model.md') return 'docs/threat-model.html';
  const pages = file === 'README.md' ? guidePages() : referencePages();
  const owner = pages.filter((page) => page.line <= heading.line).at(-1);
  if (owner === undefined) throw new Error(`${file}:${heading.line} is before the first page of the file`);
  return owner.key;
};

const urlOfKey = (key: string): string => {
  if (key === 'index.html') return '/';
  if (key.endsWith('/index.html')) return `/${key.slice(0, -'index.html'.length)}`;
  return `/${key.slice(0, -'.html'.length)}`;
};

const tableRowsOfSource = (markdown: string): string[][][] => {
  const tables: string[][][] = [];
  let current: string[][] | undefined;
  for (const { line } of outsideFences(markdown)) {
    if (!line.startsWith('|')) {
      current = undefined;
      continue;
    }
    if (/^\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) continue;
    if (current === undefined) {
      current = [];
      tables.push(current);
    }
    current.push(line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => inlineText(cell)));
  }
  return tables;
};

const tableRowsOfHtml = (html: string): string[][][] =>
  [...html.matchAll(/<table\b[\s\S]*?<\/table>/g)].map((table) =>
    [...table[0].matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map((row) => [...row[0].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) => squash(stripTags(cell[1] as string)))),
  );

const cssBlocks = (css: string): Map<string, string>[] =>
  [...css.matchAll(/\{([^{}]*)\}/g)].map((block) => new Map([...(block[1] as string).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)].map((declaration) => [declaration[1] as string, (declaration[2] as string).trim().toLowerCase()])));

const relativeLuminance = (hex: string): number => {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};
const contrast = (first: string, second: string): number => {
  const [light, dark] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

const COLOURED_TOKENS = Object.entries(STYLE).flatMap(([token, style]) =>
  'dark' in style && 'light' in style ? [{ token, variable: `--${token.replace(/\./g, '-')}`, dark: style.dark.truecolor.toLowerCase(), light: style.light.truecolor.toLowerCase() }] : [],
);

type FigureCell = { row: number; column: number; token: string | undefined; pose: string | undefined; glyph: string };
const figureCells = (svg: string): FigureCell[] =>
  [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)]
    .filter((match) => attributeOf(match[0], 'data-row') !== undefined)
    .map((match) => ({
      row: Number(attributeOf(match[0], 'data-row')),
      column: Number(attributeOf(match[0], 'data-col')),
      token: attributeOf(match[0], 'data-token'),
      pose: attributeOf(match[0], 'data-pose'),
      glyph: decode(match[2] as string),
    }));
const cellsAsMap = (cells: readonly FigureCell[]): Map<number, Cell> => new Map(cells.map((cell) => [cell.column, { glyph: cell.glyph, token: cell.token ?? '' }]));

describe('the website', () => {
  let root = '';
  let site: ReadonlyMap<string, Uint8Array> = new Map();
  let second: ReadonlyMap<string, Uint8Array> = new Map();

  const text = (key: string): string => {
    const bytes = site.get(key);
    if (bytes === undefined) throw new Error(`the site has no ${key}`);
    return Buffer.from(bytes).toString('utf8');
  };
  const pageKeys = (): string[] => [...site.keys()].filter((key) => key.endsWith('.html')).sort();
  const cssText = (): string =>
    [
      ...pageKeys().flatMap((key) => [...text(key).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1] as string)),
      ...[...site.keys()].filter((key) => key.endsWith('.css')).map(text),
    ].join('\n');

  const resolve = (from: string, link: string): { key: string; anchor: string | undefined } | undefined => {
    const [target = '', anchor] = link.split('#') as [string, string | undefined];
    if (target === '') return { key: from, anchor };
    if (!target.startsWith('/')) return undefined;
    if (target === '/') return { key: 'index.html', anchor };
    if (target.endsWith('/')) return site.has(`${target.slice(1)}index.html`) ? { key: `${target.slice(1)}index.html`, anchor } : undefined;
    if (target.endsWith('.html')) return undefined;
    if (site.has(target.slice(1))) return { key: target.slice(1), anchor };
    if (site.has(`${target.slice(1)}.html`)) return { key: `${target.slice(1)}.html`, anchor };
    return undefined;
  };
  const resolves = (from: string, link: string): boolean => {
    const found = resolve(from, link);
    if (found === undefined) return false;
    return found.anchor === undefined || idsOf(text(found.key)).includes(found.anchor);
  };

  beforeAll(async () => {
    root = createTempRoot();
    site = await buildSite(repoRoot);
    second = await buildSite(repoRoot);
  });

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('names its target in one place', () => {
    expect(SITE_ORIGIN).toBe('https://momongacode.com');
    expect(SITE_PROJECT).toBe('momongacode');
    expect(INSTALLERS.map((installer) => [installer.file, installer.source, installer.tab, installer.language, installer.command])).toEqual([
      ['install.sh', 'scripts/install.sh', 'macOS and Linux', 'sh', 'curl -fsSL https://momongacode.com/install.sh | bash'],
      ['install.ps1', 'scripts/install.ps1', 'Windows, in PowerShell', 'powershell', 'irm https://momongacode.com/install.ps1 | iex'],
    ]);
  });

  it.each([
    ['print-origin', 'https://momongacode.com\n'],
    ['print-project', 'momongacode\n'],
  ])('prints its target with site-target.ts %s', (command, printed) => {
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/site-target.ts'), command], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(printed);
  });

  it('serves the installers as byte-for-byte copies of scripts/install.sh and scripts/install.ps1', () => {
    for (const installer of INSTALLERS) expect(Buffer.from(site.get(installer.file) ?? new Uint8Array()).equals(fs.readFileSync(path.join(repoRoot, installer.source)))).toBe(true);
  });

  it('holds exactly the pages of its sources, the files served beside them and hashed assets', () => {
    const pages = ['index.html', 'docs/index.html', 'docs/reference/index.html', 'docs/threat-model.html', '404.html', ...guidePages().map((page) => page.key), ...referencePages().map((page) => page.key)].sort();
    expect(guidePages()).toHaveLength(11);
    expect(guidePages().map((page) => page.key)).toContain('docs/getting-started.html');
    expect(guidePages().map((page) => page.key)).toContain('docs/why-momongacode.html');
    expect(referencePages().map((page) => page.key)).toContain('docs/reference/root-options.html');
    expect(pageKeys()).toEqual(pages);
    for (const file of SERVED_BESIDE_PAGES) expect(site.has(file), file).toBe(true);
    const others = [...site.keys()].filter((key) => !pages.includes(key) && !SERVED_BESIDE_PAGES.includes(key));
    expect(others.length).toBeGreaterThan(0);
    for (const key of others) expect(key).toMatch(/^assets\/[^/]+$/);
  });

  it('is the same, byte for byte, when built twice', () => {
    expect([...second.keys()].sort()).toEqual([...site.keys()].sort());
    for (const [key, bytes] of site) expect(Buffer.from(second.get(key) ?? new Uint8Array()).equals(Buffer.from(bytes)), key).toBe(true);
  });

  it('writes exactly the built files with node scripts/site.ts --output <dir>', () => {
    const output = path.join(createTempDir({ parent: root }), 'site');
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/site.ts'), '--output', output], { cwd: repoRoot, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const written = (fs.readdirSync(output, { recursive: true, withFileTypes: true }) as fs.Dirent[])
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(output, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .sort();
    expect(written).toEqual([...site.keys()].sort());
    for (const key of written) expect(fs.readFileSync(path.join(output, key)).equals(Buffer.from(site.get(key) as Uint8Array)), key).toBe(true);
  });

  it('refuses an output directory that is neither absent nor empty, names it, and deletes nothing', () => {
    const repository = createTempDir({ parent: root });
    const output = path.join(createTempDir({ parent: root }), 'site');
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'kept.txt'), 'kept');
    expect(() => writeSite(new Map([['index.html', Buffer.from('x')]]), output, repository)).toThrow(`the output directory ${output} is not empty`);
    expect(fs.readdirSync(output)).toEqual(['kept.txt']);
    expect(fs.readFileSync(path.join(output, 'kept.txt'), 'utf8')).toBe('kept');
  });

  it('refuses the repository itself as the output directory and deletes nothing', () => {
    const repository = createTempDir({ parent: root });
    fs.writeFileSync(path.join(repository, 'kept.txt'), 'kept');
    expect(() => writeSite(new Map([['index.html', Buffer.from('x')]]), repository, repository)).toThrow(`the output directory ${repository} is not empty`);
    expect(fs.readdirSync(repository)).toEqual(['kept.txt']);
  });

  it.each([
    ['absent', false],
    ['empty', true],
  ])('writes into an output directory that is %s', (_state, exists) => {
    const repository = createTempDir({ parent: root });
    const output = path.join(createTempDir({ parent: root }), 'site');
    if (exists) fs.mkdirSync(output);
    writeSite(new Map([['docs/index.html', Buffer.from('x')]]), output, repository);
    expect(fs.readFileSync(path.join(output, 'docs/index.html'), 'utf8')).toBe('x');
  });

  it('replaces what a build left in dist/site of the repository, also when named with --output', () => {
    const repository = createTempDir({ parent: root });
    const own = path.join(repository, 'dist/site');
    fs.mkdirSync(path.join(repository, 'dist'));
    fs.writeFileSync(path.join(repository, 'dist/other.txt'), 'other');
    writeSite(new Map([['old.html', Buffer.from('old')]]), own, repository);
    writeSite(new Map([['index.html', Buffer.from('new')]]), path.join(repository, 'dist', '.', 'site'), repository);
    expect(fs.readdirSync(own)).toEqual(['index.html']);
    expect(fs.readFileSync(path.join(own, 'index.html'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(repository, 'dist/other.txt'), 'utf8')).toBe('other');
  });

  it('builds into dist/site of the repository when no output is named', () => {
    expect(siteOutput([], '/repository')).toBe(path.join('/repository', 'dist/site'));
    expect(siteOutput(['--output', 'elsewhere'], '/repository')).toBe(path.resolve('elsewhere'));
    expect(siteOutput(['--output'], '/repository')).toBeUndefined();
    expect(siteOutput(['--output', ''], '/repository')).toBeUndefined();
    expect(siteOutput(['--other', 'x'], '/repository')).toBeUndefined();
  });

  it('links only to pages, anchors and files that exist, in the one form of each', () => {
    let internal = 0;
    let anchored = 0;
    let repository = 0;
    for (const key of pageKeys()) {
      for (const link of hrefsOf(text(key))) {
        if (link.startsWith('https://github.com/') && link.includes('/blob/')) {
          const prefix = `https://github.com/${REPO}/blob/v${VERSION}/`;
          expect(link.startsWith(prefix), `${key}: ${link}`).toBe(true);
          const file = link.slice(prefix.length).split('#')[0] as string;
          expect(fs.existsSync(path.join(repoRoot, file)), `${key}: ${link}`).toBe(true);
          repository += 1;
          continue;
        }
        if (/^(https?:|mailto:)/.test(link)) continue;
        expect(resolves(key, link), `${key}: ${link}`).toBe(true);
        internal += 1;
        if (link.includes('#')) anchored += 1;
      }
    }
    expect(internal).toBeGreaterThan(0);
    expect(anchored).toBeGreaterThan(0);
    expect(repository).toBeGreaterThan(0);
  });

  it('links every page to the tab icon', () => {
    for (const key of pageKeys()) expect(text(key), key).toMatch(/<link\b[^>]*\srel="icon"[^>]*\shref="\/favicon\.svg"|<link\b[^>]*\shref="\/favicon\.svg"[^>]*\srel="icon"/);
  });

  it('has no relative link to a .md file and no raw.githubusercontent address', () => {
    for (const key of pageKeys()) {
      for (const link of hrefsOf(text(key))) if (!/^https?:/.test(link)) expect(link, key).not.toMatch(/\.md(#|$)/);
    }
    for (const key of site.keys()) if (!key.startsWith('install.')) expect(text(key), key).not.toContain('raw.githubusercontent');
  });

  it('carries no banned spelling of the product name', () => {
    for (const key of site.keys()) expect(text(key), key).not.toContain('Momonga Code');
  });

  it('gives every heading of the three sources exactly one id, on its page, by the GitHub rule', () => {
    let count = 0;
    for (const file of SOURCE_FILES) {
      for (const heading of headingsOf(file).filter((each) => each.level >= 2)) {
        const page = pageOfHeading(file, heading);
        expect(idsOf(text(page)).filter((id) => id === heading.id), `${file}:${heading.line} #${heading.id} in ${page}`).toHaveLength(1);
        count += 1;
      }
    }
    expect(count).toBeGreaterThan(50);
  });

  it('has no duplicate id on any page', () => {
    for (const key of pageKeys()) {
      const ids = idsOf(text(key));
      expect(ids.filter((id, index) => ids.indexOf(id) !== index), key).toEqual([]);
    }
  });

  it('gives every table row an id that starts with the id of its heading', () => {
    let rows = 0;
    for (const key of pageKeys().filter((each) => each.startsWith('docs/'))) {
      const html = text(key);
      for (const row of html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)) {
        if (!row[0].includes('<td')) continue;
        const id = attributeOf(/<tr\b[^>]*>/.exec(row[0])?.[0] ?? '', 'id');
        expect(id, `${key}: ${row[0].slice(0, 120)}`).toBeTruthy();
        const before = html.slice(0, row.index);
        const heading = [...before.matchAll(/<h[1-6]\b[^>]*\sid="([^"]*)"/g)].at(-1)?.[1];
        expect(heading, key).toBeDefined();
        expect((id as string).startsWith(heading as string), `${key}: ${id as string} under #${heading as string}`).toBe(true);
        rows += 1;
      }
    }
    const sourceRows = SOURCE_FILES.flatMap((file) => tableRowsOfSource(sourceOf(file))).reduce((total, table) => total + table.length - 1, 0);
    expect(sourceRows).toBeGreaterThan(0);
    expect(rows).toBeGreaterThanOrEqual(sourceRows);
  });

  it('gives the rows https_proxy and HTTPS_PROXY each their own id and each a search record that points at it', () => {
    const key = 'docs/reference/environment-variables.html';
    const html = text(key);
    const rowIds = ['https_proxy', 'HTTPS_PROXY'].map((name) => {
      const row = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].find((each) => each[0].includes(`<td><code>${name}</code></td>`));
      expect(row, name).toBeDefined();
      const id = attributeOf(/<tr\b[^>]*>/.exec((row as RegExpMatchArray)[0])?.[0] ?? '', 'id');
      expect(id, name).toBeTruthy();
      return id as string;
    });
    expect(new Set(rowIds).size).toBe(2);
    const indexKey = [...site.keys()].find((each) => /^assets\/search-index\.[^/]+\.json$/.test(each)) as string;
    const urls = (JSON.parse(text(indexKey)) as SearchRecord[]).map((each) => each.url);
    for (const id of rowIds) expect(urls.filter((url) => url === `/docs/reference/environment-variables#${id}`), id).toHaveLength(1);
  });

  it('keeps every row and cell of the reference tables', () => {
    const built = referencePages().flatMap((page) => tableRowsOfHtml(text(page.key)));
    const source = tableRowsOfSource(sourceOf('docs/reference.md'));
    expect(source.length).toBeGreaterThan(5);
    expect(built).toEqual(source);
  });

  it('shows <host>, <owner>/<repo> and v<version> as text', () => {
    for (const key of pageKeys()) expect(text(key), key).not.toMatch(/<\/?(host|owner|repo|name|number|version)>/);
    const all = pageKeys()
      .map((key) => stripTags(text(key)))
      .join('\n');
    expect(all).toContain('https://<host>/<owner>/<name>/issues/<number>');
    expect(all).toContain('<owner>/<repo>');
    expect(all).toContain('v<version>');
  });

  it('shows a code block inside a list item without the indentation of the list', () => {
    const blocks: string[] = [];
    for (const file of SOURCE_FILES) {
      const lines = sourceOf(file).split('\n');
      lines.forEach((line, index) => {
        const open = /^( {2,})(`{3,})/.exec(line);
        if (open === null) return;
        const indent = (open[1] as string).length;
        const close = lines.findIndex((each, at) => at > index && each.trim() === open[2]);
        if (close === -1) return;
        if (lines.slice(0, index).filter((each) => /^\s*(`{3,}|~{3,})/.test(each)).length % 2 === 1) return;
        blocks.push(lines.slice(index + 1, close).map((each) => each.slice(indent)).join('\n'));
      });
    }
    expect(blocks.length).toBeGreaterThan(0);
    const shown = pageKeys().flatMap((key) => [...text(key).matchAll(/<pre\b[^>]*>[\s\S]*?<code\b[^>]*>([\s\S]*?)<\/code>/g)].map((match) => stripTags(match[1] as string).replace(/\n$/, '')));
    for (const block of blocks) expect(shown, block).toContain(block);
  });

  it('writes _headers with the installers as plain text and the hashed assets immutable, and no other header', () => {
    const rules = new Map<string, Map<string, string>>();
    let current: Map<string, string> | undefined;
    for (const line of text('_headers').split('\n')) {
      if (line.trim() === '') continue;
      if (!/^\s/.test(line)) {
        current = new Map();
        rules.set(line.trim(), current);
        continue;
      }
      const at = line.indexOf(':');
      current?.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
    }
    for (const installer of INSTALLERS) expect(rules.get(`/${installer.file}`)).toEqual(new Map([['content-type', 'text/plain; charset=utf-8']]));
    const others = [...rules.keys()].filter((rule) => !INSTALLERS.some((installer) => rule === `/${installer.file}`));
    expect(others.length).toBeGreaterThan(0);
    for (const rule of others) {
      expect(rule.startsWith('/assets/'), rule).toBe(true);
      expect([...(rules.get(rule) as Map<string, string>).keys()]).toEqual(['cache-control']);
      expect(rules.get(rule)?.get('cache-control')).toContain('immutable');
    }
  });

  it('has a not-found page that links to the documentation and to the landing page', () => {
    const page = text('404.html');
    expect(hrefsOf(page)).toContain('/docs/');
    expect(hrefsOf(page)).toContain('/');
  });

  it('lists every page in sitemap.xml and llms.txt by its address on the origin, and serves robots.txt', () => {
    const addresses = pageKeys()
      .filter((key) => key !== '404.html')
      .map((key) => `${SITE_ORIGIN}${urlOfKey(key)}`)
      .sort();
    expect([...text('sitemap.xml').matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => decode(match[1] as string)).sort()).toEqual(addresses);
    const llms = text('llms.txt');
    for (const address of addresses) expect(llms, address).toContain(address);
    expect(text('robots.txt').trim().length).toBeGreaterThan(0);
  });

  it('writes one search index whose records each point at a page and an anchor that exist', () => {
    const indexes = [...site.keys()].filter((key) => /^assets\/search-index\.[^/]+\.json$/.test(key));
    expect(indexes).toHaveLength(1);
    const records = JSON.parse(text(indexes[0] as string)) as SearchRecord[];
    const headings = SOURCE_FILES.flatMap((file) => headingsOf(file).filter((heading) => heading.level >= 2));
    expect(records.length).toBeGreaterThanOrEqual(headings.length);
    for (const record of records) {
      expect(record.title.length, record.url).toBeGreaterThan(0);
      expect(record.url.startsWith('/'), record.url).toBe(true);
      expect(resolves('index.html', record.url), record.url).toBe(true);
    }
  });

  it('shows the version of packages/cli/package.json, linked to its GitHub release', () => {
    expect(text('index.html')).toContain(`href="https://github.com/${REPO}/releases/tag/v${VERSION}"`);
    expect(stripTags(text('index.html'))).toContain(`v${VERSION}`);
  });

  it('shows on the landing page the install commands, the first paragraph of the README and the sentence after the commands', () => {
    const landing = squash(stripTags(text('index.html')));
    for (const installer of INSTALLERS) expect(landing).toContain(installer.command);
    const lines = sourceOf('README.md').split('\n');
    const first = lines.findIndex((line, index) => index > 0 && line.trim() !== '' && !line.startsWith('#'));
    const paragraph = lines.slice(first, lines.findIndex((line, index) => index > first && line.trim() === ''));
    expect(landing).toContain(inlineText(paragraph.join(' ')));
    const sectionOne = lines.slice(lines.findIndex((line) => line.startsWith('## 1. ')), lines.findIndex((line) => line.startsWith('## 2. ')));
    const after = sectionOne.slice(sectionOne.lastIndexOf('```') + 1).filter((line) => line.trim() !== '');
    expect(after.length).toBeGreaterThan(0);
    expect(landing).toContain(inlineText(after.join(' ')));
  });

  it('links each bold lead of README section 4, without its trailing full stop, from the landing page into /docs/features', () => {
    const lines = sourceOf('README.md').split('\n');
    const section = lines.slice(lines.findIndex((line) => line.startsWith('## 4. ')), lines.findIndex((line) => line.startsWith('## 5. ')));
    const leads = section.flatMap((line) => {
      const match = /^- \*\*(.+?)\*\*/.exec(line);
      return match === null ? [] : [inlineText(match[1] as string).replace(/\.$/, '')];
    });
    expect(leads.length).toBeGreaterThan(10);
    const links = [...text('index.html').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
      .filter((match) => (attributeOf(match[0], 'href') ?? '').startsWith('/docs/features'))
      .map((match) => squash(stripTags(match[2] as string)));
    expect(links).toEqual(leads);
  });

  it('lists the documentation pages on /docs/ in sidebar order', () => {
    const order = [...guidePages(), ...referencePages()].map((page) => urlOfKey(page.key)).concat('/docs/threat-model');
    const seen: string[] = [];
    for (const link of hrefsOf(text('docs/index.html'))) {
      const target = link.split('#')[0] as string;
      if (order.includes(target) && !seen.includes(target)) seen.push(target);
    }
    expect(seen).toEqual(order);
  });

  it('marks exactly the interface strings of the design with data-ui', () => {
    const strings = new Set<string>();
    for (const key of pageKeys()) {
      for (const element of elementsWith(text(key), 'data-ui')) {
        strings.add(squash(stripTags(element.inner)));
      }
    }
    expect([...strings].sort()).toEqual([...INTERFACE_STRINGS].sort());
  });

  it('shows outside the rendered source text only the interface strings of the design, and titles that are source headings', () => {
    const headingTitles = new Set(SOURCE_FILES.flatMap((file) => headingsOf(file).map((heading) => inlineText(heading.text))));
    const strings = new Set<string>();
    for (const key of pageKeys()) {
      const { texts, titles } = interfaceTextOf(text(key));
      for (const each of texts) strings.add(each);
      expect(titles, key).toHaveLength(1);
      for (const title of titles) expect(INTERFACE_STRINGS.includes(title) || headingTitles.has(title), `${key}: <title>${title}</title>`).toBe(true);
    }
    expect([...strings].sort()).toEqual([...INTERFACE_STRINGS].sort());
  });

  it('marks as source text only text that a source holds', () => {
    const sourceText = squash(SOURCE_FILES.map((file) => inlineText(sourceOf(file).replace(/\n/g, ' '))).join(' '));
    for (const key of pageKeys()) {
      const html = text(key);
      for (const element of elementsWith(html, 'data-source')) {
        const own = squash(stripTags(cutOut(element.inner, elementsWith(element.inner, 'data-ui'), () => ' ')));
        expect(own.length, key).toBeGreaterThan(0);
        if (!/<(?:p|li|h\d|table|pre|div)\b/.test(element.inner)) expect(sourceText, `${key}: ${own}`).toContain(own);
      }
    }
  });

  it('defines the figure in one module that the start screen reads', () => {
    expect(TAIL_WAG_FRAMES).toBe(6);
    expect(TAIL_WAG_MS).toBe(300);
    expect(ART_WIDTH).toBe(15);
    const cellsOf = (parts: readonly { text: string; token?: string }[]): Map<number, Cell> => {
      const cells = new Map<number, Cell>();
      let column = 0;
      for (const part of parts) {
        for (const glyph of part.text) {
          if (glyph !== ' ') cells.set(column, { glyph, token: part.token ?? '' });
          column += 1;
        }
      }
      return cells;
    };
    expect(FIGURE.slice(0, -1).map((row) => cellsOf(row.rest))).toEqual(EXPECTED_ROWS);
    expect(cellsOf((FIGURE.at(-1) as (typeof FIGURE)[number]).rest)).toEqual(EXPECTED_TAIL_REST);
    expect(cellsOf((FIGURE.at(-1) as (typeof FIGURE)[number]).swing ?? [])).toEqual(EXPECTED_TAIL_SWING);
    const startup = fs.readFileSync(path.join(repoRoot, 'packages/cli/src/tui/startup.tsx'), 'utf8');
    expect(startup).toMatch(/from '\.\/figure\.ts'/);
    expect(startup).not.toContain('∩');
  });

  it('draws on the landing page one figure whose cells are the start screen figure in both tail poses', () => {
    const svgs = [...text('index.html').matchAll(/<svg\b[^>]*\sclass="figure"[^>]*>[\s\S]*?<\/svg>/g)];
    expect(svgs).toHaveLength(1);
    const cells = figureCells((svgs[0] as RegExpMatchArray)[0]);
    const tailRow = EXPECTED_ROWS.length;
    EXPECTED_ROWS.forEach((expected, row) => {
      const shown = cells.filter((cell) => cell.row === row);
      expect(shown.every((cell) => cell.pose === undefined), `row ${row}`).toBe(true);
      expect(cellsAsMap(shown), `row ${row}`).toEqual(expected);
    });
    expect(cellsAsMap(cells.filter((cell) => cell.row === tailRow && cell.pose === 'rest'))).toEqual(EXPECTED_TAIL_REST);
    expect(cellsAsMap(cells.filter((cell) => cell.row === tailRow && cell.pose === 'swing'))).toEqual(EXPECTED_TAIL_SWING);
    expect(cells.filter((cell) => cell.row === tailRow && cell.pose !== 'rest' && cell.pose !== 'swing')).toEqual([]);
    expect(cells.filter((cell) => cell.row > tailRow)).toEqual([]);
  });

  it('leaves the tail at rest when the visitor asks for reduced motion', () => {
    const landing = [text('index.html'), cssText()].join('\n');
    expect(landing).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it('draws the tab icon as the head of the figure, filling a square, in both palettes', () => {
    const icon = text('favicon.svg');
    const cells = figureCells(icon);
    const headColumns = [...(EXPECTED_ROWS[1] as Map<number, Cell>)].filter(([, cell]) => cell.token !== MEMBRANE).map(([column]) => column);
    const first = Math.min(...headColumns);
    const last = Math.max(...headColumns);
    const crop = (row: Map<number, Cell>): Map<number, Cell> => new Map([...row].filter(([column]) => column >= first && column <= last).map(([column, cell]) => [column - first, cell]));
    expect(new Set(cells.map((cell) => cell.row))).toEqual(new Set([0, 1]));
    expect(cellsAsMap(cells.filter((cell) => cell.row === 0))).toEqual(crop(EXPECTED_ROWS[0] as Map<number, Cell>));
    expect(cellsAsMap(cells.filter((cell) => cell.row === 1))).toEqual(crop(EXPECTED_ROWS[1] as Map<number, Cell>));
    expect(cells.filter((cell) => cell.token === MEMBRANE)).toEqual([]);
    const box = (attributeOf(icon.match(/<svg\b[^>]*>/)?.[0] ?? '', 'viewBox') ?? '').split(' ').map(Number);
    expect(box).toHaveLength(4);
    expect(box[2]).toBe(box[3]);
    const lowered = icon.toLowerCase();
    for (const token of [FUR, FACE]) {
      const colour = COLOURED_TOKENS.find((each) => each.token === token);
      expect(colour, token).toBeDefined();
      expect(lowered, `${token} dark`).toContain(colour?.dark);
      expect(lowered, `${token} light`).toContain(colour?.light);
    }
  });

  it('keeps a name in a table whole, scrolls a wide table inside its own frame, and keeps the frame of wrapped inline code on each line', () => {
    for (const key of pageKeys()) {
      const page = text(key);
      const tables = [...page.matchAll(/<table\b/g)].length;
      const framed = [...page.matchAll(/<div class="table-wrap"><table\b/g)].length;
      expect(framed, key).toBe(tables);
    }
    const css = cssText().replace(/\s+/g, ' ');
    const rule = (selector: string): string => css.match(new RegExp(`(?:^|[}\\s,])${selector.replace(/[.()>:]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule('.table-wrap')).toMatch(/overflow-x:\s*auto/);
    expect(rule('td code')).toMatch(/white-space:\s*nowrap/);
    expect(rule('td code')).toMatch(/overflow-wrap:\s*normal/);
    expect(rule('td code')).not.toMatch(/word-break/);
    expect(rule(':not(pre) > code')).not.toMatch(/overflow-wrap:\s*anywhere|word-break/);
    expect(rule(':not(pre) > code')).toMatch(/(?:^|;)\s*box-decoration-break:\s*clone/);
    expect(rule(':not(pre) > code')).toMatch(/-webkit-box-decoration-break:\s*clone/);
    expect(rule('pre')).toMatch(/overflow-x:\s*auto/);
  });

  it('defines the colours of STYLE and the four page colours for dark and for light', () => {
    const blocks = cssBlocks(cssText());
    const dark = blocks.filter((block) => block.get('--page-background') === '#0d1117');
    const light = blocks.filter((block) => block.get('--page-background') === '#ffffff');
    expect(dark.length).toBeGreaterThan(0);
    expect(light.length).toBeGreaterThan(0);
    expect(COLOURED_TOKENS.map((each) => each.variable)).toContain('--banner-fur');
    for (const block of dark) {
      expect(block.get('--page-text')).toBe('#e6edf3');
      for (const each of COLOURED_TOKENS) expect(block.get(each.variable), each.variable).toBe(each.dark);
    }
    for (const block of light) {
      expect(block.get('--page-text')).toBe('#1f2328');
      for (const each of COLOURED_TOKENS) expect(block.get(each.variable), each.variable).toBe(each.light);
    }
  });

  it('names no colour beyond the four page colours and those of STYLE', () => {
    const allowed = new Set(['#0d1117', '#e6edf3', '#ffffff', '#1f2328', ...COLOURED_TOKENS.flatMap((each) => [each.dark, each.light])]);
    const icon = text('favicon.svg');
    const marked = [text('index.html'), icon];
    const declarations = [
      ...[cssText(), ...[...icon.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1] as string)].flatMap((css) => [...css.matchAll(/\{([^{}]*)\}/g)].map((block) => block[1] as string)),
      ...pageKeys().flatMap((key) => [...text(key).matchAll(/\sstyle="([^"]*)"/g)].map((match) => decode(match[1] as string))),
    ];
    const values = [
      ...declarations.flatMap((block) => block.split(';').flatMap((declaration) => (declaration.includes(':') ? [declaration.slice(declaration.indexOf(':') + 1)] : []))),
      ...marked.flatMap((svg) => [...svg.matchAll(/\s(?:fill|stroke|color|stop-color)="([^"]*)"/g)].map((match) => match[1] as string)),
    ];
    const used = values.flatMap((value) => [...value.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((hex) => hex[0].toLowerCase()));
    expect(used.length).toBeGreaterThan(0);
    for (const colour of used) expect(allowed.has(colour), colour).toBe(true);
  });

  it('gives the page text a contrast of at least 7 to 1 on the page background in both themes', () => {
    const blocks = cssBlocks(cssText());
    const pairs = blocks.filter((block) => block.has('--page-background') && block.has('--page-text')).map((block) => [block.get('--page-text') as string, block.get('--page-background') as string]);
    expect(new Set(pairs.map(([, background]) => background))).toEqual(new Set(['#0d1117', '#ffffff']));
    for (const [foreground, background] of pairs) expect(contrast(foreground as string, background as string), `${foreground} on ${background}`).toBeGreaterThanOrEqual(7);
  });
});

describe('llmsLinkText', () => {
  it('escapes the brackets and backslashes of a link title in llms.txt', () => {
    expect(llmsLinkText('Plain title')).toBe('Plain title');
    expect(llmsLinkText('[x] and a\\b')).toBe('\\[x\\] and a\\\\b');
  });
});
