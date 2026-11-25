import { CONTEXT_CATEGORY_KEYS, INSPECTOR_TABS } from '@momonga/protocol';
import type { ContextCategoryKey, InspectorSnapshot, InspectorTab } from '@momonga/protocol';

export type InspectorFocusArea = 'tabs' | 'section' | 'list';
export type InspectorContextSubView = 'breakdown' | 'explorer' | 'compactions';
export type InspectorMemorySubView = 'active' | 'trace' | 'lifecycle' | 'all';
export type InspectorUsageSubView = 'tokens' | 'cache' | 'cost' | 'requests';
export type InspectorExecutionSubView = 'tools' | 'verification' | 'plan';
export type InspectorContextSort = 'tokens' | 'seq' | 'category';
export type InspectorMemoryFilter = 'all' | 'active' | 'candidate' | 'archived' | 'pinned' | 'excluded';
export type InspectorExecutionFilter = 'all' | 'failed' | 'running' | 'awaiting';

export type InspectorDetailTarget =
  | { readonly kind: 'context_item'; readonly id: string }
  | { readonly kind: 'compaction'; readonly id: string }
  | { readonly kind: 'memory'; readonly id: string }
  | { readonly kind: 'request'; readonly id: string }
  | { readonly kind: 'tool'; readonly id: string };

export const tabHasSections = (tab: InspectorTab): boolean => tab !== 'overview';

export type InspectorUiState = {
  readonly open: boolean;
  readonly tab: InspectorTab;
  readonly focus: InspectorFocusArea;
  readonly contextSubView: InspectorContextSubView;
  readonly memorySubView: InspectorMemorySubView;
  readonly usageSubView: InspectorUsageSubView;
  readonly executionSubView: InspectorExecutionSubView;
  readonly contextSort: InspectorContextSort;
  readonly contextCategoryFilter: ContextCategoryKey | 'all';
  readonly memoryFilter: InspectorMemoryFilter;
  readonly executionFilter: InspectorExecutionFilter;
  readonly selectedIndex: Readonly<Record<InspectorTab, number>>;
  readonly selectedKey: Readonly<Record<InspectorTab, string | null>>;
  readonly scrollOffset: number;
  readonly detail: InspectorDetailTarget | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly statusMessage: string | null;
  readonly lastRefreshedAt: number | null;
};

export const INITIAL_INSPECTOR_UI_STATE: InspectorUiState = {
  open: false,
  tab: 'overview',
  focus: 'tabs',
  contextSubView: 'breakdown',
  memorySubView: 'active',
  usageSubView: 'tokens',
  executionSubView: 'tools',
  contextSort: 'tokens',
  contextCategoryFilter: 'all',
  memoryFilter: 'all',
  executionFilter: 'all',
  selectedIndex: { overview: 0, context: 0, memory: 0, usage: 0, execution: 0 },
  selectedKey: { overview: null, context: null, memory: null, usage: null, execution: null },
  scrollOffset: 0,
  detail: null,
  loading: false,
  error: null,
  statusMessage: null,
  lastRefreshedAt: null,
};

export type InspectorUiAction =
  | { readonly type: 'open'; readonly tab?: InspectorTab }
  | { readonly type: 'close' }
  | { readonly type: 'set_tab'; readonly tab: InspectorTab }
  | { readonly type: 'next_tab' }
  | { readonly type: 'prev_tab' }
  | { readonly type: 'step_sub_view'; readonly delta: 1 | -1 }
  | { readonly type: 'set_sub_view'; readonly subView: InspectorContextSubView | InspectorMemorySubView | InspectorUsageSubView | InspectorExecutionSubView }
  | { readonly type: 'drill_down_category'; readonly category: ContextCategoryKey }
  | { readonly type: 'cycle_sort' }
  | { readonly type: 'cycle_filter' }
  | { readonly type: 'move_vertical'; readonly delta: 1 | -1; readonly itemIds: readonly string[] }
  | { readonly type: 'sync_items'; readonly itemIds: readonly string[] }
  | { readonly type: 'open_detail'; readonly target: InspectorDetailTarget }
  | { readonly type: 'close_detail' }
  | { readonly type: 'loading'; readonly value: boolean }
  | { readonly type: 'loaded'; readonly at: number; readonly error?: string | null }
  | { readonly type: 'status'; readonly message: string | null };

