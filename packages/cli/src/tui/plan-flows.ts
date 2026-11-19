import { isReasoningEffort, PLAN_LABEL_REFUSAL, messageOf, SIGN_IN_REQUIRED_CODE, isPlanLabel, PLAN_DISABLED_STATE, RETRY_OUTCOME, SIGNED_IN_OUTCOME, IDENTITY_UNCONFIRMED_OUTCOME } from '@momonga/protocol';
import type { ReasoningEffort, DetectedManagedServer, GatewayHealth, MomongaModelEntry, PlanAccountRef, PlanAccountView, PlanAccountsResponse, PlanModelsResponse, PlanProfileView, PlanSignInCompleteResponse, PlanSignInIdentity, TargetHealth } from '@momonga/protocol';
import { displayMapOf } from '@momonga/protocol';
import { GatewayAnswerError, listingViewsOf } from '../client/gateway-client.ts';
import { isLocalServer, offeredServers } from '../commands/models.ts';
import { NO_SERVER_ANSWERED_TEXT } from '../models-texts.ts';
import { addBuiltIn, addFoundModel, addFromFound, addService, builtInRowOf, foundNotConfigured, searchServers } from './models/add.ts';
import type { Added } from './models/add.ts';
import { openEdit } from './models/context.ts';
import type { FoundServers, ModelsFlowContext } from './models/context.ts';
import { modelListRows } from './models/model-list.ts';
import { writeStart } from './models/order.ts';
import { effortAnswerText, writeModelEffort } from './commands/effort.ts';
import { ALSO_AT_START_LABEL, MODEL_CHANGE_NOTE, START_ONE_TEXT, configuredSwitchText, startingModelSetText } from './models/texts.ts';
import { couldNotOpenBrowser } from '../browser-text.ts';
import { SANDBOX_OFF_NOTICE, accountRowLabel, accountsOf, nextAccountLabel, profileOf, profileStateText, savedAccountAction } from '../plan/accounts.ts';
import { SignInListenerError, SignInListenerFailedError, SignInNotFinishedError, signIn, waitForPaste } from '../plan/sign-in.ts';
import type { SignInShown } from '../plan/sign-in.ts';
import { NO_ACCOUNT_SAVED_TEXT, IDENTITY_CANCEL, IDENTITY_CHOICES, IDENTITY_SAVE, SIGN_IN_WORD, cancelledText, catalogUnreadHint, codeNotAcceptedLine, identityNotConfirmedLine, identityQuestion, listProblemLine, planDisabledLines, recordUnreadableLine, resumeLine, signInFailureLine, signedInLine, signedOutLines } from '../plan/texts.ts';
import type { TuiBackend } from './backend.ts';
import type { OverlayPorts, PickRow } from './picker.tsx';
import { NOT_NOW_LABEL, invitationKeyOf } from './screen/menu.tsx';

