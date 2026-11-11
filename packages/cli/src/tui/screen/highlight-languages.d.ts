declare module 'highlight.js/lib/languages/*' {
  import type { LanguageFn } from 'highlight.js/lib/core';
  const language: LanguageFn;
  export default language;
}