const CONTEXT_SUBVIEWS: readonly InspectorContextSubView[] = ['breakdown', 'explorer', 'compactions'];
const MEMORY_SUBVIEWS: readonly InspectorMemorySubView[] = ['active', 'trace', 'lifecycle', 'all'];
const USAGE_SUBVIEWS: readonly InspectorUsageSubView[] = ['tokens', 'cache', 'cost', 'requests'];
const EXECUTION_SUBVIEWS: readonly InspectorExecutionSubView[] = ['tools', 'verification', 'plan'];
const CONTEXT_SORTS: readonly InspectorContextSort[] = ['tokens', 'seq', 'category'];
const MEMORY_FILTERS: readonly InspectorMemoryFilter[] = ['all', 'active', 'candidate', 'archived', 'pinned', 'excluded'];
const EXECUTION_FILTERS: readonly InspectorExecutionFilter[] = ['all', 'failed', 'running', 'awaiting'];

const cycleNext = <T>(list: readonly T[], current: T, delta = 1): T => {
  const index = list.indexOf(current);
  const next = (index + delta + list.length) % list.length;
  return list[next]!;
};

export const parseInspectorTab = (raw: string | undefined): InspectorTab | undefined => {
  if (raw === undefined) return undefined;
  const lower = raw.trim().toLowerCase();
  return INSPECTOR_TABS.find((tab) => tab === lower || tab.startsWith(lower));
};

export const resolveSelectedIndex = (
  state: Pick<InspectorUiState, 'tab' | 'selectedIndex' | 'selectedKey'>,
  itemIds: readonly string[],
): number => {
  if (itemIds.length === 0) return 0;
  const key = state.selectedKey[state.tab];
  if (key !== null) {
    const byKey = itemIds.indexOf(key);
    if (byKey >= 0) return byKey;
  }
  const raw = state.selectedIndex[state.tab];
  return Math.max(0, Math.min(raw, itemIds.length - 1));
};

