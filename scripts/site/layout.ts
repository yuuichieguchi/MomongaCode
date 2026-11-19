import { urlOfKey } from './pages.ts';
import type { DocPage, SourceSet } from './pages.ts';
import { escapeHtml } from './text.ts';
import type { TocEntry } from './markdown.ts';

export type Assets = { css: string; js: string; searchIndex: string };

export type Chrome = { assets: Assets; repo: string; sources: readonly SourceSet[]; footer: readonly { label: string; url: string }[] };

const ui = (tag: string, text: string, attributes = ''): string => `<${tag}${attributes} data-ui>${escapeHtml(text)}</${tag}>`;

const repositoryUrl = (repo: string): string => `https://github.com/${repo}`;

const header = (chrome: Chrome, menu: boolean): string =>
  [
    '<header class="top">',
    '<div class="top-inner">',
    menu ? ui('button', 'Menu', ' type="button" class="menu" data-menu aria-controls="sidebar" aria-expanded="false" hidden data-needs-script') : '',
    ui('a', 'MomongaCode', ' class="brand" href="/"'),
    '<nav class="top-nav">',
    ui('a', 'Docs', ' href="/docs/"'),
    ui('a', 'GitHub', ` href="${escapeHtml(repositoryUrl(chrome.repo))}"`),
    '</nav>',
    `<div class="search" data-search-index="${escapeHtml(chrome.assets.searchIndex)}" hidden data-needs-script>`,
    ui('label', 'Search', ' for="search-input"'),
    '<input id="search-input" type="search" autocomplete="off" spellcheck="false">',
    '<ul class="search-results" hidden></ul>',
    '</div>',
    '</div>',
    '</header>',
  ].join('\n');

const footer = (chrome: Chrome): string =>
  [
    '<footer class="bottom">',
    '<div class="bottom-inner">',
    '<nav class="bottom-nav">',
    ...chrome.footer.map((link) => ui('a', link.label, ` href="${escapeHtml(link.url)}"`)),
    ui('a', 'GitHub', ` href="${escapeHtml(repositoryUrl(chrome.repo))}"`),
    '</nav>',
    '<div class="theme" role="group" hidden data-needs-script>',
    ui('button', 'Auto', ' type="button" data-theme-choice="auto" aria-pressed="true"'),
    ui('button', 'Light', ' type="button" data-theme-choice="light" aria-pressed="false"'),
    ui('button', 'Dark', ' type="button" data-theme-choice="dark" aria-pressed="false"'),
    '</div>',
    '</div>',
    '</footer>',
  ].join('\n');

const TEMPLATES = [ui('template', 'Copied', ' data-copied'), ui('template', 'No results', ' data-no-results')].join('\n');

export const page = (chrome: Chrome, options: { title: string; body: string; menu: boolean; className: string }): string =>
  [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(options.title)}</title>`,
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    `<link rel="stylesheet" href="${escapeHtml(chrome.assets.css)}">`,
    `<script src="${escapeHtml(chrome.assets.js)}"></script>`,
    '</head>',
    `<body class="${options.className}">`,
    ui('a', 'Skip to content', ' class="skip" href="#content"'),
    header(chrome, options.menu),
    options.body,
    footer(chrome),
    TEMPLATES,
    '</body>',
    '</html>',
    '',
  ].join('\n');

const current = (url: string, here: string): string => (url === here ? ' aria-current="page"' : '');

const groupList = (pages: readonly DocPage[], here: string): string =>
  `<ul>${pages.map((each) => `<li><a href="${escapeHtml(each.url)}"${current(each.url, here)} data-source>${escapeHtml(each.title)}</a></li>`).join('')}</ul>`;

const groupLabel = (source: SourceSet, here: string): string => {
  const single = source.pages.length === 1 ? source.pages[0] : undefined;
  if (single !== undefined) return ui('a', source.spec.group, ` class="group" href="${escapeHtml(single.url)}"${current(single.url, here)}`);
  const home = source.spec.home === 'index.html' ? undefined : urlOfKey(source.spec.home);
  return home === undefined ? ui('p', source.spec.group, ' class="group"') : ui('a', source.spec.group, ` class="group" href="${escapeHtml(home)}"${current(home, here)}`);
};

const sidebar = (chrome: Chrome, here: string): string =>
  [
    '<nav id="sidebar" class="sidebar">',
    ...chrome.sources.map((source) => `<div class="sidebar-group">${groupLabel(source, here)}${source.pages.length === 1 ? '' : groupList(source.pages, here)}</div>`),
    '</nav>',
  ].join('\n');

const toc = (entries: readonly TocEntry[]): string =>
  entries.length === 0
    ? ''
    : [`<nav class="toc">`, ui('p', 'On this page', ' class="toc-title"'), `<ul>${entries.map((entry) => `<li><a href="#${escapeHtml(entry.id)}" data-source>${escapeHtml(entry.title)}</a></li>`).join('')}</ul>`, '</nav>'].join('\n');

export const docsLayout = (chrome: Chrome, here: string, article: string, entries: readonly TocEntry[]): string =>
  ['<div class="docs">', sidebar(chrome, here), `<main id="content" class="article">${article}</main>`, toc(entries), '</div>'].join('\n');
