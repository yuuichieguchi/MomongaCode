import core from 'highlight.js/lib/core';
import type { Emitter, HighlightApi, LanguageFn } from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import type { StyleToken } from './tokens.ts';

export type CodeSpan = readonly [start: number, end: number, tokens: readonly StyleToken[]];

const LANGUAGES: Readonly<Record<string, LanguageFn>> = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, makefile, markdown, php, python, ruby, rust, shell, sql, swift, typescript, xml, yaml };

const SCOPE_TOKENS: Readonly<Record<string, readonly StyleToken[]>> = {
  comment: ['dim', 'italic'],
  quote: ['dim', 'italic'],
  doctag: ['dim', 'italic'],
  keyword: ['accent'],
  'selector-tag': ['accent'],
  literal: ['warning'],
  number: ['warning'],
  symbol: ['warning'],
  string: ['success'],
  regexp: ['success'],
  char: ['success'],
  built_in: ['user'],
  type: ['user'],
  'title.class': ['user'],
  meta: ['dim'],
  addition: ['diff.added'],
  deletion: ['diff.removed'],
};

const tokensOfScope = (scope: string): readonly StyleToken[] | undefined => {
  for (let name = scope; name !== ''; name = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : '') {
    const tokens = SCOPE_TOKENS[name];
    if (tokens !== undefined) return tokens;
  }
  return undefined;
};

class SpanEmitter implements Emitter {
  readonly spans: CodeSpan[] = [];
  private position = 0;
  private readonly scopes: (readonly StyleToken[] | undefined)[] = [];

  addText(text: string): void {
    const start = this.position;
    this.position += text.length;
    const tokens = this.scopes.findLast((found) => found !== undefined);
    if (tokens !== undefined && text.length > 0) this.spans.push([start, this.position, tokens]);
  }

  startScope(scope: string): void {
    this.openNode(scope);
  }

  endScope(): void {
    this.closeNode();
  }

  openNode(scope: string): void {
    this.scopes.push(tokensOfScope(scope));
  }

  closeNode(): void {
    this.scopes.pop();
  }

  __addSublanguage(emitter: Emitter): void {
    if (!(emitter instanceof SpanEmitter)) throw new Error('a sub-language was highlighted by an emitter of another kind');
    for (const [start, end, tokens] of emitter.spans) this.spans.push([start + this.position, end + this.position, tokens]);
    this.position += emitter.position;
  }

  finalize(): void {}

  toHTML(): string {
    return '';
  }
}

const highlighter: HighlightApi = core.newInstance();
highlighter.configure({ __emitter: SpanEmitter });
for (const [name, language] of Object.entries(LANGUAGES)) highlighter.registerLanguage(name, language);

export const HIGHLIGHTED_LANGUAGES: ReadonlySet<string> = new Set(highlighter.listLanguages().flatMap((name) => [name, ...(highlighter.getLanguage(name)?.aliases ?? [])]));

export const highlightCode = (code: string, language: string): CodeSpan[] | undefined => {
  if (highlighter.getLanguage(language) === undefined) return undefined;
  const result = highlighter.highlight(code, { language });
  const emitter: unknown = Reflect.get(result, '_emitter');
  if (!(emitter instanceof SpanEmitter) || Reflect.get(result, 'errorRaised') !== undefined) return undefined;
  return emitter.spans;
};
