import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, TUI_SCREEN_MODES } from '@momonga/config';
import { DEFAULT_SLASH_COMMANDS } from '../packages/cli/src/tui/commands/index.ts';
import { SETTINGS_LINKS, SETTINGS_REACHED_BY_LINK, SETTING_ROWS, SETTING_SECTIONS, settingLeaves } from '../packages/cli/src/tui/settings-screen.tsx';
import { SCREEN_MODES } from '../packages/cli/src/tui/terminal/modes.ts';

const EDITED_ON_THE_MODELS_SCREEN = ['autoMode.classifier', 'memory.autoReviewModel', 'models.connections', 'models.start', 'models.fallback', 'models.servers', 'models.billingChanges', 'models.roles.compaction', 'models.roles.reflection', 'models.roles.analysis', 'models.roles.subagent', 'models.headersTimeoutMs', 'models.idleTimeoutMs'];

const wayOf = (key: string): string[] => [...(SETTING_ROWS[key] === undefined ? [] : ['row']), ...(SETTINGS_REACHED_BY_LINK[key] === undefined ? [] : ['link'])];

const withoutWay = (keys: readonly string[]): string[] => keys.filter((key) => wayOf(key).length === 0);

describe('every key of the settings schema a person may change has its way in the TUI', () => {
  const keys = settingLeaves().map((leaf) => leaf.key);

  it('finds the leaves of the schema, through every object that names its keys', () => {
    expect(keys).toContain('autoUpdates');
    expect(keys).toContain('memory.reflection.maxTokens');
    expect(keys).toContain('telemetry.otlp.endpoint');
    expect(keys).toContain('hooks');
    expect(keys).toContain('models.connections');
    expect(keys).not.toContain('models.targets');
    expect(keys).not.toContain('models.aliases');
    expect(keys).not.toContain('memory.reflection');
    expect(keys).toContain('memory.autoReview');
    expect(keys).toContain('memory.autoReviewModel');
    expect(new Set(keys.map((key) => key.split('.')[0]))).toEqual(new Set(Object.keys(SETTINGS_SCHEMA.properties)));
  });

  it('has a row in the settings screen or a link that reaches it, for every key', () => {
    expect(withoutWay(keys)).toEqual([]);
  });

  it('names a key that is added to the schema without its way', () => {
    const grown = { properties: { ...SETTINGS_SCHEMA.properties, telemetry: { type: 'object', properties: { sampleRate: { type: 'number' } }, additionalProperties: false }, drafts: { type: 'boolean' } } };
    expect(withoutWay(settingLeaves(grown).map((leaf) => leaf.key))).toEqual(['telemetry.sampleRate', 'drafts']);
  });

  it('gives no key two ways', () => {
    expect(keys.filter((key) => wayOf(key).length > 1)).toEqual([]);
  });

  it('has no row and no link entry for a key the schema does not have', () => {
    const listed = [...Object.keys(SETTING_ROWS), ...Object.keys(SETTINGS_REACHED_BY_LINK)];
    expect(listed.filter((key) => !keys.includes(key))).toEqual([]);
  });

  it('puts every row in a section of the screen and gives every link a row that opens it, through a registered command or the Models screen', () => {
    for (const [key, row] of Object.entries(SETTING_ROWS)) expect(SETTING_SECTIONS, key).toContain(row.section);
    expect(new Set(Object.values(SETTINGS_REACHED_BY_LINK))).toEqual(new Set(Object.keys(SETTINGS_LINKS)));
    const commands = DEFAULT_SLASH_COMMANDS.map((command) => command.name);
    for (const [name, link] of Object.entries(SETTINGS_LINKS)) if (link.command !== undefined) expect(commands, name).toContain(link.command);
    expect(SETTINGS_LINKS['models']?.command).toBeUndefined();
    expect(commands).not.toContain('models');
  });

  it('lists the keys the Models screen edits, and none of them names the old shape', () => {
    expect(Object.keys(SETTINGS_REACHED_BY_LINK).filter((key) => SETTINGS_REACHED_BY_LINK[key] === 'models')).toEqual(EDITED_ON_THE_MODELS_SCREEN);
  });

  it('shows memory.autoReview as the toggle row Auto review of the section Memory, and reaches memory.autoReviewModel through the Models screen', () => {
    expect(SETTING_ROWS['memory.autoReview']).toEqual({ label: 'Auto review', section: 'Memory' });
    expect(SETTINGS_REACHED_BY_LINK['memory.autoReviewModel']).toBe('models');
  });

  it('stores the screen modes the terminal layer has', () => {
    expect(TUI_SCREEN_MODES).toEqual(SCREEN_MODES);
  });
});
