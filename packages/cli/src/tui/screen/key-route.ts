import type { KeyContext } from '../keys/table.ts';
import type { Overlay } from '../picker.tsx';

export type KeyRoute = 'trust' | 'tool-view' | 'overlay' | 'inspector' | 'welcome' | 'prompt' | 'agents' | 'shell' | 'menu' | 'editor';

export type KeyRouteFacts = {
  readonly trust: boolean;
  readonly toolView: boolean;
  readonly overlay: Overlay['kind'] | undefined;
  readonly inspector?: boolean;
  readonly welcome: boolean;
  readonly prompt: 'decision' | 'fields' | undefined;
  readonly detail: boolean;
  readonly shellDraft: boolean;
  readonly menuOpen: boolean;
  readonly agentsChosen: boolean;
  readonly fullscreen: boolean;
};

export const keyRouteOf = (facts: KeyRouteFacts): KeyRoute => {
  if (facts.trust) return 'trust';
  if (facts.toolView) return 'tool-view';
  if (facts.overlay !== undefined) return 'overlay';
  if (facts.inspector) return 'inspector';
  if (facts.welcome) return 'welcome';
  if (facts.prompt !== undefined) return 'prompt';
  if (facts.agentsChosen) return 'agents';
  if (facts.shellDraft) return 'shell';
  return facts.menuOpen ? 'menu' : 'editor';
};

const LIST: readonly KeyContext[] = ['select'];
const DETAIL: readonly KeyContext[] = ['viewer'];
const LINE_ENTRY: readonly KeyContext[] = ['select', 'chat'];
const NO_CONTEXT: readonly KeyContext[] = [];
const EDITOR: readonly KeyContext[] = ['chat', 'global'];

const OVERLAY_CONTEXTS: Readonly<Record<Overlay['kind'], readonly KeyContext[]>> = { pick: LIST, text: LINE_ENTRY, waiting: LINE_ENTRY, loading: LIST, capture: NO_CONTEXT, kept: LIST };

const listContexts = (facts: KeyRouteFacts): readonly KeyContext[] => (facts.detail ? DETAIL : LIST);

const draftContexts = (facts: KeyRouteFacts, first: readonly KeyContext[]): readonly KeyContext[] => [...first, ...(facts.fullscreen ? (['viewport'] as const) : []), ...EDITOR];

export const chordContextsOf = (facts: KeyRouteFacts): readonly KeyContext[] => {
  const route = keyRouteOf(facts);
  switch (route) {
    case 'trust':
      return listContexts(facts);
    case 'tool-view':
      return DETAIL;
    case 'overlay':
      return facts.overlay === 'pick' ? listContexts(facts) : facts.overlay === undefined ? NO_CONTEXT : OVERLAY_CONTEXTS[facts.overlay];
    case 'inspector':
      return ['inspector', 'global'];
    case 'welcome':
      return NO_CONTEXT;
    case 'prompt':
      return facts.prompt === 'fields' ? LINE_ENTRY : listContexts(facts);
    case 'agents':
      return draftContexts(facts, ['agents']);
    case 'shell':
      return draftContexts(facts, ['shell']);
    case 'menu':
      return draftContexts(facts, ['menu']);
    case 'editor':
      return draftContexts(facts, []);
  }
};
