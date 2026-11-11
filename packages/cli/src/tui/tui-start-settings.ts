import { ConfigError, defaultTuiSettings, loadSettings, loadUserSettings, readSettingsSnapshot } from '@momonga/config';
import type { ResolvedTuiSettings } from '@momonga/config';
import { isRecord } from '@momonga/foundation';
import type { SettingSource } from './settings-screen.tsx';

export type TuiKey = keyof ResolvedTuiSettings;

export type TuiStart =
  | { readonly kind: 'loaded'; readonly settings: ResolvedTuiSettings; readonly sources: Readonly<Record<TuiKey, SettingSource>> }
  | { readonly kind: 'broken'; readonly file: string | undefined; readonly message: string };

export type TuiStartPlace = { readonly home: string; readonly projectDir: string; readonly userFile: string; readonly signal: AbortSignal };

const UNTRUSTED = { isTrusted: () => false };

const brokenBy = async (file: string | undefined, read: () => Promise<unknown>): Promise<TuiStart | undefined> => {
  try {
    await read();
    return undefined;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { kind: 'broken', file, message: error.message };
  }
};

export const readTuiStart = async ({ home, projectDir, userFile, signal }: TuiStartPlace): Promise<TuiStart> => {
  const userBroken = await brokenBy(userFile, () => loadUserSettings({ home, signal }));
  if (userBroken !== undefined) return userBroken;
  let settings: ResolvedTuiSettings = defaultTuiSettings();
  const layersBroken = await brokenBy(undefined, async () => {
    settings = (await loadSettings({ home, projectDir, cli: {}, trust: UNTRUSTED, signal })).settings.tui;
  });
  if (layersBroken !== undefined) return layersBroken;
  const snapshot = await readSettingsSnapshot({ home, projectDir, trusted: false, signal });
  const keys = Object.keys(defaultTuiSettings()) as TuiKey[];
  const merged = settings;
  const sourceOf = (key: TuiKey): SettingSource => {
    for (const view of snapshot.layers.toReversed()) {
      const tui = isRecord(view.document) ? view.document['tui'] : undefined;
      if (isRecord(tui) && Object.hasOwn(tui, key) && tui[key] === merged[key]) return view.layer;
    }
    return 'default';
  };
  return { kind: 'loaded', settings, sources: Object.fromEntries(keys.map((key) => [key, sourceOf(key)])) as Record<TuiKey, SettingSource> };
};

export const setByPerson = (start: Extract<TuiStart, { kind: 'loaded' }>, key: TuiKey): boolean => start.sources[key] !== 'default';
