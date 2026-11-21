import { isRecord } from '@momonga/foundation';
import { DEFAULT_OUTPUT_STYLE } from '@momonga/protocol';
import type { OutputStyle } from '@momonga/protocol';
import { editUserSettings } from './edit-user-settings.ts';
import { settingsWriterPorts } from './file-lock.ts';
import type { SettingsWriterOptions } from './file-lock.ts';

export type OutputSettings = { style?: OutputStyle };

export type ResolvedOutputSettings = { style: OutputStyle };

export const defaultOutputSettings = (): ResolvedOutputSettings => ({ style: DEFAULT_OUTPUT_STYLE });

export const mergeOutputSettings = (base: ResolvedOutputSettings, layer: OutputSettings | undefined): ResolvedOutputSettings =>
  layer?.style === undefined ? base : { style: layer.style };

export const writeOutputStyleSetting = async (
  home: string,
  settingsFile: string,
  style: OutputStyle | undefined,
  options: SettingsWriterOptions,
): Promise<void> => {
  await editUserSettings(
    settingsFile,
    (document) => {
      const existing = document['output'];
      if (existing !== undefined && !isRecord(existing)) throw new Error(`${settingsFile}: output must be a JSON object`);
      if (style === undefined) {
        if (existing === undefined || !Object.hasOwn(existing, 'style')) return false;
        const next = { ...existing };
        delete next['style'];
        if (Object.keys(next).length === 0) delete document['output'];
        else document['output'] = next;
        return true;
      }
      if (existing?.['style'] === style) return false;
      document['output'] = { ...existing, style };
      return true;
    },
    settingsWriterPorts(home, options),
  );
};