export type PlanFlowPorts = OverlayPorts & {
  readonly backend: TuiBackend;
  info(text: string): void;
  failed(text: string): void;
  toast(text: string): void;
  connected(model: string, effort?: ReasoningEffort): Promise<void>;
  readonly effort: () => ReasoningEffort | undefined;
  refreshConnection(): Promise<void>;
  signedIn(): Promise<void>;
  readonly found: FoundServers;
  readonly model: () => string | undefined;
  wait<T>(phase: string, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  invitationAnswered(): void;
  untilNextKey(): AbortSignal;
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

const AGAIN = 'again';
type Acted = typeof AGAIN | undefined;
type Choice = { row: PickRow; act(): Promise<Acted | void> };

const USE_API_KEY = 'Use an API key';
const CONNECT_TITLE = 'Connect a model';

const SANDBOX_OFF_ROWS = [{ label: 'Continue' }, { label: 'Cancel' }] as const;
const SANDBOX_OFF_CONTINUE = 0;
const SANDBOX_OFF_CANCEL = 1;

const healthText = (health: TargetHealth | undefined): string => {
  if (health === undefined) return 'health unknown';
  if (health.ok) return 'ready';
  return health.reason ?? 'not ready';
};

const isSignInRequired = (health: TargetHealth | undefined): boolean => health?.reason === SIGN_IN_REQUIRED_CODE;

const CHANGE_EFFORT_LABEL = 'change the effort';

const changedEffortOf = (row: PickRow | undefined, step: number | undefined): ReasoningEffort | undefined => {
  const steps = row?.steps;
  if (steps === undefined || step === undefined || step === steps.at) return undefined;
  const level = steps.values[step];
  return isReasoningEffort(level) ? level : undefined;
};

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
    for (;;) {
      const index = await ports.pick({ ...request, rows: choices.map((choice) => choice.row) });
      const chosen = index === undefined ? undefined : choices[index];
      if (chosen === undefined) return false;
      if ((await chosen.act()) !== AGAIN) return true;
    }
  };

  const addApiKey = async (): Promise<void> => {
    await connectAdded(await addService(flowContext()));
  };

  const catalogPicker = async (profile: PlanProfileView, account: string): Promise<void> => {
    let catalog: PlanModelsResponse;
    try {
      catalog = await backend.plan.accountModels(account, { profile: profile.id });
    } catch (error) {
      if (!(error instanceof GatewayAnswerError)) throw error;
      ports.failed(error.message);
      ports.info(catalogUnreadHint(profile.id, account));
      return;
    }
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
    const serves = (await backend.models()).some((entry) =>
      entry.chain.some((member) => member.plan !== undefined && member.plan.profile === profile.id && (member.plan.account === undefined ? account.active : member.plan.account === account.label)),
    );
    if (account.pinnedBy.length === 0 && !serves) {
      await catalogPicker(profile, account.label);
      return;
    }
    await ports.refreshConnection();
  };

  const sandboxAccepted = async (): Promise<boolean> => {
    if ((await backend.sandbox()) !== 'none') return true;
    return (await ports.pick({ title: 'The sandbox is off', lines: SANDBOX_OFF_NOTICE, rows: SANDBOX_OFF_ROWS, initial: SANDBOX_OFF_CANCEL, decideOn: 'enter', escape: SANDBOX_OFF_CANCEL })) === SANDBOX_OFF_CONTINUE;
  };

  const signInRow = (profile: PlanProfileView, label: string): PickRow => ({ label, opensBrowser: true, description: profile.messages.description });

  const signInFlow = async (profile: PlanProfileView, account: string, reconsent: boolean): Promise<Acted> => {
    if (!(await sandboxAccepted())) return undefined;
    const cancel = new AbortController();
    let deliver: (text: string) => void = () => undefined;
    const deliveries = new Promise<string>((resolve) => {
      deliver = resolve;
    });
    const handlers = { cancel: () => cancel.abort(), deliver: (text: string) => deliver(text) };
    const authorize = async ({ url, state }: SignInShown, waiting: AbortSignal): Promise<void> => {
      const lines = [profile.messages.description, 'Open this URL in your browser if it does not open by itself:', url.href];
      ports.waiting({ title: profile.loginLabel, lines, url, state }, handlers);
      backend.openUrl(url, waiting, (message) => {
        ports.waiting({ title: profile.loginLabel, lines: [...lines, `${couldNotOpenBrowser(message)} Copy the URL and continue manually.`], url, state }, handlers);
      });
    };
    const confirmIdentity = async (identity: PlanSignInIdentity, waiting: AbortSignal): Promise<boolean> => {
      const chosen = await ports.pick({
        title: profile.loginLabel,
        lines: [identityQuestion('tui', profile, account, identity)],
        rows: IDENTITY_CHOICES.map((label) => ({ label })),
        initial: IDENTITY_CANCEL,
        decideOn: 'enter',
        escape: IDENTITY_CANCEL,
      });
      waiting.throwIfAborted();
      return chosen === IDENTITY_SAVE;
    };
    let answer: PlanSignInCompleteResponse;
    try {
      answer = await signIn(
        {
          plan: backend.plan,
          startListener: backend.startSignInListener,
          authorize,
          pasted: (_state, signal) => waitForPaste(deliveries, signal),
          confirmIdentity,
          signal: cancel.signal,
          timers: backend.signInTimers,
          delivered: () => ports.delivered(),
          warn: (text) => ports.info(text),
        },
        { profile: profile.id, account, reconsent },
      );
    } catch (error) {
      if (cancel.signal.aborted && error === cancel.signal.reason) {
        ports.info(cancelledText(SIGN_IN_WORD));
        return AGAIN;
      }
      if (error instanceof SignInListenerError || error instanceof SignInListenerFailedError) {
        ports.failed(error.message);
        return undefined;
      }
      if (error instanceof SignInNotFinishedError) {
        ports.failed(signInFailureLine('tui', { profile: profile.id, account }, error));
        return undefined;
      }
      throw error;
    } finally {
      ports.closeWaiting();
    }
    switch (answer.outcome) {
      case RETRY_OUTCOME:
        ports.failed(codeNotAcceptedLine('tui', profile, account));
        return AGAIN;
      case IDENTITY_UNCONFIRMED_OUTCOME:
        ports.info(identityNotConfirmedLine('tui', { profile: profile.id, account }, answer.identity));
        return undefined;
      case PLAN_DISABLED_STATE:
        for (const line of planDisabledLines('tui', profile, answer.account.label)) ports.info(line);
        await planUseNotEnabled(profile, answer.account.label);
        return undefined;
      case SIGNED_IN_OUTCOME:
        ports.info(signedInLine(answer.account));
        try {
          await afterSignIn(profile, answer.account, answer.firstSignIn);
        } finally {
          await ports.signedIn();
        }
        return undefined;
    }
  };

  const savedAccount = async (profile: PlanProfileView, account: PlanAccountView): Promise<Acted> => {
    switch (savedAccountAction(account)) {
      case 'activate':
        await backend.plan.setActive({ profile: profile.id, account: account.label });
        ports.info(`${profile.messages.identityLabel}: using ${account.label}`);
        await ports.refreshConnection();
        return undefined;
      case 'sign-in':
        return signInFlow(profile, account.label, account.state === PLAN_DISABLED_STATE);
      case 'replace':
        ports.info(recordUnreadableLine('tui', account));
        return signInFlow(profile, account.label, false);
      case 'none':
        ports.info(`${accountRowLabel(account)}${account.cause === undefined ? '' : `: ${account.cause}`}`);
        return undefined;
    }
  };

  const newAccount = async (profile: PlanProfileView, listed: PlanAccountsResponse): Promise<Acted> => {
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
    if (label === undefined) return AGAIN;
    return signInFlow(profile, label, false);
  };

  const accountPicker = async (profile: PlanProfileView, listed: PlanAccountsResponse): Promise<void> => {
    const records = accountsOf(profile.id, listed.accounts);
    await chooseFrom({ title: profile.messages.pickerLabel }, [
      ...records.map((account) => {
        const label = `${accountRowLabel(account)}${account.active ? ' (current)' : ''}`;
        const action = savedAccountAction(account);
        return { row: action === 'sign-in' || action === 'replace' ? signInRow(profile, label) : { label }, act: () => savedAccount(profile, account) };
      }),
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

  const providerFlowOf = async (profile: PlanProfileView, listed: PlanAccountsResponse): Promise<Acted> => {
    for (const problem of listed.listProblems ?? []) ports.info(listProblemLine(problem));
    if (accountsOf(profile.id, listed.accounts).length === 0) return signInFlow(profile, nextAccountLabel(profile.id, listed.accounts), false);
    await accountPicker(profile, listed);
    return undefined;
  };

  const providerFlow = async (profile: PlanProfileView): Promise<void> => {
    await providerFlowOf(profile, await backend.plan.accounts());
  };

  const managedChoice = (server: DetectedManagedServer): Choice => {
    if (server.refused !== undefined) {
      const remedy = server.refused.remedy === undefined ? '' : ` (${server.refused.remedy})`;
      return { row: { label: `${builtInRowOf(server)} · ${server.refused.message}${remedy}`, disabled: true }, act: async () => undefined };
    }
    return { row: { label: builtInRowOf(server) }, act: async () => connectAdded(await addBuiltIn(flowContext(), server.id)) };
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

  const invitedProfiles = (listed: PlanAccountsResponse, dismissed: Readonly<Record<string, unknown>>): PlanProfileView[] =>
    listed.profiles.filter((profile) => accountsOf(profile.id, listed.accounts).length === 0 && !Object.hasOwn(dismissed, invitationKeyOf(profile.id)));

  const answerNotNow = async (invited: readonly PlanProfileView[]): Promise<void> => {
    for (const profile of invited) await backend.dismissNotice(invitationKeyOf(profile.id));
    ports.invitationAnswered();
  };

  const login = async (args: string): Promise<void> => {
    if (args !== '') {
      const read = await ports.loading(CONNECT_TITLE, () => backend.plan.accounts());
      if (read.kind === 'read') await providerFlowOf(profileOf(read.value.profiles, args), read.value);
      return;
    }
    const read = await ports.loading(CONNECT_TITLE, () => Promise.all([backend.plan.accounts(), backend.models(), backend.health(), backend.dismissedNotices()]));
    if (read.kind === 'cancelled') return;
    const [listed, entries, health, dismissed] = read.value;
    const invited = invitedProfiles(listed, dismissed);
    const displays = displayMapOf(listingViewsOf(entries));
    const local = entries.filter((entry) => entry.billing === 'local');
    await chooseFrom({ title: CONNECT_TITLE }, [
      ...listed.profiles.map((profile) => {
        const label = `${profile.messages.pickerLabel} [subscription] · ${profileStateText(profile, listed.accounts)}`;
        return { row: accountsOf(profile.id, listed.accounts).length === 0 ? signInRow(profile, label) : { label }, act: () => providerFlowOf(profile, listed) };
      }),
      { row: { label: 'Add an API key' }, act: addApiKey },
      ...local.map((entry) => {
        const display = displays.get(entry.id) ?? entry.id;
        return { row: { label: `${display} [local server] · ${healthText(health.models[entry.id])}` }, act: async () => ports.info(configuredSwitchText(display)) };
      }),
      { row: { label: 'Add a local server' }, act: addLocalServer },
      ...(invited.length === 0 ? [] : [{ row: { label: NOT_NOW_LABEL }, act: () => answerNotNow(invited) }]),
    ]);
  };

  const logout = async (): Promise<void> => {
    const read = await ports.loading('Sign out', () => backend.plan.accounts());
    if (read.kind === 'cancelled') return;
    const listed = read.value;
    if (listed.accounts.length === 0) {
      ports.info(NO_ACCOUNT_SAVED_TEXT);
      return;
    }
    const index = await ports.pick({ title: 'Sign out', rows: listed.accounts.map((account) => ({ label: accountRowLabel(account) })), confirm: (row, decideKey) => `press ${decideKey} again to sign out ${row.label}` });
    const chosen = index === undefined ? undefined : listed.accounts[index];
    if (chosen === undefined) return;
    const report = await backend.plan.signOut({ profile: chosen.profile, account: chosen.label });
    const profile = profileOf(listed.profiles, chosen.profile);
    for (const line of signedOutLines(profile, chosen.label, report)) ports.info(line);
  };

  const targetSignIn = async (listed: PlanAccountsResponse, plan: PlanAccountRef): Promise<Acted> => {
    const profile = profileOf(listed.profiles, plan.profile);
    const records = accountsOf(profile.id, listed.accounts);
    const label = plan.account ?? records.find((record) => record.active)?.label;
    const record = records.find((candidate) => candidate.label === label);
    if (record === undefined) return providerFlowOf(profile, listed);
    return savedAccount(profile, record);
  };

  const blockedPlanOf = (entry: MomongaModelEntry, health: GatewayHealth): { profile: string; account?: string } | undefined =>
    entry.chain.find((member) => member.plan !== undefined && isSignInRequired(health.models[member.model]))?.plan;

  const useConfigured = async (entry: MomongaModelEntry, health: GatewayHealth, listed: PlanAccountsResponse, atStart: boolean, display: string, effort: ReasoningEffort | undefined): Promise<void> => {
    const plan = blockedPlanOf(entry, health);
    if (plan !== undefined) await targetSignIn(listed, plan);
    if (effort !== undefined) await writeModelEffort(flowContext(), entry.id, effort);
    await ports.connected(entry.id, effort);
    if (effort !== undefined) ports.info(effortAnswerText(effort, display, 'saved'));
    if (!atStart) return;
    await writeStart(flowContext(), entry.id);
    ports.toast(startingModelSetText(display));
  };

  const catalogNotCurrent = (account: string, reason: string): string => `the list of models of ${account} is not current: ${reason}`;

  const modelPicker = async (current: string | undefined): Promise<void> => {
    const context = flowContext();
    const read = await ports.loading('Models', async () => {
      const [readListing, readHealth, readListed] = await Promise.all([backend.modelList(), backend.health(), backend.plan.accounts()]);
      const signedIn = readListed.accounts.filter((account) => account.state === 'active');
      const readCatalogs = await Promise.all(
        signedIn.map(async (account) => {
          const profile = profileOf(readListed.profiles, account.profile);
          try {
            return { kind: 'read' as const, account, profile, catalog: await backend.plan.accountModels(account.label, { profile: account.profile }) };
          } catch (error) {
            return { kind: 'unread' as const, account, reason: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
      const remembered = ports.found.servers();
      return { listing: readListing, health: readHealth, listed: readListed, catalogs: readCatalogs, remembered, opened: remembered.length === 0 ? undefined : await openEdit(context) };
    });
    if (read.kind === 'cancelled') return;
    const { listing, health, listed, catalogs, remembered, opened } = read.value;
    const entries = listing.data;
    const served = new Set(entries.flatMap((entry) => entry.chain.map((member) => member.upstream)));
    const catalogChoices = catalogs.flatMap((read) => {
      if (read.kind === 'unread') return [{ row: { label: catalogNotCurrent(read.account.label, read.reason), disabled: true }, act: async () => undefined }];
      const { account, profile, catalog } = read;
      return catalog.models
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
        );
    });
    const found = opened === undefined ? [] : foundNotConfigured(opened.edit, remembered);
    const { rows, listed: listedRows } = modelListRows({ listing, current, effort: ports.effort(), health, found });
    if (rows.length + catalogChoices.length === 0) {
      ports.info(messageOf('noModelConnected', 'tui'));
      return;
    }
    const displays = displayMapOf(listingViewsOf(entries));
    const allRows = [...rows, ...catalogChoices.map((entry) => entry.row)];
    const choice = await ports.choose({ title: 'Models', lines: [MODEL_CHANGE_NOTE], rows: allRows, alt: { label: ALSO_AT_START_LABEL }, ...(rows.some((row) => row.steps !== undefined) ? { stepsLabel: CHANGE_EFFORT_LABEL } : {}) });
    if (choice === undefined) return;
    const row = listedRows[choice.index];
    if (row === undefined) {
      await catalogChoices[choice.index - listedRows.length]?.act();
      return;
    }
    if (row.kind === 'configured') await useConfigured(row.entry, health, listed, choice.alt, displays.get(row.entry.id) ?? row.entry.id, changedEffortOf(allRows[choice.index], choice.step));
    if (row.kind === 'found' && opened !== undefined) await connectAdded(await addFoundModel(context, opened, row.found.server, row.found.model, row.found.display));
  };

  const welcome = async (profiles: readonly PlanProfileView[]): Promise<void> => {
    await chooseFrom({ title: 'Connect a model to start' }, [
      ...profiles.map((profile) => ({ row: signInRow(profile, profile.loginLabel), act: async () => providerFlowOf(profile, await backend.plan.accounts()) })),
      { row: { label: USE_API_KEY }, act: addApiKey },
      { row: { label: 'Use a local server' }, act: addLocalServer },
    ]);
  };

  const usageLimit = async (profile: PlanProfileView): Promise<void> => {
    await chooseFrom({}, [
      { row: { label: profile.messages.manageUsageLabel, opensBrowser: true }, act: async () =>
          backend.openUrl(new URL(profile.usageUrl), ports.untilNextKey(), (message) => ports.info(`${couldNotOpenBrowser(message)} ${profile.messages.manageUsageLabel}: ${profile.usageUrl}`)),
      },
      { row: { label: 'Dismiss' }, act: async () => undefined },
    ]);
  };

  const planUseNotEnabled = async (profile: PlanProfileView, account: string | undefined): Promise<void> => {
    await chooseFrom({}, [
      { row: signInRow(profile, `Enable ${profile.messages.identityLabel} plan use`), act: async () => (account === undefined ? providerFlowOf(profile, await backend.plan.accounts()) : signInFlow(profile, account, true)) },
      { row: { label: USE_API_KEY }, act: addApiKey },
    ]);
  };

  const notEligible = async (profile: PlanProfileView): Promise<void> => {
    await chooseFrom({}, [
      { row: { label: 'Use another account' }, act: () => providerFlow(profile) },
      { row: { label: USE_API_KEY }, act: addApiKey },
      { row: { label: 'Dismiss' }, act: async () => undefined },
    ]);
  };

  return { login, logout, modelPicker, providerFlow, catalogPicker, welcome, usageLimit, planUseNotEnabled, notEligible };
};
