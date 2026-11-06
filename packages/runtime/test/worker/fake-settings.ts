import { DEFAULT_FORGET_AFTER_DAYS, DEFAULT_VERIFICATION_COMMANDS, DEFAULT_VERIFICATION_MANIFESTS, parseRule } from '@momonga/config';
import type { ModelRoles, PermissionRule, ResolvedContextSettings, ResolvedMemorySettings, ResolvedToolsSettings, ResolvedVerificationSettings } from '@momonga/config';
import type { HooksSettings } from '@momonga/protocol';
import type { SettingsPort, TargetFacts } from '@momonga/runtime';
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
  contextValue: ResolvedContextSettings;
  context: (session: Session) => Promise<ResolvedContextSettings>;
  toolsValue: ResolvedToolsSettings;
  classifierAlias: string | undefined;
  rolesValue: ModelRoles;
  modelRoles: () => ModelRoles;
  targetsValue: Record<string, TargetFacts>;
  modelTargets: () => Record<string, TargetFacts>;
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
    memoryValue: { reflection: { enabled: false }, forgetAfterDays: DEFAULT_FORGET_AFTER_DAYS, repositoryFacts: false },
    contextValue: { adaptiveBudget: false, autoCompact: true, cachePrefix: false, outputFormatters: [], loopGuidance: false, observedCapacity: false, unboundedOutputReserve: false },
    toolsValue: { deferral: false, conciseDescriptions: false },
    classifierAlias: undefined,
    rolesValue: {},
    modelRoles: () => ({ ...settings.rolesValue }),
    targetsValue: {},
    modelTargets: () => ({ ...settings.targetsValue }),
    hooks: async () => settings.hooksValue,
    verification: async () => settings.verificationValue,
    memory: async () => settings.memoryValue,
    context: async () => settings.contextValue,
    tools: async () => settings.toolsValue,
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
