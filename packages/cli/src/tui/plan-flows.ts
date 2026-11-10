import { SECRET_NAME_PATTERN } from '@momonga/foundation';
import type { DetectedLocalServer, DetectedManagedServer, LocalServerDetection, MomongaModelEntry, PlanAccountView, PlanAccountsResponse, PlanProfileView, TargetHealth } from '@momonga/protocol';
import type { ModelConnection } from '@momonga/config';
import { SANDBOX_OFF_NOTICE, accountRowLabel, accountsOf, nextAccountLabel, profileOf, profileStateText, savedAccountAction } from '../plan/accounts.ts';
import { SignInAttemptNotFoundError, SignInExpiredError, SignInGatewayStoppedError, SignInListenerError, SignInListenerFailedError, signIn, waitForPaste } from '../plan/sign-in.ts';
import type { SignInShown } from '../plan/sign-in.ts';
import type { TuiBackend } from './backend.ts';
import type { OverlayPorts, PickRow } from './picker.tsx';

export type PlanFlowPorts = OverlayPorts & {
  readonly backend: TuiBackend;
  info(text: string): void;
  connected(alias: string): Promise<void>;
  refreshConnection(): Promise<void>;
  signedIn(): Promise<void>;
};

export type PlanFlows = {
  login(args: string): Promise<void>;
  logout(): Promise<void>;
  modelPicker(currentAlias: string | undefined): Promise<void>;
  providerFlow(profile: PlanProfileView): Promise<void>;
  catalogPicker(profile: PlanProfileView, account: string): Promise<void>;
  welcome(profiles: readonly PlanProfileView[]): Promise<void>;
  usageLimit(profile: PlanProfileView): Promise<void>;
  planUseNotEnabled(profile: PlanProfileView, account: string): Promise<void>;
  notEligible(profile: PlanProfileView): Promise<void>;
};

type Choice = { row: PickRow; act(): Promise<void> };

const NAME_SHAPE = new RegExp(SECRET_NAME_PATTERN);

const API_KEY_HELP = [
  'MomongaCode takes an API key in one of two ways:',
  '  store it with momonga secret set <name> and name that secret in the target as apiKeySecret, or',
  '  keep it in an environment variable and name the variable in the target as apiKeyEnv.',
  'Declare the target in your user settings under models.targets and models.aliases.',
].join('\n');

const USE_API_KEY = 'Use an API key';

const UNREPORTED_TRAINED_CONTEXT = 'the server reports no trained context length for this model';

const healthText = (health: TargetHealth | undefined): string => {
  if (health === undefined) return 'health unknown';
  if (health.ok) return 'ready';
  return health.reason ?? 'not ready';
};

const unusableReason = (server: DetectedLocalServer, model: DetectedLocalServer['models'][number]): string | undefined =>
  server.shape === 'ollama' && model.contextWindow === undefined && model.trainedContext === undefined ? UNREPORTED_TRAINED_CONTEXT : undefined;

const windowError = (text: string, ceiling: number | undefined): string | undefined => {
  const value = Number(text.trim());
  if (text.trim() === '' || !Number.isInteger(value) || value <= 0) return 'enter the context window as a whole number of tokens';
  if (ceiling !== undefined && value > ceiling) return `the trained maximum of this model is ${ceiling} tokens; enter a window up to it`;
  return undefined;
};

const isSignInRequired = (health: TargetHealth | undefined): boolean => health?.reason === 'sign_in_required';

