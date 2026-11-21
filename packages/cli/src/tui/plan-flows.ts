import { agentReadiness, MODEL_SETTINGS_ROW, PLAN_LABEL_REFUSAL, messageOf, SIGN_IN_REQUIRED_CODE, isPlanLabel, PLAN_DISABLED_STATE, RETRY_OUTCOME, SIGNED_IN_OUTCOME, IDENTITY_UNCONFIRMED_OUTCOME } from '@momonga/protocol';
import type { ReasoningEffort, DetectedManagedServer, GatewayHealth, MomongaModelEntry, PlanAccountRef, PlanAccountView, PlanAccountsResponse, PlanModelsResponse, PlanProfileView, PlanSignInCompleteResponse, PlanSignInIdentity, TargetHealth } from '@momonga/protocol';
import { displayMapOf } from '@momonga/protocol';
import { GatewayAnswerError, listingViewsOf } from '../client/gateway-client.ts';
import { isLocalServer, offeredServers } from '../commands/models.ts';
import { NO_SERVER_ANSWERED_TEXT } from '../models-texts.ts';
import { addBuiltIn, addFoundModel, addFromFound, addService, builtInRowOf, foundNotConfigured, searchServers } from './models/add.ts';
import type { Added } from './models/add.ts';
import { openEdit } from './models/context.ts';
import type { FoundServers, ModelsFlowContext } from './models/context.ts';
import { planServesAccount } from './models/plan-account.ts';
import { accountConnectionOf, repointAccountConnections, runModelsHub, runRemoveServingConnection, runServerActions } from './models/hub.ts';
import { modelListRows } from './models/model-list.ts';
import type { PlanListRow } from './models/model-list.ts';
import { planProfileOf } from '@momonga/config';
import { writeStart } from './models/order.ts';
import { chooseEffort, writeModelEffort } from './commands/effort.ts';
import { acceptedEffortsOf, declaredReasoning, sentEffort } from './effort.ts';
import { followMeasurement, modelUnreadText, notReadyNoticeOf } from '../readiness.ts';
import type { MeasurementPorts } from '../readiness.ts';
import { ALSO_AT_START_LABEL, MODEL_CHANGE_NOTE, START_ONE_TEXT, startingModelSetText } from './models/texts.ts';
import { couldNotOpenBrowser } from '../browser-text.ts';
import { SANDBOX_OFF_NOTICE, accountRowLabel, accountsOf, nextAccountLabel, profileOf, profileStateText, savedAccountAction } from '../plan/accounts.ts';
import { SignInListenerError, SignInListenerFailedError, SignInNotFinishedError, signIn, waitForPaste } from '../plan/sign-in.ts';
import type { SignInShown } from '../plan/sign-in.ts';
import { NO_ACCOUNT_SAVED_TEXT, IDENTITY_CANCEL, IDENTITY_CHOICES, IDENTITY_SAVE, SIGN_IN_WORD, accountInUseLine, accountNotSessionModelLine, cancelledText, catalogUnreadHint, codeNotAcceptedLine, identityNotConfirmedLine, identityQuestion, listProblemLine, planDisabledLines, recordUnreadableLine, resumeLine, signInFailureLine, signedInLine, signedOutLines } from '../plan/texts.ts';
import type { TuiBackend } from './backend.ts';
import { LOADING_HINTS } from './picker.tsx';
import type { OverlayPorts, PickRequest, PickRow, PickUpdate } from './picker.tsx';
import { Abandoned, chooseThen, currentStep, runInStep } from './flow-step.ts';
import { NOT_NOW_LABEL, invitationKeyOf } from './screen/menu.tsx';

