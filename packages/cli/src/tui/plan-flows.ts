import { PLAN_LABEL_REFUSAL, messageOf, SIGN_IN_REQUIRED_CODE, isPlanLabel, PLAN_DISABLED_STATE, RETRY_OUTCOME, SIGNED_IN_OUTCOME } from '@momonga/protocol';
import type { DetectedManagedServer, GatewayHealth, MomongaModelEntry, PlanAccountRef, PlanAccountView, PlanAccountsResponse, PlanProfileView, TargetHealth } from '@momonga/protocol';
import { displayMapOf } from '@momonga/protocol';
import { listingViewsOf } from '../client/gateway-client.ts';
import { isLocalServer, offeredServers } from '../commands/models.ts';
import { NO_SERVER_ANSWERED_TEXT } from '../models-texts.ts';
import { addBuiltIn, addFoundModel, addFromFound, builtInRowOf, foundNotConfigured, searchServers } from './models/add.ts';
import type { Added } from './models/add.ts';
import { openEdit } from './models/context.ts';
import type { FoundServers, ModelsFlowContext } from './models/context.ts';
import { modelListRows } from './models/model-list.ts';
import { writeStart } from './models/order.ts';
import { ADD_WITH_MODELS_ADD, ALSO_AT_START_LABEL, MODEL_CHANGE_NOTE, START_ONE_TEXT, configuredSwitchText, startingModelSetText } from './models/texts.ts';
import { couldNotOpenBrowser } from '../browser-text.ts';
import { SANDBOX_OFF_NOTICE, accountRowLabel, accountsOf, nextAccountLabel, profileOf, profileStateText, savedAccountAction } from '../plan/accounts.ts';
import { SignInAttemptNotFoundError, SignInExpiredError, SignInGatewayStoppedError, SignInListenerError, SignInListenerFailedError, signIn, waitForPaste } from '../plan/sign-in.ts';
import type { SignInShown } from '../plan/sign-in.ts';
import { codeNotAcceptedLine, listProblemLine, planDisabledLines, resumeLine, signedInLine, signedOutLines, tryAgainLine } from '../plan/texts.ts';
import type { TuiBackend } from './backend.ts';
import type { OverlayPorts, PickRow } from './picker.tsx';

