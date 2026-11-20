import { clipboardWriter, wireCopyButtons } from './copy.ts';
import { indexLoader } from './index-loader.ts';
import { searchRecords } from './search.ts';
import type { SearchRecord } from './search.ts';
import { wireStage } from './stage.ts';
import { readStored, writeStored } from './storage.ts';
import { wireAll } from './wiring.ts';
import type { Commit } from './wiring.ts';

const THEME_KEY = 'theme';
const THEMES = ['auto', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

const isTheme = (value: unknown): value is Theme => THEMES.some((theme) => theme === value);

const root = document.documentElement;

const browserStorage = (): Storage => window.localStorage;

const storedTheme = (): Theme => {
  const stored = readStored(browserStorage, THEME_KEY);
  return isTheme(stored) ? stored : 'auto';
};

const applyTheme = (theme: Theme): void => {
  if (theme === 'auto') delete root.dataset['theme'];
  else root.dataset['theme'] = theme;
};

let chosenTheme = storedTheme();
applyTheme(chosenTheme);

const required = <T extends Element>(scope: ParentNode, selector: string, kind: new () => T): T => {
  const found = scope.querySelector(selector);
  if (!(found instanceof kind)) throw new Error(`the page has no ${selector}`);
  return found;
};

const attribute = (element: Element, name: string): string => {
  const value = element.getAttribute(name);
  if (value === null) throw new Error(`an element has no ${name}`);
  return value;
};

const templateText = (name: string): string => {
  const text = required(document, `template[data-${name}]`, HTMLTemplateElement).content.textContent;
  return text.trim();
};

const prepareTheme = (): Commit => {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[data-theme-choice]')].map((button) => {
    const theme = button.dataset['themeChoice'];
    if (!isTheme(theme)) throw new Error(`the theme button names ${String(theme)}`);
    return { button, theme };
  });
  const show = (): void => {
    for (const { button, theme } of buttons) button.setAttribute('aria-pressed', String(theme === chosenTheme));
  };
  return () => {
    show();
    for (const { button, theme } of buttons) {
      button.addEventListener('click', () => {
        chosenTheme = theme;
        writeStored(browserStorage, THEME_KEY, theme);
        applyTheme(theme);
        show();
      });
    }
  };
};

let celebrateStage: (() => void) | undefined;

const prepareStage = (): Commit => {
  const stage = document.querySelector<HTMLElement>('[data-stage]');
  if (stage === null) return () => {};
  const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return () => {
    celebrateStage = wireStage(
      {
        setWag: (kind) => {
          if (kind === undefined) delete stage.dataset['wag'];
          else stage.dataset['wag'] = kind;
        },
        reflow: () => {
          void stage.offsetWidth;
        },
        onClick: (listener) => {
          stage.addEventListener('click', listener);
        },
      },
      reducedMotion,
    );
  };
};

const prepareCopy = (): Commit => {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[data-copy]')];
  const copied = buttons.length === 0 ? '' : templateText('copied');
  const targets = buttons.map((button) => {
    const block = button.parentElement;
    if (block === null) throw new Error('a copy button stands outside a code block');
    const code = required(block, 'code', HTMLElement);
    const status = required(block, '[data-copy-status]', HTMLElement);
    return {
      show: () => {
        button.hidden = false;
      },
      setDone: (done: boolean) => {
        button.toggleAttribute('data-copy-done', done);
      },
      setStatus: (text: string) => {
        status.textContent = text;
      },
      onClick: (listener: () => void) => {
        button.addEventListener('click', listener);
      },
      code: () => code.textContent,
    };
  });
  const write = clipboardWriter(navigator.clipboard);
  return () => {
    wireCopyButtons(targets, write, copied, reportError, undefined, () => celebrateStage?.());
  };
};

const PLATFORMS: readonly (readonly [name: string, pattern: RegExp])[] = [
  ['Windows', /Windows/],
  ['macOS', /Macintosh|Mac OS X/],
  ['Linux', /Linux|X11/],
];

const prepareTabs = (): Commit => {
  const platform = PLATFORMS.find(([, pattern]) => pattern.test(navigator.userAgent))?.[0];
  const lists = [...document.querySelectorAll<HTMLElement>('[role="tablist"]')].map((list) => {
    const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map((tab) => ({ tab, panel: required(document, `#${attribute(tab, 'aria-controls')}`, HTMLElement) }));
    const first = tabs.find(({ tab }) => platform !== undefined && tab.textContent.includes(platform)) ?? tabs[0];
    if (first === undefined) throw new Error('a tab list has no tab');
    return { tabs, first };
  });
  return () => {
    for (const { tabs, first } of lists) {
      const select = (chosen: HTMLButtonElement): void => {
        for (const { tab, panel } of tabs) {
          const selected = tab === chosen;
          tab.setAttribute('aria-selected', String(selected));
          panel.hidden = !selected;
        }
      };
      select(first.tab);
      for (const { tab } of tabs) tab.addEventListener('click', () => select(tab));
    }
  };
};

const prepareMenu = (): Commit => {
  const button = document.querySelector<HTMLButtonElement>('button[data-menu]');
  if (button === null) return () => {};
  const sidebar = required(document, `#${attribute(button, 'aria-controls')}`, HTMLElement);
  return () => {
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(open));
      sidebar.toggleAttribute('data-open', open);
    });
  };
};

const resultItem = (record: SearchRecord): HTMLLIElement => {
  const item = document.createElement('li');
  const link = document.createElement('a');
  link.href = record.url;
  const title = document.createElement('span');
  title.className = 'result-title';
  title.textContent = record.title;
  const text = document.createElement('span');
  text.className = 'result-text';
  text.textContent = record.text;
  link.append(title, text);
  item.append(link);
  return item;
};

const prepareSearch = (): Commit => {
  const box = document.querySelector<HTMLElement>('[data-search-index]');
  if (box === null) return () => {};
  const load = indexLoader((url) => fetch(url), attribute(box, 'data-search-index'));
  const input = required(box, 'input', HTMLInputElement);
  const results = required(box, 'ul', HTMLUListElement);
  const noResults = templateText('no-results');
  const update = async (): Promise<void> => {
    const query = input.value;
    const found = searchRecords(await load(), query);
    if (input.value !== query) return;
    results.replaceChildren(...found.map(resultItem));
    if (found.length === 0 && query.trim() !== '') {
      const empty = document.createElement('li');
      empty.className = 'result-none';
      empty.textContent = noResults;
      results.append(empty);
    }
    results.hidden = query.trim() === '';
  };
  return () => {
    input.addEventListener('focus', () => {
      load().catch(reportError);
    });
    input.addEventListener('input', () => {
      update().catch(reportError);
    });
  };
};

const markWired = (): void => {
  for (const element of document.querySelectorAll<HTMLElement>('[data-needs-script]')) element.hidden = false;
  root.dataset['script'] = '';
};

document.addEventListener('DOMContentLoaded', () => {
  wireAll([prepareTheme, prepareStage, prepareCopy, prepareTabs, prepareMenu, prepareSearch], markWired);
});
