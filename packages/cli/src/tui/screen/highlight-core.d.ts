export type LanguageFn = (api: unknown) => unknown;

export interface Emitter {
  startScope(name: string): void;
  endScope(): void;
  addText(text: string): void;
  toHTML(): string;
  finalize(): void;
  __addSublanguage(emitter: Emitter, subLanguageName: string): void;
}

export interface HighlightApi {
  newInstance(): HighlightApi;
  configure(options: { __emitter: new (options: unknown) => Emitter }): void;
  registerLanguage(name: string, language: LanguageFn): void;
  listLanguages(): string[];
  getLanguage(name: string): { aliases?: string[] } | undefined;
  highlight(code: string, options: { language: string }): object;
}

declare const hljs: HighlightApi;

export default hljs;
