import type { Run, RuntimeStore, Session } from '@momonga/store';
import type { SettingsPort } from '../ports.ts';
import { readTokenPin } from './pins.ts';
import type { TokenPin } from './pins.ts';

export type { TokenPin } from './pins.ts';

export type TokenPolicy = Required<Omit<TokenPin, 'deferred'>> & { deferred: readonly string[] | undefined };

export const tokenPolicyOf = (pin: TokenPin | undefined): TokenPolicy => ({
  cachePrefix: pin?.cachePrefix === true,
  conciseDescriptions: pin?.conciseDescriptions === true,
  loopGuidance: pin?.loopGuidance === true,
  observedCapacity: pin?.observedCapacity === true,
  outputFormatters: pin?.outputFormatters ?? [],
  deferred: pin?.deferred,
});

const pinOfParent = (store: Pick<RuntimeStore, 'readRunEventsOfTypes'>, parentRunId: string): TokenPin => {
  const started = store.readRunEventsOfTypes(parentRunId, ['run.started'])[0];
  if (started === undefined || started.type !== 'run.started') throw new Error(`run ${parentRunId} has not recorded run.started, so it has pinned no token settings`);
  const token = started.pins['token'];
  return token === undefined ? {} : readTokenPin(token);
};

export const tokenPinFor = async (input: {
  store: Pick<RuntimeStore, 'readRunEventsOfTypes'>;
  settings: Pick<SettingsPort, 'context' | 'tools'>;
  session: Session;
  run: Run;
}): Promise<TokenPin> => {
  const { store, settings, session, run } = input;
  if (run.parentRunId !== null) return pinOfParent(store, run.parentRunId);
  const [context, tools] = await Promise.all([settings.context(session), settings.tools(session)]);
  return {
    ...(context.cachePrefix ? { cachePrefix: true } : {}),
    ...(tools.conciseDescriptions ? { conciseDescriptions: true } : {}),
    ...(context.outputFormatters.length === 0 ? {} : { outputFormatters: [...context.outputFormatters] }),
    ...(context.loopGuidance ? { loopGuidance: true } : {}),
    ...(context.observedCapacity ? { observedCapacity: true } : {}),
  };
};
