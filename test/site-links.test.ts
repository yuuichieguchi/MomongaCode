import { describe, expect, it } from "vitest";
import { readDocument } from "../scripts/site/markdown.ts";
import {
  assertDistinctAddresses,
  linkResolver,
  splitSource,
} from "../scripts/site/pages.ts";
import type { SourceSpec } from "../scripts/site/pages.ts";

const GUIDE: SourceSpec = {
  file: "GUIDE.md",
  group: "Guide",
  splitDepth: 2,
  keyPrefix: "docs/",
  home: "index.html",
};
const NOTES: SourceSpec = {
  file: "docs/notes.md",
  group: "Notes",
  splitDepth: 2,
  keyPrefix: "docs/notes/",
  home: "docs/notes/index.html",
};

const GUIDE_TEXT =
  "# Guide\n\n## 1. Setup\n\nFirst.\n\n### Keys\n\nKeys.\n\n## Usage\n\nUse.\n\n### Setup\n\nAgain.\n";
const NOTES_TEXT = "# Notes\n\n## Limits\n\n### Memory\n\nMemory.\n";

const resolve = linkResolver(
  [
    splitSource(GUIDE, readDocument(GUIDE.file, GUIDE_TEXT)),
    splitSource(NOTES, readDocument(NOTES.file, NOTES_TEXT)),
  ],
  { root: "/nonexistent", repo: "owner/repo", version: "1.0.0" },
  new Map([["site/assets/shot.png", "/assets/shot.abc123.png"]]),
);

describe("site link mapping", () => {
  it("maps a numbered heading to the shown id and a later heading of the same shown title to the next id", () => {
    expect(resolve("GUIDE.md", "#1-setup")).toBe("/docs/setup");
    expect(resolve("GUIDE.md", "#setup")).toBe("/docs/usage#setup-1");
  });

  it("keeps the id of a subsection on the page that owns it", () => {
    expect(resolve("GUIDE.md", "#keys")).toBe("/docs/setup#keys");
  });

  it("links to the page alone for the page top heading", () => {
    expect(resolve("GUIDE.md", "#usage")).toBe("/docs/usage");
  });

  it("links into an anchor of another document", () => {
    expect(resolve("GUIDE.md", "docs/notes.md#memory")).toBe(
      "/docs/notes/limits#memory",
    );
  });

  it("stops the build on an unknown anchor, naming the file and the anchor", () => {
    expect(() => resolve("GUIDE.md", "docs/notes.md#nowhere")).toThrow(
      "GUIDE.md: the link docs/notes.md#nowhere names #nowhere, which no page of docs/notes.md has",
    );
  });

  it("stops the build when two page headings make the same address, naming both", () => {
    const text = "# Guide\n\n## 1. Setup\n\nFirst.\n\n## Setup\n\nAgain.\n";
    expect(() =>
      assertDistinctAddresses(
        [splitSource(GUIDE, readDocument(GUIDE.file, text))],
        [],
      ),
    ).toThrow(
      'the address /docs/setup is made by two pages: the heading "1. Setup" of GUIDE.md and the heading "Setup" of GUIDE.md',
    );
  });

  it("resolves site assets to their hashed /assets/ path", () => {
    expect(resolve("site/docs/guide.md", "../assets/shot.png")).toBe(
      "/assets/shot.abc123.png",
    );
  });
});