export const reduceInspectorUi = (state: InspectorUiState, action: InspectorUiAction): InspectorUiState => {
  switch (action.type) {
    case 'open':
      return {
        ...state,
        open: true,
        focus: 'tabs',
        ...(action.tab === undefined ? {} : { tab: action.tab, detail: null, scrollOffset: 0 }),
        error: null,
      };
    case 'close':
      return {
        ...state,
        open: false,
        detail: null,
        statusMessage: null,
      };
    case 'set_tab':
      return {
        ...state,
        tab: action.tab,
        focus: 'tabs',
        detail: null,
        scrollOffset: 0,
        statusMessage: null,
      };
    case 'next_tab':
      return {
        ...state,
        tab: cycleNext(INSPECTOR_TABS, state.tab, 1),
        focus: 'tabs',
        detail: null,
        scrollOffset: 0,
        statusMessage: null,
      };
    case 'prev_tab':
      return {
        ...state,
        tab: cycleNext(INSPECTOR_TABS, state.tab, -1),
        focus: 'tabs',
        detail: null,
        scrollOffset: 0,
        statusMessage: null,
      };
    case 'step_sub_view':
      switch (state.tab) {
        case 'overview':
          return state;
        case 'context':
          return { ...state, focus: 'section', contextSubView: cycleNext(CONTEXT_SUBVIEWS, state.contextSubView, action.delta), detail: null, scrollOffset: 0, statusMessage: null };
        case 'memory':
          return { ...state, focus: 'section', memorySubView: cycleNext(MEMORY_SUBVIEWS, state.memorySubView, action.delta), detail: null, scrollOffset: 0, statusMessage: null };
        case 'usage':
          return { ...state, focus: 'section', usageSubView: cycleNext(USAGE_SUBVIEWS, state.usageSubView, action.delta), detail: null, scrollOffset: 0, statusMessage: null };
        case 'execution':
          return { ...state, focus: 'section', executionSubView: cycleNext(EXECUTION_SUBVIEWS, state.executionSubView, action.delta), detail: null, scrollOffset: 0, statusMessage: null };
      }
    case 'set_sub_view':
      if (state.tab === 'context' && (CONTEXT_SUBVIEWS as readonly string[]).includes(action.subView)) {
        return { ...state, focus: 'section', contextSubView: action.subView as InspectorContextSubView, detail: null };
      }
      if (state.tab === 'memory' && (MEMORY_SUBVIEWS as readonly string[]).includes(action.subView)) {
        return { ...state, focus: 'section', memorySubView: action.subView as InspectorMemorySubView, detail: null };
      }
      if (state.tab === 'usage' && (USAGE_SUBVIEWS as readonly string[]).includes(action.subView)) {
        return { ...state, focus: 'section', usageSubView: action.subView as InspectorUsageSubView, detail: null };
      }
      if (state.tab === 'execution' && (EXECUTION_SUBVIEWS as readonly string[]).includes(action.subView)) {
        return { ...state, focus: 'section', executionSubView: action.subView as InspectorExecutionSubView, detail: null };
      }
      return state;
    case 'drill_down_category':
      return {
        ...state,
        tab: 'context',
        contextSubView: 'explorer',
        contextCategoryFilter: action.category,
        focus: 'list',
        selectedIndex: { ...state.selectedIndex, context: 0 },
        selectedKey: { ...state.selectedKey, context: null },
        detail: null,
        scrollOffset: 0,
        statusMessage: null,
      };
    case 'cycle_sort':
      if (state.tab !== 'context') return state;
      return {
        ...state,
        contextSort: cycleNext(CONTEXT_SORTS, state.contextSort),
        contextSubView: state.contextSubView === 'breakdown' ? 'explorer' : state.contextSubView,
      };
    case 'cycle_filter':
      if (state.tab === 'context') {
        const categories: readonly (ContextCategoryKey | 'all')[] = ['all', ...CONTEXT_CATEGORY_KEYS];
        return {
          ...state,
          contextCategoryFilter: cycleNext(categories, state.contextCategoryFilter),
          contextSubView: state.contextSubView === 'breakdown' ? 'explorer' : state.contextSubView,
        };
      }
      if (state.tab === 'memory') {
        return { ...state, memoryFilter: cycleNext(MEMORY_FILTERS, state.memoryFilter) };
      }
      if (state.tab === 'execution') {
        return { ...state, executionFilter: cycleNext(EXECUTION_FILTERS, state.executionFilter), executionSubView: 'tools' };
      }
      return state;
    case 'move_vertical': {
      if (state.focus === 'tabs') {
        if (action.delta === 1 && tabHasSections(state.tab)) {
          return { ...state, focus: 'section', statusMessage: null };
        }
        return state;
      }
      if (state.focus === 'section') {
        if (action.delta === -1) {
          return { ...state, focus: 'tabs', statusMessage: null };
        }
        if (action.delta === 1 && action.itemIds.length > 0) {
          return {
            ...state,
            focus: 'list',
            selectedIndex: { ...state.selectedIndex, [state.tab]: 0 },
            selectedKey: { ...state.selectedKey, [state.tab]: action.itemIds[0] ?? null },
            statusMessage: null,
          };
        }
        return state;
      }
      if (action.itemIds.length === 0) {
        return action.delta === -1
          ? { ...state, focus: tabHasSections(state.tab) ? 'section' : 'tabs', statusMessage: null }
          : state;
      }
      const current = resolveSelectedIndex(state, action.itemIds);
      if (action.delta === -1 && current === 0) {
        return { ...state, focus: tabHasSections(state.tab) ? 'section' : 'tabs', statusMessage: null };
      }
      const next = Math.max(0, Math.min(action.itemIds.length - 1, current + action.delta));
      const key = action.itemIds[next] ?? null;
      return {
        ...state,
        selectedIndex: { ...state.selectedIndex, [state.tab]: next },
        selectedKey: { ...state.selectedKey, [state.tab]: key },
      };
    }
    case 'sync_items': {
      const idx = resolveSelectedIndex(state, action.itemIds);
      const key = action.itemIds[idx] ?? null;
      if (state.selectedIndex[state.tab] === idx && state.selectedKey[state.tab] === key) return state;
      return {
        ...state,
        selectedIndex: { ...state.selectedIndex, [state.tab]: idx },
        selectedKey: { ...state.selectedKey, [state.tab]: key },
      };
    }
    case 'open_detail':
      return { ...state, detail: action.target };
    case 'close_detail':
      return { ...state, detail: null };
    case 'loading':
      return { ...state, loading: action.value };
    case 'loaded':
      return {
        ...state,
        loading: false,
        error: action.error ?? null,
        lastRefreshedAt: action.at,
      };
    case 'status':
      return { ...state, statusMessage: action.message };
  }
};

export const filteredSortedContextItems = (
  snapshot: InspectorSnapshot,
  state: Pick<InspectorUiState, 'contextCategoryFilter' | 'contextSort'>,
) => {
  const base =
    state.contextCategoryFilter === 'all'
      ? [...snapshot.context.items]
      : snapshot.context.items.filter((item) => item.category === state.contextCategoryFilter);
  if (state.contextSort === 'tokens') {
    base.sort((a, b) => b.tokens - a.tokens || (a.seq ?? 0) - (b.seq ?? 0));
  } else if (state.contextSort === 'seq') {
    base.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
  } else {
    base.sort((a, b) => a.category.localeCompare(b.category) || b.tokens - a.tokens);
  }
  return base;
};