export type PlanFlowPorts = OverlayPorts & {
  readonly backend: TuiBackend;
  info(text: string): void;
  failed(text: string): void;
  warn(text: string): void;
  toast(text: string): void;
  connected(model: string): Promise<void>;
  switchedThen(model: string, effort: ReasoningEffort | undefined, then: () => Promise<void>): Promise<void>;
  readonly effort: () => ReasoningEffort | undefined;
  setEffort(effort: ReasoningEffort | null): Promise<void>;
  shownModel(model: string): string;
  readonly timers: MeasurementPorts['timers'];
  refreshConnection(): Promise<void>;
  signedIn(): Promise<void>;
  readonly found: FoundServers;
  readonly model: () => string | undefined;
  wait<T>(phase: string, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  cancellable?<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  invitationAnswered(): void;
  untilNextKey(): AbortSignal;
};

export type PlanFlows = {
  login(args: string): Promise<void>;
  logout(): Promise<void>;
  modelPicker(current: string | undefined): Promise<void>;
  providerFlow(profile: PlanProfileView): Promise<void>;
  catalogPicker(profile: PlanProfileView, account: string): Promise<boolean>;
  welcome(profiles: readonly PlanProfileView[]): Promise<void>;
  usageLimit(profile: PlanProfileView): Promise<void>;
  planUseNotEnabled(profile: PlanProfileView, account: string | undefined): Promise<void>;
  notEligible(profile: PlanProfileView): Promise<void>;
};

const AGAIN = 'again';
type ModelChosen = { readonly backTo: string } | undefined;
type ChosenRead = { readonly kind: 'read'; readonly entries: readonly MomongaModelEntry[]; readonly entry: MomongaModelEntry | undefined } | { readonly kind: 'cancelled' } | { readonly kind: 'failed'; readonly error: unknown };
type Measured = { readonly kind: 'read'; readonly entry: MomongaModelEntry } | { readonly kind: 'failed'; readonly error: unknown };
type Acted = typeof AGAIN | undefined;
type Choice = { row: PickRow; act(): Promise<Acted | void> };

const USE_API_KEY = 'Use an API key';
export const MODEL_LIST_REREAD_BOUND_MS = 15_000;
export const MODEL_LIST_NO_ANSWER_REASON = 'no answer within 15 seconds';
export const modelListNotCurrent = (reason: string): string => `the list of models is not current: ${reason}`;
const LOADING_PHASE = 'Loading models…';
const CONNECT_TITLE = 'Connect a model';

const SANDBOX_OFF_ROWS = [{ label: 'Continue' }, { label: 'Cancel' }] as const;
const SANDBOX_OFF_CONTINUE = 0;
const SANDBOX_OFF_CANCEL = 1;

const isSignInRequired = (health: TargetHealth | undefined): boolean => health?.reason === SIGN_IN_REQUIRED_CODE;

export const createPlanFlows = (ports: PlanFlowPorts): PlanFlows => {
  const { backend } = ports;
  const runCancellable = <T,>(work: (signal: AbortSignal) => Promise<T>): Promise<T> =>
    ports.cancellable === undefined ? work(new AbortController().signal) : ports.cancellable(work);

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

  const chosenRead = async (model: string): Promise<ChosenRead> => {
    let ended = false;
    let stop = (): void => undefined;
    const measuredEntry = (retryAfterSeconds: number): Promise<Measured> =>
      new Promise<Measured>((resolve) => {
        stop = followMeasurement({ read: () => backend.modelOf(model), timers: ports.timers }, retryAfterSeconds, (read) => resolve({ kind: 'read', entry: read }), (error) => resolve({ kind: 'failed', error }), () => undefined);
      });
    const loaded = await ports.loading(
      LOADING_PHASE,
      async (): Promise<Exclude<ChosenRead, { kind: 'cancelled' }>> => {
        const listed = await backend.models().then(
          (entries): { readonly kind: 'listed'; readonly entries: readonly MomongaModelEntry[] } => ({ kind: 'listed', entries }),
          (error: unknown): { readonly kind: 'failed'; readonly error: unknown } => ({ kind: 'failed', error }),
        );
        if (listed.kind === 'failed') return listed;
        const { entries } = listed;
        const entry = entries.find((candidate) => candidate.id === model);
        const readiness = entry === undefined ? undefined : agentReadiness(entry.capabilities);
        if (ended || readiness?.state !== 'probing') return { kind: 'read', entries, entry };
        const measured = await measuredEntry(readiness.retryAfterSeconds);
        if (measured.kind === 'failed') return measured;
        const read = measured.entry;
        return { kind: 'read', entries: [...entries.filter((other) => other.id !== read.id), read], entry: read };
      },
      LOADING_HINTS.none,
    );
    ended = true;
    stop();
    return loaded.kind === 'cancelled' ? loaded : loaded.value;
  };

  const chosenWithEffort = async (model: string, atSwitch: () => Promise<void>): Promise<ModelChosen> => {
    const read = await chosenRead(model);
    if (read.kind === 'cancelled') return { backTo: model };
    if (read.kind === 'failed') {
      ports.warn(modelUnreadText(read.error));
      return undefined;
    }
    const readiness = read.entry === undefined ? undefined : agentReadiness(read.entry.capabilities);
    if (readiness?.state === 'unavailable') {
      ports.warn(notReadyNoticeOf(readiness, 'tui'));
      return undefined;
    }
    const accepted = acceptedEffortsOf(declaredReasoning(read.entries, model));
    if (accepted.length === 0) {
      await ports.switchedThen(model, undefined, atSwitch);
      return undefined;
    }
    const sessionModel = ports.model();
    const chosen = await chooseEffort({ choose: ports.choose }, accepted, sentEffort(read.entries, model, sessionModel === undefined || sessionModel === model ? ports.effort() : undefined));
    if (chosen === undefined) return { backTo: model };
    await ports.switchedThen(model, chosen.level, async () => {
      await atSwitch();
      if (chosen.scope === 'saved') await writeModelEffort({ backend, info: ports.info, wait: ports.wait }, model, chosen.level);
    });
    return undefined;
  };

  const chooseFrom = async (request: { title?: string; lines?: readonly string[] }, choices: readonly Choice[]): Promise<boolean> => {
    for (;;) {
      const acted = await chooseThen(ports.choose, () => ({ ...request, rows: choices.map((choice) => choice.row) }), async (choice) => choices[choice.index]?.act());
      if (acted === undefined) return false;
      if (acted.value !== AGAIN) return true;
    }
  };

  const readBetween = async <T>(read: () => Promise<T>): Promise<T> => {
    const loaded = await ports.read(read);
    if (loaded.kind === 'cancelled') throw new Abandoned();
    return loaded.value;
  };

  const addApiKey = async (): Promise<void> => {
    await connectAdded(await addService(flowContext()));
  };

  const catalogPicker = async (profile: PlanProfileView, account: string): Promise<boolean> => {
    let catalog: PlanModelsResponse;
    try {
      catalog = await backend.plan.accountModels(account, { profile: profile.id });
    } catch (error) {
      if (!(error instanceof GatewayAnswerError)) throw error;
      ports.failed(error.message);
      ports.info(catalogUnreadHint(profile.id, account));
      return false;
    }
    if (catalog.models.length === 0) {
      ports.info(`${profile.messages.identityLabel} lists no model for ${account}`);
      return false;
    }
    return chooseFrom(
      { title: `Choose a model of ${account}` },
      catalog.models.map((entry) =>
        entry.usable
          ? {
              row: { label: `${entry.slug} · ${entry.displayName} · ${profile.messages.pickerLabel}` },
              act: async () => {
                ports.closeScreen();
                const created = await runCancellable(() => backend.plan.addTarget(account, { profile: profile.id, slug: entry.slug }));
                await ports.connected(created.model);
              },
            }
          : { row: { label: `${entry.slug} · ${entry.reason}`, disabled: true }, act: async () => undefined },
      ),
    );
  };

  const accountInUse = async (profile: PlanProfileView, account: PlanAccountView): Promise<void> => {
    const entries = await backend.models();
    const serving = entries.filter((entry) =>
      entry.chain.some((member) => member.plan !== undefined && planServesAccount(member.plan, account)),
    );
    if (account.pinnedBy.length === 0 && serving.length === 0 && (await catalogPicker(profile, account.label))) return;
    await ports.refreshConnection();
    const current = ports.model();
    const configured = [...account.pinnedBy, ...serving.map((entry) => entry.id)];
    if (current !== undefined && !configured.includes(current)) ports.info(accountNotSessionModelLine(account.label, displayMapOf(listingViewsOf(entries)).get(current) ?? current));
  };

  const afterSignIn = async (profile: PlanProfileView, account: PlanAccountView, firstSignIn: boolean): Promise<void> => {
    if (firstSignIn) {
      const { title, body, action } = profile.messages.firstSignIn;
      await ports.pick({ title, lines: [body, `${profile.messages.manageUsageLabel}: ${profile.usageUrl}`], rows: [{ label: action }] });
    }
    await accountInUse(profile, account);
  };

  const sandboxAccepted = async (): Promise<boolean> => {
    if ((await readBetween(() => backend.sandbox())) !== 'none') return true;
    return (await ports.pick({ title: 'The sandbox is off', lines: SANDBOX_OFF_NOTICE, rows: SANDBOX_OFF_ROWS, initial: SANDBOX_OFF_CANCEL, decideOn: 'enter', escape: SANDBOX_OFF_CANCEL })) === SANDBOX_OFF_CONTINUE;
  };

  const signInRow = (profile: PlanProfileView, label: string): PickRow => ({ label, opensBrowser: true, description: profile.messages.description });

  const runSignInFlow = async (profile: PlanProfileView, account: string, reconsent: boolean, keepOnCancel: boolean): Promise<Acted> => {
    if (!(await sandboxAccepted())) return undefined;
    const step = currentStep();
    const cancel = new AbortController();
    const left = (): boolean => cancel.signal.aborted || step?.signal.aborted === true;
    const notKept = async (label: string): Promise<undefined> => {
      if (keepOnCancel) return undefined;
      await backend.plan.signOut({ profile: profile.id, account: label });
      ports.info(cancelledText(SIGN_IN_WORD));
      return undefined;
    };
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
      waiting.throwIfAborted();
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
        return undefined;
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
      case SIGNED_IN_OUTCOME: {
        if (left()) return notKept(answer.account.label);
        ports.info(signedInLine(answer.account));
        const after = await afterSignIn(profile, answer.account, answer.firstSignIn).then(
          () => undefined,
          (error: unknown) => ({ error }),
        );
        if (left()) return notKept(answer.account.label);
        await ports.signedIn();
        if (after !== undefined) throw after.error;
        return undefined;
      }
    }
  };

  const signInFlow = (profile: PlanProfileView, account: string, reconsent: boolean, keepOnCancel = false): Promise<Acted> =>
    currentStep() === undefined ? runInStep(() => runSignInFlow(profile, account, reconsent, keepOnCancel)) : runSignInFlow(profile, account, reconsent, keepOnCancel);

  const savedAccount = async (profile: PlanProfileView, account: PlanAccountView): Promise<Acted> => {
    switch (savedAccountAction(account)) {
      case 'activate':
        if (account.pinnedBy.length > 0 || !account.active) {
          ports.closeScreen();
          await runCancellable(() => backend.plan.setActive({ profile: profile.id, account: account.label }));
          ports.info(accountInUseLine(profile, account.label));
          await accountInUse(profile, { ...account, active: true });
          return undefined;
        }
        await readBetween(() => backend.plan.setActive({ profile: profile.id, account: account.label }));
        ports.info(accountInUseLine(profile, account.label));
        await accountInUse(profile, { ...account, active: true });
        return undefined;
      case 'sign-in':
        return signInFlow(profile, account.label, account.state === PLAN_DISABLED_STATE, true);
      case 'replace':
        ports.info(recordUnreadableLine('tui', account));
        return signInFlow(profile, account.label, false, true);
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
    if (label === undefined) return undefined;
    return signInFlow(profile, label, false);
  };

  const renameAccount = async (profile: PlanProfileView, listed: PlanAccountsResponse, account: PlanAccountView): Promise<void> => {
    const taken = new Set(accountsOf(profile.id, listed.accounts).map((record) => record.label));
    const to = await ports.promptText({
      title: `Rename account ${account.label}`,
      initial: account.label,
      validate: (text) => {
        if (!isPlanLabel(text)) return PLAN_LABEL_REFUSAL;
        if (taken.has(text)) return `${text} is already saved; choose another label`;
        return undefined;
      },
    });
    if (to === undefined || to === account.label) return;
    ports.closeScreen();
    await runCancellable(() => backend.plan.rename({ profile: profile.id, account: account.label, to }));
    let repointed = false;
    try {
      repointed = await repointAccountConnections(flowContext(), profile.id, account.label, to);
    } finally {
      if (!repointed) await backend.plan.rename({ profile: profile.id, account: to, to: account.label });
    }
    await runCancellable(() => ports.refreshConnection());
  };

  const removeAccount = async (profile: PlanProfileView, account: PlanAccountView): Promise<Acted> => {
    const confirmed = await ports.pick({ title: `Remove account ${account.label}`, rows: [{ label: `Remove account ${account.label}` }], confirm: (_row, decideKey) => `press ${decideKey} again to sign out ${account.label}` });
    if (confirmed === undefined) return AGAIN;
    ports.closeScreen();
    const provider = await runCancellable(() => accountConnectionOf(flowContext(), account));
    const report = await runCancellable(() => backend.plan.signOut({ profile: profile.id, account: account.label }));
    for (const line of signedOutLines(profile, account.label, report)) ports.info(line);
    if (provider !== undefined) await runRemoveServingConnection(flowContext(), provider);
    await runCancellable(() => ports.refreshConnection());
    return undefined;
  };

  const accountActionRows = (profile: PlanProfileView, listed: PlanAccountsResponse, records: readonly PlanAccountView[]): Choice[] =>
    records.flatMap((account): Choice[] => [
      { row: { label: `Rename account ${account.label}` }, act: () => renameAccount(profile, listed, account) },
      { row: { label: `Remove account ${account.label}` }, act: () => removeAccount(profile, account) },
    ]);

  const accountPicker = async (profile: PlanProfileView, listed: PlanAccountsResponse): Promise<void> => {
    const records = accountsOf(profile.id, listed.accounts);
    const actions = accountActionRows(profile, listed, records);
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
            ports.closeScreen();
            const answer = await runCancellable(() => backend.plan.resume(account.label, { profile: profile.id }));
            ports.info(resumeLine(account.label, answer.resumed));
            if (answer.resumed && account.active) await accountInUse(profile, account);
          },
        })),
      ...actions,
      { row: { label: 'Add another account or workspace' }, act: () => newAccount(profile, listed) },
    ]);
  };

  const providerFlowOf = async (profile: PlanProfileView, listed: PlanAccountsResponse): Promise<Acted> => {
    for (const problem of listed.listProblems ?? []) ports.info(listProblemLine(problem));
    if (profile.externalCli !== undefined) {
      const account = accountsOf(profile.id, listed.accounts)[0];
      ports.closeScreen();
      if (account?.state === 'active') {
        ports.info(`${profile.messages.planInUseLabel}${account.email === undefined ? '' : ` · ${account.email}`}. Run /model to add or switch a model.`);
        ports.info(`${profile.messages.manageUsageLabel}: ${profile.usageUrl}`);
      } else {
        ports.info(account?.cause ?? `${profile.messages.signInRequiredMessage}. Run ${profile.externalCli.loginCommand}`);
        ports.info(profile.externalCli.installHint);
      }
      return undefined;
    }
    if (accountsOf(profile.id, listed.accounts).length === 0) return signInFlow(profile, nextAccountLabel(profile.id, listed.accounts), false);
    await accountPicker(profile, listed);
    return undefined;
  };

  const providerFlowRead = async (profile: PlanProfileView): Promise<Acted> => providerFlowOf(profile, await readBetween(() => backend.plan.accounts()));

  const providerFlow = async (profile: PlanProfileView): Promise<void> => {
    await providerFlowRead(profile);
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
    ports.closeScreen();
    await runCancellable(async () => {
      for (const profile of invited) await backend.dismissNotice(invitationKeyOf(profile.id));
    });
    ports.invitationAnswered();
  };

  const login = async (args: string): Promise<void> => {
    if (args !== '') {
      const read = await ports.loading(CONNECT_TITLE, () => backend.plan.accounts(), LOADING_HINTS.readingAndCancel);
      if (read.kind === 'read') await providerFlowOf(profileOf(read.value.profiles, args), read.value);
      return;
    }
    const read = await ports.loading(CONNECT_TITLE, () => Promise.all([backend.plan.accounts(), backend.models(), backend.dismissedNotices()]), LOADING_HINTS.readingAndCancel);
    if (read.kind === 'cancelled') return;
    const [listed, entries, dismissed] = read.value;
    const invited = invitedProfiles(listed, dismissed);
    const keyed = [...new Set(entries.filter((entry) => entry.naming === 'account' && entry.chain[0]?.key !== undefined).map((entry) => entry.provider))];
    await chooseFrom({ title: CONNECT_TITLE }, [
      ...listed.profiles.map((profile) => {
        const label = `${profile.messages.pickerLabel} [subscription] · ${profileStateText(profile, listed.accounts)}`;
        return { row: accountsOf(profile.id, listed.accounts).length === 0 ? signInRow(profile, label) : { label }, act: () => providerFlowRead(profile) };
      }),
      ...keyed.map((provider) => ({
        row: { label: `${provider} [API key] · configured` },
        act: async () => {
          await runServerActions(flowContext(), provider);
          await ports.refreshConnection();
        },
      })),
      { row: { label: 'Add an API key' }, act: addApiKey },
      ...(invited.length === 0 ? [] : [{ row: { label: NOT_NOW_LABEL }, act: () => answerNotNow(invited) }]),
    ]);
  };

  const logout = async (): Promise<void> => {
    const read = await ports.loading('Sign out', () => backend.plan.accounts(), LOADING_HINTS.readingAndCancel);
    if (read.kind === 'cancelled') return;
    const listed = read.value;
    if (listed.accounts.length === 0) {
      ports.info(NO_ACCOUNT_SAVED_TEXT);
      return;
    }
    const index = await ports.pick({ title: 'Sign out', rows: listed.accounts.map((account) => ({ label: accountRowLabel(account) })), confirm: (row, decideKey) => `press ${decideKey} again to sign out ${row.label}` });
    const chosen = index === undefined ? undefined : listed.accounts[index];
    if (chosen === undefined) return;
    ports.closeScreen();
    const report = await runCancellable(() => backend.plan.signOut({ profile: chosen.profile, account: chosen.label }));
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

  const useConfigured = async (entry: MomongaModelEntry, health: GatewayHealth, listed: PlanAccountsResponse, atStart: boolean, display: string): Promise<ModelChosen> => {
    const plan = blockedPlanOf(entry, health);
    if (plan !== undefined) await targetSignIn(listed, plan);
    return chosenWithEffort(entry.id, async () => {
      if (!atStart) return;
      await writeStart(flowContext(), entry.id);
      ports.toast(startingModelSetText(display));
    });
  };

  const catalogNotCurrent = (account: string, reason: string): string => `the list of models of ${account} is not current: ${reason}`;

  const modelPicker = async (current: string | undefined): Promise<void> => modelList(current);

  const readModelList = async (context: ModelsFlowContext) => {
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
  };

  type ModelListRead = Awaited<ReturnType<typeof readModelList>>;

  type ShownModelList = { readonly rows: readonly PickRow[]; readonly keys: readonly string[]; readonly currentIndex: number; readonly lines: readonly string[]; readonly alt: boolean; choose(index: number, atStart: boolean): Promise<ModelChosen> };

  const modelListOf = (context: ModelsFlowContext, read: ModelListRead, current: string | undefined): ShownModelList => {
    const { listing, health, listed, catalogs, remembered, opened } = read;
    const entries = listing.data;
    const served = new Set(entries.flatMap((entry) => entry.chain.map((member) => member.upstream)));
    const nothingMore = async (): Promise<undefined> => undefined;
    const catalogChoices = catalogs.flatMap((catalogRead): { key: string; plan: PlanListRow; act(): Promise<ModelChosen> }[] => {
      if (catalogRead.kind === 'unread') return [{ key: `unread:${catalogRead.account.profile}:${catalogRead.account.label}`, plan: { kind: 'note', label: catalogNotCurrent(catalogRead.account.label, catalogRead.reason) }, act: nothingMore }];
      const { account, profile, catalog } = catalogRead;
      const billing = planProfileOf(profile.id).targetDefaults.billing;
      const searchTextsOf = (entry: { readonly displayName: string }): readonly string[] => [entry.displayName, profile.messages.pickerLabel];
      return catalog.models
        .filter((entry) => !served.has(entry.slug))
        .map((entry) =>
          entry.usable
            ? {
                key: `model:${entry.slug}`,
                plan: { kind: 'model', slug: entry.slug, billing, searchTexts: searchTextsOf(entry) },
                act: async () => {
                  const created = await backend.plan.addTarget(account.label, { profile: profile.id, slug: entry.slug });
                  return chosenWithEffort(created.model, nothingMore);
                },
              }
            : { key: `model:${entry.slug}`, plan: { kind: 'model', slug: entry.slug, billing, reason: entry.reason, searchTexts: searchTextsOf(entry) }, act: nothingMore },
        );
    });
    const found = opened === undefined ? [] : foundNotConfigured(opened.edit, remembered);
    const { rows, listed: listedRows } = modelListRows({ listing, current, health, found, plan: catalogChoices.map((choice) => choice.plan) });
    const displays = displayMapOf(listingViewsOf(entries));
    const allRows = [...rows, { label: MODEL_SETTINGS_ROW }];
    const keys = [
      ...listedRows.map((row) => (row.kind === 'configured' ? `model:${displays.get(row.entry.id) ?? row.entry.id}` : row.kind === 'separator' ? 'separator:found' : `model:${row.found.display}`)),
      ...catalogChoices.map((choice) => choice.key),
      'model-settings',
    ];
    const currentIndex = current === undefined ? -1 : listedRows.findIndex((row) => row.kind === 'configured' && row.entry.id === current);
    return {
      rows: allRows,
      keys,
      currentIndex,
      lines: allRows.length === 1 ? [messageOf('noModelConnected', 'tui')] : [MODEL_CHANGE_NOTE],
      alt: allRows.length > 1,
      choose: async (index, atStart) => {
        const row = listedRows[index];
        if (row === undefined) return catalogChoices[index - listedRows.length]?.act();
        if (row.kind === 'configured') return useConfigured(row.entry, health, listed, atStart, displays.get(row.entry.id) ?? row.entry.id);
        if (row.kind === 'found' && opened !== undefined) {
          const added = await addFoundModel(context, opened, row.found.server, row.found.model, row.found.display);
          if (added?.model !== undefined) return chosenWithEffort(added.model, nothingMore);
        }
        return undefined;
      },
    };
  };

  const modelList = async (current: string | undefined): Promise<void> => {
    const context = flowContext();
    const first = await ports.loading('Models', () => readModelList(context), LOADING_HINTS.readingAndCancel);
    if (first.kind === 'cancelled') return;
    let shown = modelListOf(context, first.value, current);
    let highlightedKey: string | undefined;
    let shownBefore = false;
    const indexOfKey = (key: string | undefined): number => (key === undefined ? -1 : shown.keys.indexOf(key));
    const highlightAfterReread = (): number => {
      const kept = indexOfKey(highlightedKey);
      if (kept !== -1) return kept;
      return shown.currentIndex !== -1 ? shown.currentIndex : 0;
    };
    const reread = (show: (update: PickUpdate) => void): (() => void) => {
      let following = true;
      const notCurrent = (reason: string): void => {
        following = false;
        show({ rows: shown.rows, lines: [...shown.lines, modelListNotCurrent(reason)], alt: shown.alt ? { label: ALSO_AT_START_LABEL } : undefined, highlight: highlightAfterReread() });
      };
      const bound = ports.timers.setTimeout(() => {
        if (following) notCurrent(MODEL_LIST_NO_ANSWER_REASON);
      }, MODEL_LIST_REREAD_BOUND_MS);
      readModelList(context).then(
        (value) => {
          if (!following) return;
          following = false;
          ports.timers.clearTimeout(bound);
          shown = modelListOf(context, value, ports.model() ?? current);
          show({ rows: shown.rows, lines: shown.lines, alt: shown.alt ? { label: ALSO_AT_START_LABEL } : undefined, highlight: highlightAfterReread() });
        },
        (error: unknown) => {
          if (!following) return;
          ports.timers.clearTimeout(bound);
          notCurrent(error instanceof Error ? error.message : String(error));
        },
      );
      return () => {
        following = false;
        ports.timers.clearTimeout(bound);
      };
    };
    const request = (): PickRequest => {
      const initial = indexOfKey(highlightedKey);
      const again = shownBefore;
      shownBefore = true;
      return {
        title: 'Models',
        lines: shown.lines,
        rows: shown.rows,
        ...(shown.alt ? { alt: { label: ALSO_AT_START_LABEL } } : {}),
        ...(initial === -1 ? {} : { initial }),
        onHighlight: (index) => {
          highlightedKey = shown.keys[index];
        },
        ...(again ? { watch: reread } : {}),
      };
    };
    for (;;) {
      const acted = await chooseThen(ports.choose, request, async (choice): Promise<Acted> => {
        highlightedKey = shown.keys[choice.index];
        if (choice.index === shown.rows.length - 1) {
          try {
            await runModelsHub(context);
          } finally {
            await ports.refreshConnection();
          }
          return AGAIN;
        }
        const chosen = await shown.choose(choice.index, choice.alt);
        return chosen === undefined ? undefined : AGAIN;
      });
      if (acted?.value !== AGAIN) return;
    }
  };

  const welcome = async (profiles: readonly PlanProfileView[]): Promise<void> => {
    await chooseFrom({ title: 'Connect a model to start' }, [
      ...profiles.map((profile) => ({ row: signInRow(profile, profile.loginLabel), act: () => providerFlowRead(profile) })),
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
      { row: signInRow(profile, `Enable ${profile.messages.identityLabel} plan use`), act: () => (account === undefined ? providerFlowRead(profile) : signInFlow(profile, account, true, true)) },
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
