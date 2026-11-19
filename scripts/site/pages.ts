import fs from "node:fs";
import path from "node:path";
import type { Token, Tokens } from "marked";
import { marked, plainText, readDocument, squash } from "./markdown.ts";
import type { Block, LinkTarget, SourceDocument } from "./markdown.ts";
import { githubSlug, shownTitle } from "./text.ts";

export type SourceSpec = {
  file: string;
  group: string;
  splitDepth: number;
  keyPrefix: string;
  home: string;
};

const SOURCES: readonly SourceSpec[] = [
  {
    file: "README.md",
    group: "Guide",
    splitDepth: 2,
    keyPrefix: "docs/",
    home: "index.html",
  },
  {
    file: "docs/reference.md",
    group: "Reference",
    splitDepth: 2,
    keyPrefix: "docs/reference/",
    home: "docs/reference/index.html",
  },
  {
    file: "docs/threat-model.md",
    group: "Threat model",
    splitDepth: 1,
    keyPrefix: "docs/",
    home: "docs/threat-model.html",
  },
];

export type DocPage = {
  key: string;
  url: string;
  title: string;
  spec: SourceSpec;
  document: SourceDocument;
  heading: Tokens.Heading;
  blocks: readonly Block[];
};

export type SourceSet = {
  spec: SourceSpec;
  document: SourceDocument;
  preamble: readonly Block[];
  pages: readonly DocPage[];
};

export const urlOfKey = (key: string): string => {
  if (key === "index.html") return "/";
  if (key.endsWith("/index.html"))
    return `/${key.slice(0, -"index.html".length)}`;
  if (!key.endsWith(".html")) throw new Error(`${key} is not a page`);
  return `/${key.slice(0, -".html".length)}`;
};

export const splitSource = (
  spec: SourceSpec,
  document: SourceDocument,
): SourceSet => {
  const preamble: Block[] = [];
  const pages: (DocPage & { blocks: Block[] })[] = [];
  for (const block of document.blocks) {
    const { token } = block;
    if (token.type === "heading" && token.depth === spec.splitDepth) {
      const title = shownTitle(squash(plainText(spec.file, token.tokens)));
      const key = `${spec.keyPrefix}${githubSlug(title)}.html`;
      pages.push({
        key,
        url: urlOfKey(key),
        title,
        spec,
        document,
        heading: token,
        blocks: [block],
      });
      continue;
    }
    const page = pages.at(-1);
    if (page === undefined) preamble.push(block);
    else page.blocks.push(block);
  }
  if (pages.length === 0)
    throw new Error(
      `${spec.file} has no heading of depth ${spec.splitDepth}, so it makes no page`,
    );
  return { spec, document, preamble, pages };
};

export type FixedPage = { key: string; name: string };

export const assertDistinctAddresses = (
  sources: readonly SourceSet[],
  fixed: readonly FixedPage[],
): void => {
  const owners = new Map<string, string>();
  const claim = (key: string, name: string): void => {
    const earlier = owners.get(key);
    if (earlier !== undefined)
      throw new Error(
        `the address ${urlOfKey(key)} is made by two pages: ${earlier} and ${name}`,
      );
    owners.set(key, name);
  };
  for (const each of fixed) claim(each.key, each.name);
  for (const source of sources)
    for (const page of source.pages)
      claim(
        page.key,
        `the heading "${squash(plainText(source.spec.file, page.heading.tokens))}" of ${source.spec.file}`,
      );
};

export const readSources = (root: string): SourceSet[] =>
  SOURCES.map((spec) =>
    splitSource(
      spec,
      readDocument(
        spec.file,
        fs.readFileSync(path.join(root, spec.file), "utf8"),
      ),
    ),
  );

const headingsOf = (
  document: SourceDocument,
  blocks: readonly Block[],
): string[] => {
  const ids: string[] = [];
  const visit = (tokens: readonly Token[]): void => {
    for (const each of tokens) {
      const token = marked(document.file, each);
      if (token.type === "heading") {
        const id = document.headingIds.get(token);
        if (id === undefined)
          throw new Error(`${document.file}: a heading has no id`);
        ids.push(id);
      }
      if (token.type === "list")
        visit(token.items.flatMap((item) => item.tokens));
      if (token.type === "blockquote") visit(token.tokens);
    }
  };
  visit(blocks.map((block) => block.token));
  return ids;
};

export type SiteFacts = { root: string; repo: string; version: string };

export const linkResolver = (
  sources: readonly SourceSet[],
  facts: SiteFacts,
): LinkTarget => {
  const owners = new Map<
    string,
    {
      home: string;
      anchors: ReadonlyMap<string, string>;
      pages: Map<string, string>;
      tops: Set<string>;
    }
  >();
  for (const source of sources) {
    const pages = new Map<string, string>();
    const tops = new Set<string>();
    for (const page of source.pages) {
      const [top, ...rest] = headingsOf(source.document, page.blocks);
      if (top === undefined)
        throw new Error(`${source.spec.file}: a page has no heading`);
      tops.add(top);
      for (const id of [top, ...rest]) pages.set(id, page.key);
    }
    owners.set(source.spec.file, {
      home: source.spec.home,
      anchors: source.document.sourceAnchors,
      pages,
      tops,
    });
  }
  return (from, href) => {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return href;
    const hash = href.indexOf("#");
    const target = hash === -1 ? href : href.slice(0, hash);
    const anchor = hash === -1 ? undefined : href.slice(hash + 1);
    const file =
      target === ""
        ? from
        : path.posix.normalize(
            path.posix.join(path.posix.dirname(from), target),
          );
    const owner = owners.get(file);
    if (owner !== undefined) {
      if (anchor === undefined) return urlOfKey(owner.home);
      const id = owner.anchors.get(anchor);
      const key = id === undefined ? undefined : owner.pages.get(id);
      if (id === undefined || key === undefined)
        throw new Error(
          `${from}: the link ${href} names #${anchor}, which no page of ${file} has`,
        );
      return owner.tops.has(id) ? urlOfKey(key) : `${urlOfKey(key)}#${id}`;
    }
    if (file.startsWith("../") || path.posix.isAbsolute(file))
      throw new Error(`${from}: the link ${href} leaves the repository`);
    if (!fs.existsSync(path.join(facts.root, file)))
      throw new Error(
        `${from}: the link ${href} names ${file}, which does not exist`,
      );
    return `https://github.com/${facts.repo}/blob/v${facts.version}/${file}${anchor === undefined ? "" : `#${anchor}`}`;
  };
};
