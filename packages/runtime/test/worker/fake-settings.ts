import { DEFAULT_FORGET_AFTER_DAYS, DEFAULT_VERIFICATION_COMMANDS, DEFAULT_VERIFICATION_MANIFESTS, parseRule } from '@momonga/config';
import type { PermissionRule, ResolvedMemorySettings, ResolvedVerificationSettings } from '@momonga/config';
import type { HooksSettings } from '@momonga/protocol';
import type { SettingsPort } from '@momonga/runtime';
import type { Session } from '@momonga/store';

export type FakeSettings = SettingsPort & {
  stored: { effect: 'allow' | 'deny'; rule: string }[];
  appended: { sessionId: string; effect: 'allow' | 'deny'; rule: string }[];
  extraRules: { effect: 'allow' | 'deny' | 'ask'; rule: string }[];
  ruleReads: number;
  rulesHook: ((read: number) => Promise<void>) | undefined;
  trustedValue: boolean;
  hooksValue: HooksSettings;
  verificationValue: ResolvedVerificationSettings;
  memoryValue: ResolvedMemorySettings;
  classifierAlias: string | undefined;
};

export const createFakeSettings = (layout: { home: string; project: string }): FakeSettings => {
  const parse = (effect: 'allow' | 'deny' | 'ask', text: string, session: Session): PermissionRule =>
    parseRule(text, { effect, origin: 'local', source: 'settings.local.json', settingsRoot: layout.project, home: layout.home, cwd: session.cwd });
  const settings: FakeSettings = {
    stored: [],
    appended: [],
    extraRules: [],
    ruleReads: 0,
    rulesHook: undefined,
    trustedValue: true,
    hooksValue: {},
    verificationValue: { commands: [...DEFAULT_VERIFICATION_COMMANDS], manifests: [...DEFAULT_VERIFICATION_MANIFESTS] },
    memoryValue: { reflection: { enabled: false }, forgetAfterDays: DEFAULT_FORGET_AFTER_DAYS },
    classifierAlias: undefined,
    hooks: async () => settings.hooksValue,
    verification: async () => settings.verificationValue,
    memory: async () => settings.memoryValue,
    autoModeClassifier: () => settings.classifierAlias,
    rules: async (session) => {
      settings.ruleReads += 1;
      await settings.rulesHook?.(settings.ruleReads);
      return [...settings.extraRules, ...settings.stored].map((entry) => parse(entry.effect, entry.rule, session));
    },
    appendRule: async (session, entry) => {
      settings.appended.push({ sessionId: session.id, effect: entry.effect, rule: entry.rule });
      if (!settings.stored.some((existing) => existing.effect === entry.effect && existing.rule === entry.rule)) {
        settings.stored.push({ effect: entry.effect, rule: entry.rule });
      }
    },
    trusted: () => settings.trustedValue,
  };
  return settings;
};
