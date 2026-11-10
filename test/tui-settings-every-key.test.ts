import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, TUI_SCREEN_MODES } from '@momonga/config';
import { DEFAULT_SLASH_COMMANDS } from '../packages/cli/src/tui/commands/index.ts';
import { COMMAND_LINKS, SETTINGS_REACHED_BY_COMMAND, SETTING_ROWS, SETTING_SECTIONS, settingLeaves } from '../packages/cli/src/tui/settings-screen.tsx';
import { SCREEN_MODES } from '../packages/cli/src/tui/terminal/modes.ts';

const EDITED_BY_THE_MODELS_COMMANDS = ['autoMode.classifier', 'models.connections', 'models.start', 'models.fallback', 'models.servers', 'models.billingChanges', 'models.roles.compaction', 'models.roles.reflection', 'models.roles.analysis', 'models.headersTimeoutMs', 'models.idleTimeoutMs'];

const wayOf = (key: string): string[] => [...(SETTING_ROWS[key] === undefined ? [] : ['row']), ...(SETTINGS_REACHED_BY_COMMAND[key] === undefined ? [] : ['command'])];

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
    expect(new Set(keys.map((key) => key.split('.')[0]))).toEqual(new Set(Object.keys(SETTINGS_SCHEMA.properties)));
  });

  it('has a row in the settings screen or a command that reaches it, for every key', () => {
    expect(withoutWay(keys)).toEqual([]);
  });

  it('names a key that is added to the schema without its way', () => {
    const grown = { properties: { ...SETTINGS_SCHEMA.properties, telemetry: { type: 'object', properties: { sampleRate: { type: 'number' } }, additionalProperties: false }, drafts: { type: 'boolean' } } };
    expect(withoutWay(settingLeaves(grown).map((leaf) => leaf.key))).toEqual(['telemetry.sampleRate', 'drafts']);
  });

  it('gives no key two ways', () => {
    expect(keys.filter((key) => wayOf(key).length > 1)).toEqual([]);
  });

  it('has no row and no command entry for a key the schema does not have', () => {
    const listed = [...Object.keys(SETTING_ROWS), ...Object.keys(SETTINGS_REACHED_BY_COMMAND)];
    expect(listed.filter((key) => !keys.includes(key))).toEqual([]);
  });

  it('puts every row in a section of the screen and gives every command a row that opens it', () => {
    for (const [key, row] of Object.entries(SETTING_ROWS)) expect(SETTING_SECTIONS, key).toContain(row.section);
    expect(new Set(Object.values(SETTINGS_REACHED_BY_COMMAND))).toEqual(new Set(Object.keys(COMMAND_LINKS)));
    const commands = DEFAULT_SLASH_COMMANDS.map((command) => command.name);
    for (const name of Object.keys(COMMAND_LINKS)) expect(commands, name).toContain(name);
  });

  it('lists the keys the /models flows edit, and none of them names the old shape', () => {
    expect(Object.keys(SETTINGS_REACHED_BY_COMMAND).filter((key) => SETTINGS_REACHED_BY_COMMAND[key] === 'models')).toEqual(EDITED_BY_THE_MODELS_COMMANDS);
  });

  it('stores the screen modes the terminal layer has', () => {
    expect(TUI_SCREEN_MODES).toEqual(SCREEN_MODES);
  });
});