export type PlanFlowPorts = OverlayPorts & {
  readonly backend: TuiBackend;
  info(text: string): void;
  toast(text: string): void;
  connected(model: string): Promise<void>;
  refreshConnection(): Promise<void>;
  signedIn(): Promise<void>;
  readonly found: FoundServers;
  readonly model: () => string | undefined;
  wait<T>(phase: string, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
};

export type PlanFlows = {
  login(args: string): Promise<void>;
  logout(): Promise<void>;
  modelPicker(current: string | undefined): Promise<void>;
  providerFlow(profile: PlanProfileView): Promise<void>;
  catalogPicker(profile: PlanProfileView, account: string): Promise<void>;
  welcome(profiles: readonly PlanProfileView[]): Promise<void>;
  usageLimit(profile: PlanProfileView): Promise<void>;
  planUseNotEnabled(profile: PlanProfileView, account: string | undefined): Promise<void>;
  notEligible(profile: PlanProfileView): Promise<void>;
};

type Choice = { row: PickRow; act(): Promise<void> };

const API_KEY_HELP = [
  'MomongaCode takes an API key in one of two ways:',
  '  it is saved in the system secret store, or',
  '  it stays in an environment variable whose name you give.',
  ADD_WITH_MODELS_ADD,
].join('\n');

const USE_API_KEY = 'Use an API key';

const SANDBOX_OFF_ROWS = [{ label: 'Continue' }, { label: 'Cancel' }] as const;
const SANDBOX_OFF_CONTINUE = 0;
const SANDBOX_OFF_CANCEL = 1;

const healthText = (health: TargetHealth | undefined): string => {
  if (health === undefined) return 'health unknown';
  if (health.ok) return 'ready';
  return health.reason ?? 'not ready';
};

const isSignInRequired = (health: TargetHealth | undefined): boolean => health?.reason === SIGN_IN_REQUIRED_CODE;

export const createPlanFlows = (ports: PlanFlowPorts): PlanFlows => {
  const { backend } = ports;

  const flowContext = (): ModelsFlowContext => ({
    backend,
    overlays: { choose: ports.choose, promptText: ports.promptText },
    found: ports.found,
    model: ports.model(),
    info: ports.info,
    wait: ports.wait,
  });

  const connectAdded = async (added: Added | undefined): Promise<void> => {
    if (added?.model !== undefined) await ports.connected(added.model);
  };

  const chooseFrom = async (request: { title?: string; lines?: readonly string[] }, choices: readonly Choice[]): Promise<boolean> => {
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
                await ports.connected(created.model);
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
    return (await ports.pick({ title: 'The sandbox is off', lines: SANDBOX_OFF_NOTICE, rows: SANDBOX_OFF_ROWS, initial: SANDBOX_OFF_CANCEL, decideOn: 'enter', escape: SANDBOX_OFF_CANCEL })) === SANDBOX_OFF_CONTINUE;
  };

  const signInFlow = async (profile: PlanProfileView, account: string, reconsent: boolean): Promise<void> => {
    if (!(await sandboxAccepted())) return;
    const cancel = new AbortController();
    let deliver: (text: string) => void = () => undefined;
    const deliveries = new Promise<string>((resolve) => {
      deliver = resolve;
    });
    const handlers = { cancel: () => cancel.abort(), deliver: (text: string) => deliver(text) };
    const authorize = async ({ url, state }: SignInShown, waiting: AbortSignal): Promise<void> => {
      const lines = ['Open this URL in your browser if it does not open by itself:', url.href];
      ports.waiting({ title: profile.loginLabel, lines, url, state }, handlers);
      backend.openUrl(url, waiting, (message) => {
        ports.waiting({ title: profile.loginLabel, lines: [...lines, `${couldNotOpenBrowser(message)} Copy the URL and continue manually.`], url, state }, handlers);
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
          delivered: () => ports.delivered(),
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
        ports.info(`${error.message} ${tryAgainLine('tui', { profile: profile.id, account })}`);
        return;
      }
      throw error;
    } finally {
      ports.closeWaiting();
    }
    switch (answer.outcome) {
      case RETRY_OUTCOME:
        ports.info(codeNotAcceptedLine('tui', profile, account));
        await sentence(profile, account, reconsent);
        return;
      case PLAN_DISABLED_STATE:
        for (const line of planDisabledLines('tui', profile, account)) ports.info(line);
        await sentence(profile, account, true);
        return;
      case SIGNED_IN_OUTCOME:
        ports.info(signedInLine(answer.account));
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
        await sentence(profile, account.label, account.state === PLAN_DISABLED_STATE);
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
        if (!isPlanLabel(text)) return PLAN_LABEL_REFUSAL;
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
            const answer = await backend.plan.resume(account.label, { profile: profile.id });
            ports.info(resumeLine(account.label, answer.resumed));
          },
        })),
      { row: { label: 'Add another account or workspace' }, act: () => newAccount(profile, listed) },
    ]);
  };

  const providerFlowOf = async (profile: PlanProfileView, listed: PlanAccountsResponse): Promise<void> => {
    for (const problem of listed.listProblems ?? []) ports.info(listProblemLine(problem));
    if (accountsOf(profile.id, listed.accounts).length === 0) {
      await sentence(profile, nextAccountLabel(profile.id, listed.accounts), false);
      return;
    }
    await accountPicker(profile, listed);
  };

  const providerFlow = async (profile: PlanProfileView): Promise<void> => providerFlowOf(profile, await backend.plan.accounts());

  const managedChoice = (server: DetectedManagedServer): Choice => {
    if (server.refused !== undefined) {
      const remedy = server.refused.remedy === undefined ? '' : ` (${server.refused.remedy})`;
      return { row: { label: `${builtInRowOf(server.id)} · ${server.refused.message}${remedy}`, disabled: true }, act: async () => undefined };
    }
    return { row: { label: builtInRowOf(server.id) }, act: async () => connectAdded(await addBuiltIn(flowContext(), server.id)) };
  };

  const addLocalServer = async (): Promise<void> => {
    const context = flowContext();
    const found = await searchServers(context, []);
    if (found === undefined) return;
    const servers = offeredServers(found);
    const managed = found.filter((server): server is DetectedManagedServer => !isLocalServer(server));
    if (servers.length === 0 && managed.length === 0) {
      ports.info(`${NO_SERVER_ANSWERED_TEXT} ${START_ONE_TEXT}`);
      return;
    }
    if (managed.length === 0) {
      await connectAdded(await addFromFound(context, servers));
      return;
    }
    await chooseFrom({ title: 'Local model servers' }, [
      ...(servers.length === 0 ? [] : [{ row: { label: 'A model server that answered' }, act: async () => connectAdded(await addFromFound(context, servers)) }]),
      ...managed.map(managedChoice),
    ]);
  };

  const login = async (args: string): Promise<void> => {
    ports.loading('Connect a model');
    const listed = await backend.plan.accounts();
    if (args !== '') {
      await providerFlowOf(profileOf(listed.profiles, args), listed);
      return;
    }
    const [entries, health] = await Promise.all([backend.models(), backend.health()]);
    const displays = displayMapOf(listingViewsOf(entries));
    const local = entries.filter((entry) => entry.billing === 'local');
    await chooseFrom({ title: 'Connect a model' }, [
      ...listed.profiles.map((profile) => ({ row: { label: `${profile.messages.pickerLabel} [subscription] · ${profileStateText(profile, listed.accounts)}` }, act: () => providerFlowOf(profile, listed) })),
      { row: { label: 'Add an API key' }, act: apiKeyHelp },
      ...local.map((entry) => {
        const display = displays.get(entry.id) ?? entry.id;
        return { row: { label: `${display} [local server] · ${healthText(health.models[entry.id])}` }, act: async () => ports.info(configuredSwitchText(display)) };
      }),
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
    const index = await ports.pick({ title: 'Sign out', rows: listed.accounts.map((account) => ({ label: accountRowLabel(account) })), confirm: (row, decideKey) => `press ${decideKey} again to sign out ${row.label}` });
    const chosen = index === undefined ? undefined : listed.accounts[index];
    if (chosen === undefined) return;
    const report = await backend.plan.signOut({ profile: chosen.profile, account: chosen.label });
    const profile = profileOf(listed.profiles, chosen.profile);
    for (const line of signedOutLines(profile, chosen.label, report)) ports.info(line);
  };

  const targetSignIn = async (listed: PlanAccountsResponse, plan: PlanAccountRef): Promise<void> => {
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

  const blockedPlanOf = (entry: MomongaModelEntry, health: GatewayHealth): { profile: string; account?: string } | undefined =>
    entry.chain.find((member) => member.plan !== undefined && isSignInRequired(health.models[member.model]))?.plan;

  const useConfigured = async (entry: MomongaModelEntry, health: GatewayHealth, listed: PlanAccountsResponse, atStart: boolean, display: string): Promise<void> => {
    const plan = blockedPlanOf(entry, health);
    if (plan !== undefined) await targetSignIn(listed, plan);
    await ports.connected(entry.id);
    if (!atStart) return;
    await writeStart(flowContext(), entry.id);
    ports.toast(startingModelSetText(display));
  };

  const modelPicker = async (current: string | undefined): Promise<void> => {
    ports.loading('Models');
    const context = flowContext();
    const [listing, health, listed] = await Promise.all([backend.modelList(), backend.health(), backend.plan.accounts()]);
    const entries = listing.data;
    const served = new Set(entries.flatMap((entry) => entry.chain.map((member) => member.upstream)));
    const signedIn = listed.accounts.filter((account) => account.state === 'active');
    const catalogs = await Promise.all(signedIn.map(async (account) => ({ account, profile: profileOf(listed.profiles, account.profile), catalog: await backend.plan.accountModels(account.label, { profile: account.profile }) })));
    const catalogChoices = catalogs.flatMap(({ account, profile, catalog }) =>
      catalog.models
        .filter((entry) => !served.has(entry.slug))
        .map((entry): Choice =>
          entry.usable
            ? {
                row: { label: `${entry.slug} · ${entry.displayName} · ${profile.messages.pickerLabel}` },
                act: async () => {
                  const created = await backend.plan.addTarget(account.label, { profile: profile.id, slug: entry.slug });
                  await ports.connected(created.model);
                },
              }
            : { row: { label: `${entry.slug} · ${entry.reason} · ${profile.messages.pickerLabel}`, disabled: true }, act: async () => undefined },
        ),
    );
    const remembered = ports.found.servers();
    const opened = remembered.length === 0 ? undefined : await openEdit(context);
    const found = opened === undefined ? [] : foundNotConfigured(opened.edit, remembered);
    const { rows, listed: listedRows } = modelListRows({ listing, current, health, found });
    if (rows.length + catalogChoices.length === 0) {
      ports.info(messageOf('noModelConnected', 'tui'));
      return;
    }
    const displays = displayMapOf(listingViewsOf(entries));
    const choice = await ports.choose({ title: 'Models', lines: [MODEL_CHANGE_NOTE], rows: [...rows, ...catalogChoices.map((entry) => entry.row)], alt: { label: ALSO_AT_START_LABEL } });
    if (choice === undefined) return;
    const row = listedRows[choice.index];
    if (row === undefined) {
      await catalogChoices[choice.index - listedRows.length]?.act();
      return;
    }
    if (row.kind === 'configured') await useConfigured(row.entry, health, listed, choice.alt, displays.get(row.entry.id) ?? row.entry.id);
    if (row.kind === 'found' && opened !== undefined) await connectAdded(await addFoundModel(context, opened, row.found.server, row.found.model, row.found.display));
  };

  const welcome = async (profiles: readonly PlanProfileView[]): Promise<void> => {
    await chooseFrom({ title: 'Connect a model to start' }, [
      ...profiles.map((profile) => ({ row: { label: profile.loginLabel }, act: () => providerFlow(profile) })),
      { row: { label: USE_API_KEY }, act: apiKeyHelp },
      { row: { label: 'Use a local server' }, act: addLocalServer },
    ]);
  };

  const usageLimit = async (profile: PlanProfileView): Promise<void> => {
    await chooseFrom({}, [
      { row: { label: profile.messages.manageUsageLabel }, act: async () =>
          backend.openUrl(new URL(profile.usageUrl), undefined, (message) => ports.info(`${couldNotOpenBrowser(message)} ${profile.messages.manageUsageLabel}: ${profile.usageUrl}`)),
      },
      { row: { label: 'Dismiss' }, act: async () => undefined },
    ]);
  };

  const planUseNotEnabled = async (profile: PlanProfileView, account: string | undefined): Promise<void> => {
    await chooseFrom({}, [
      { row: { label: `Enable ${profile.messages.identityLabel} plan use` }, act: () => (account === undefined ? providerFlow(profile) : sentence(profile, account, true)) },
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