export const createPlanFlows = (ports: PlanFlowPorts): PlanFlows => {
  const { backend } = ports;

  const chooseFrom = async (request: { title?: string; lines?: readonly string[]; hint?: string }, choices: readonly Choice[]): Promise<boolean> => {
    const index = await ports.pick({ ...request, rows: choices.map((choice) => choice.row) });
    const chosen = index === undefined ? undefined : choices[index];
    if (chosen === undefined) return false;
    await chosen.act();
    return true;
  };

  const apiKeyHelp = async (): Promise<void> => {
    ports.info(API_KEY_HELP);
  };

  const catalogPicker = async (profile: PlanProfileView, account: string): Promise<void> => {
    const catalog = await backend.plan.accountModels(account, { profile: profile.id });
    if (catalog.models.length === 0) {
      ports.info(`${profile.messages.identityLabel} lists no model for ${account}`);
      return;
    }
    await chooseFrom(
      { title: `Choose a model of ${account}` },
      catalog.models.map((entry) =>
        entry.usable
          ? {
              row: { label: `${entry.slug} · ${entry.displayName} · ${profile.messages.pickerLabel}` },
              act: async () => {
                const created = await backend.plan.addTarget(account, { profile: profile.id, slug: entry.slug });
                await ports.connected(created.alias);
              },
            }
          : { row: { label: `${entry.slug} · ${entry.reason}`, disabled: true }, act: async () => undefined },
      ),
    );
  };

  const afterSignIn = async (profile: PlanProfileView, account: PlanAccountView, firstSignIn: boolean): Promise<void> => {
    if (firstSignIn) {
      const { title, body, action } = profile.messages.firstSignIn;
      await ports.pick({ title, lines: [body, `${profile.messages.manageUsageLabel}: ${profile.usageUrl}`], rows: [{ label: action }] });
    }
    if (account.pinnedBy.length === 0) {
      await catalogPicker(profile, account.label);
      return;
    }
    await ports.refreshConnection();
  };

  const sandboxAccepted = async (): Promise<boolean> => {
    if ((await backend.sandbox()) !== 'none') return true;
    return (await ports.pick({ title: 'The sandbox is off', lines: SANDBOX_OFF_NOTICE, rows: [{ label: 'Continue' }, { label: 'Cancel' }] })) === 0;
  };

  const signInFlow = async (profile: PlanProfileView, account: string, reconsent: boolean): Promise<void> => {
    if (!(await sandboxAccepted())) return;
    const cancel = new AbortController();
    let deliver: (text: string) => void = () => undefined;
    const deliveries = new Promise<string>((resolve) => {
      deliver = resolve;
    });
    const handlers = { cancel: () => cancel.abort(), deliver: (text: string) => deliver(text) };
    const authorize = async ({ url, state }: SignInShown): Promise<void> => {
      const lines = ['Open this URL in your browser if it does not open by itself:', url.href];
      ports.waiting({ title: profile.loginLabel, lines, url, state }, handlers);
      await backend.openUrl(url).catch((error: unknown) => {
        ports.waiting({ title: profile.loginLabel, lines: [...lines, `Could not open the browser (${error instanceof Error ? error.message : String(error)}). Copy the URL and continue manually.`], url, state }, handlers);
      });
    };
    let answer;
    try {
      answer = await signIn(
        {
          plan: backend.plan,
          startListener: backend.startSignInListener,
          authorize,
          pasted: (_state, signal) => waitForPaste(deliveries, signal),
          signal: cancel.signal,
          timers: backend.signInTimers,
        },
        { profile: profile.id, account, reconsent },
      );
    } catch (error) {
      if (cancel.signal.aborted && error === cancel.signal.reason) {
        ports.info('sign-in cancelled');
        return;
      }
      if (error instanceof SignInListenerError || error instanceof SignInListenerFailedError || error instanceof SignInGatewayStoppedError) {
        ports.info(error.message);
        return;
      }
      if (error instanceof SignInExpiredError || error instanceof SignInAttemptNotFoundError) {
        ports.info(`${error.message} Run /login to try again.`);
        return;
      }
      throw error;
    } finally {
      ports.closeWaiting();
    }
    switch (answer.outcome) {
      case 'retry':
        ports.info(`${profile.messages.identityLabel} did not accept the sign-in code (invalid_grant); start the sign-in again.`);
        await sentence(profile, account, reconsent);
        return;
      case 'plan_disabled':
        ports.info(profile.messages.planNotEnabledMessage);
        await sentence(profile, account, true);
        return;
      case 'signed_in':
        ports.info(`Signed in as ${answer.account.label}${answer.account.email === undefined ? '' : ` (${answer.account.email})`}`);
        await afterSignIn(profile, answer.account, answer.firstSignIn);
        await ports.signedIn();
        return;
    }
  };

  const sentence = async (profile: PlanProfileView, account: string, reconsent: boolean): Promise<void> => {
    ports.info(profile.messages.description);
    await chooseFrom({}, [
      { row: { label: reconsent ? `Enable ${profile.messages.identityLabel} plan use` : profile.loginLabel }, act: () => signInFlow(profile, account, reconsent) },
      { row: { label: profile.messages.apiKeyLabel }, act: apiKeyHelp },
    ]);
  };

  const savedAccount = async (profile: PlanProfileView, account: PlanAccountView): Promise<void> => {
    switch (savedAccountAction(account)) {
      case 'activate':
        await backend.plan.setActive({ profile: profile.id, account: account.label });
        ports.info(`${profile.messages.identityLabel}: using ${account.label}`);
        await ports.refreshConnection();
        return;
      case 'sign-in':
        await sentence(profile, account.label, account.state === 'plan_disabled');
        return;
      case 'none':
        ports.info(`${accountRowLabel(account)}${account.cause === undefined ? '' : `: ${account.cause}`}`);
        return;
    }
  };

  const newAccount = async (profile: PlanProfileView, listed: PlanAccountsResponse): Promise<void> => {
    const taken = new Set(accountsOf(profile.id, listed.accounts).map((account) => account.label));
    const label = await ports.promptText({
      title: 'Label for the new account or workspace',
      lines: ['The workspace is chosen in the browser; each account or workspace is saved under its own label.'],
      initial: nextAccountLabel(profile.id, listed.accounts),
      validate: (text) => {
        if (!NAME_SHAPE.test(text)) return `a label must match ${SECRET_NAME_PATTERN}`;
        if (taken.has(text)) return `${text} is already saved; choose another label`;
        return undefined;
      },
    });
    if (label === undefined) return;
    await sentence(profile, label, false);
  };

  const accountPicker = async (profile: PlanProfileView, listed: PlanAccountsResponse): Promise<void> => {
    const records = accountsOf(profile.id, listed.accounts);
    await chooseFrom({ title: profile.messages.pickerLabel }, [
      ...records.map((account) => ({ row: { label: `${accountRowLabel(account)}${account.active ? ' (current)' : ''}` }, act: () => savedAccount(profile, account) })),
      ...records
        .filter((account) => account.paused !== undefined)
        .map((account) => ({
          row: { label: `Resume plan use for ${account.label}` },
          act: async () => {
            await backend.plan.resume(account.label, { profile: profile.id });
            ports.info(`${account.label}: plan use resumed`);
          },
        })),
      { row: { label: 'Add another account or workspace' }, act: () => newAccount(profile, listed) },
    ]);
  };

  const providerFlowOf = async (profile: PlanProfileView, listed: PlanAccountsResponse): Promise<void> => {
    for (const problem of listed.listProblems ?? []) ports.info(`could not list ${problem.file}: ${problem.cause}`);
    if (accountsOf(profile.id, listed.accounts).length === 0) {
      await sentence(profile, nextAccountLabel(profile.id, listed.accounts), false);
      return;
    }
    await accountPicker(profile, listed);
  };

  const providerFlow = async (profile: PlanProfileView): Promise<void> => providerFlowOf(profile, await backend.plan.accounts());

  const addLocalServer = async (): Promise<void> => {
    const servers = await backend.detectLocalServers([]);
    if (servers.length === 0) {
      ports.info('no local model server answered; start one, or declare its target in your user settings under models.targets and models.aliases');
      return;
    }
    await chooseFrom(
      { title: 'Local model servers' },
      servers.flatMap(detectedChoices),
    );
  };

  const managedChoice = (server: DetectedManagedServer): Choice => {
    if (server.refused !== undefined) {
      const remedy = server.refused.remedy === undefined ? '' : ` (${server.refused.remedy})`;
      return { row: { label: `${server.id} · ${server.binary} · ${server.refused.message}${remedy}`, disabled: true }, act: async () => undefined };
    }
    return { row: { label: `${server.id} · ${server.binary} · managed` }, act: () => connectManagedServer(server) };
  };

  const detectedChoices = (server: LocalServerDetection): Choice[] => {
    if (server.shape === 'managed') return [managedChoice(server)];
    return server.models.map((model): Choice => {
      const reason = unusableReason(server, model);
      if (reason !== undefined) return { row: { label: `${model.id} · ${server.baseUrl} · ${reason}`, disabled: true }, act: async () => undefined };
      return { row: { label: `${model.id} · ${server.baseUrl} · ${server.shape}` }, act: () => connectLocalModel(server, model) };
    });
  };

  const connectManagedServer = async (server: DetectedManagedServer): Promise<void> => {
    const written = await backend.addModelConnection({ kind: 'managed', server: server.id });
    await ports.connected(written.alias);
  };

  const connectLocalModel = async (server: DetectedLocalServer, model: DetectedLocalServer['models'][number]): Promise<void> => {
    let contextWindow = model.contextWindow;
    if (contextWindow === undefined) {
      const ceiling = model.trainedContext;
      const entered = await ports.promptText({
        title: `Context window for ${model.id}`,
        lines: [
          ceiling === undefined
            ? 'The server does not report a context window for this model; enter the window it runs the model with.'
            : `The trained maximum of this model is ${ceiling} tokens; enter the window to run it with, up to that.`,
        ],
        validate: (text) => windowError(text, ceiling),
      });
      if (entered === undefined) return;
      contextWindow = Number(entered.trim());
    }
    const connection: ModelConnection = { kind: 'server', baseUrl: server.baseUrl, shape: server.shape, model: model.id, contextWindow };
    const written = await backend.addModelConnection(connection);
    await ports.connected(written.alias);
  };

  const login = async (args: string): Promise<void> => {
    ports.loading('Connect a model');
    const listed = await backend.plan.accounts();
    if (args !== '') {
      await providerFlowOf(profileOf(listed.profiles, args), listed);
      return;
    }
    const [entries, health] = await Promise.all([backend.models(), backend.health()]);
    const localTargets = [...new Set(entries.flatMap((entry) => entry.targets.filter((target) => entry.targetBilling?.[target] === 'local')))];
    await chooseFrom({ title: 'Connect a model' }, [
      ...listed.profiles.map((profile) => ({ row: { label: `${profile.messages.pickerLabel} [subscription] · ${profileStateText(profile, listed.accounts)}` }, act: () => providerFlowOf(profile, listed) })),
      { row: { label: 'Add an API key' }, act: apiKeyHelp },
      ...localTargets.map((target) => ({
        row: { label: `${target} [local server] · ${healthText(health.targets[target])}` },
        act: async () => ports.info(`${target} is configured; /model switches to an alias that uses it`),
      })),
      { row: { label: 'Add a local server' }, act: addLocalServer },
    ]);
  };

  const logout = async (): Promise<void> => {
    ports.loading('Sign out');
    const listed = await backend.plan.accounts();
    if (listed.accounts.length === 0) {
      ports.info('no subscription account is saved');
      return;
    }
    const index = await ports.pick({ title: 'Sign out', rows: listed.accounts.map((account) => ({ label: accountRowLabel(account) })), confirm: (row) => `press enter again to sign out ${row.label}` });
    const chosen = index === undefined ? undefined : listed.accounts[index];
    if (chosen === undefined) return;
    const report = await backend.plan.signOut({ profile: chosen.profile, account: chosen.label });
    const profile = profileOf(listed.profiles, chosen.profile);
    ports.info(`Signed out ${chosen.label}`);
    if (report.revocation !== 'confirmed') ports.info(`The sign-in could not be confirmed as revoked; disconnect the app in ${profile.messages.identityLabel} settings: ${report.usageUrl}`);
  };

  const targetSignIn = async (listed: PlanAccountsResponse, plan: { profile: string; account?: string }): Promise<void> => {
    const profile = profileOf(listed.profiles, plan.profile);
    const records = accountsOf(profile.id, listed.accounts);
    const label = plan.account ?? records.find((record) => record.active)?.label;
    const record = records.find((candidate) => candidate.label === label);
    if (record === undefined) {
      await providerFlowOf(profile, listed);
      return;
    }
    await savedAccount(profile, record);
  };

  const aliasChoice = (entry: MomongaModelEntry, current: string | undefined, targetHealth: Readonly<Record<string, TargetHealth>>, listed: PlanAccountsResponse): Choice => {
    const blocked = entry.targets.find((target) => entry.targetPlan?.[target] !== undefined && isSignInRequired(targetHealth[target]));
    const targets = entry.targets.map((target) => (targetHealth[target]?.ok === false ? `${target}: ${healthText(targetHealth[target])}` : target)).join(', ');
    return {
      row: { label: `${entry.id}${entry.id === current ? ' (current)' : ''} · ${targets}` },
      act: async () => {
        const plan = blocked === undefined ? undefined : entry.targetPlan?.[blocked];
        if (plan !== undefined) await targetSignIn(listed, plan);
        await ports.connected(entry.id);
      },
    };
  };

  const modelPicker = async (current: string | undefined): Promise<void> => {
    ports.loading('Models');
    const [entries, health, listed] = await Promise.all([backend.models(), backend.health(), backend.plan.accounts()]);
    const targeted = new Set(entries.flatMap((entry) => entry.targets));
    const signedIn = listed.accounts.filter((account) => account.state === 'active');
    const catalogs = await Promise.all(signedIn.map(async (account) => ({ account, profile: profileOf(listed.profiles, account.profile), catalog: await backend.plan.accountModels(account.label, { profile: account.profile }) })));
    const catalogChoices = catalogs.flatMap(({ account, profile, catalog }) =>
      catalog.models
        .filter((entry) => !targeted.has(entry.slug))
        .map((entry): Choice =>
          entry.usable
            ? {
                row: { label: `${entry.slug} · ${entry.displayName} · ${profile.messages.pickerLabel}` },
                act: async () => {
                  const created = await backend.plan.addTarget(account.label, { profile: profile.id, slug: entry.slug });
                  await ports.connected(created.alias);
                },
              }
            : { row: { label: `${entry.slug} · ${entry.reason} · ${profile.messages.pickerLabel}`, disabled: true }, act: async () => undefined },
        ),
    );
    const choices = [...entries.map((entry) => aliasChoice(entry, current, health.targets, listed)), ...catalogChoices];
    if (choices.length === 0) {
      ports.info('no model is available; use /login to connect one');
      return;
    }
    await chooseFrom({ title: 'Models', hint: 'up/down and enter to choose, esc to go back; a change applies from the next task' }, choices);
  };

  const welcome = async (profiles: readonly PlanProfileView[]): Promise<void> => {
    await chooseFrom({ title: 'Connect a model to start', hint: 'up/down and enter to choose, esc to go on to the prompt' }, [
      ...profiles.map((profile) => ({ row: { label: profile.loginLabel }, act: () => providerFlow(profile) })),
      { row: { label: USE_API_KEY }, act: apiKeyHelp },
      { row: { label: 'Use a local server' }, act: addLocalServer },
    ]);
  };

  const usageLimit = async (profile: PlanProfileView): Promise<void> => {
    await chooseFrom({}, [
      { row: { label: profile.messages.manageUsageLabel }, act: () => backend.openUrl(new URL(profile.usageUrl)) },
      { row: { label: 'Dismiss' }, act: async () => undefined },
    ]);
  };

  const planUseNotEnabled = async (profile: PlanProfileView, account: string): Promise<void> => {
    await chooseFrom({}, [
      { row: { label: `Enable ${profile.messages.identityLabel} plan use` }, act: () => sentence(profile, account, true) },
      { row: { label: USE_API_KEY }, act: apiKeyHelp },
    ]);
  };

  const notEligible = async (profile: PlanProfileView): Promise<void> => {
    await chooseFrom({}, [
      { row: { label: 'Use another account' }, act: () => providerFlow(profile) },
      { row: { label: USE_API_KEY }, act: apiKeyHelp },
      { row: { label: 'Dismiss' }, act: async () => undefined },
    ]);
  };

  return { login, logout, modelPicker, providerFlow, catalogPicker, welcome, usageLimit, planUseNotEnabled, notEligible };
};
