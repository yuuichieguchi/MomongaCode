import { HELPER_COMMAND } from '@momonga/foundation';
import type { ExecutableHelpers, HelperHost } from '@momonga/foundation';
import { UsageError } from './usage-error.ts';

export type HelperCall = { readonly name: string | undefined; readonly args: readonly string[] };

export type HelperMode = {
  helpers(): Promise<ExecutableHelpers>;
  call: HelperCall | undefined;
  host: Omit<HelperHost, 'args'>;
};

export const helperCallOf = (given: readonly string[]): HelperCall | undefined => (given[0] === HELPER_COMMAND ? { name: given[1], args: given.slice(2) } : undefined);

export const runHelper = async (mode: HelperMode): Promise<number> => {
  if (mode.call === undefined) throw new UsageError(`${HELPER_COMMAND} must be the first argument`);
  const { name, args } = mode.call;
  if (name === undefined) throw new UsageError('the helper mode needs the name of a helper');
  const helpers = await mode.helpers();
  const helper = Object.hasOwn(helpers, name) ? helpers[name] : undefined;
  if (helper === undefined) throw new UsageError(`there is no helper named ${name}`);
  return helper({ ...mode.host, args });
};
