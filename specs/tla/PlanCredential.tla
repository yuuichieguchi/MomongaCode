------------------------- MODULE PlanCredential -------------------------
(***************************************************************************)
(* Design model of the credential lifecycle of a ChatGPT plan account in   *)
(* the gateway (design-chatgpt-plan.md sections 5 and 9, increments P5a    *)
(* and P5b). It describes what the design says the code does.              *)
(*                                                                         *)
(* Modelled                                                                *)
(*   - the account record on disk (an atomic register): state, generation, *)
(*     refresh token, cause, pendingRefresh, issue time, subject           *)
(*   - the memory copy: state, generation, refresh token, dirty flag,      *)
(*     issue time, the generation of the last forced refresh               *)
(*   - the server's token family: single-use rotating refresh tokens, a    *)
(*     consumed token presented again revokes the family, a revoked family *)
(*     answers every refresh with a terminal code, the user's disconnect   *)
(*   - the per-account FIFO mutex, held across the token-endpoint call     *)
(*   - requests: read (single flight), 401 recovery with coalescing        *)
(*   - the refresh POST as a packet in flight: it can be answered, given   *)
(*     up by the client (timeout, lost response) and still reach the       *)
(*     server later, or be orphaned by a crash and still reach the server  *)
(*   - sign-in install, sign-out with revocation, persist retry, crash     *)
(*     and restart (volatile state lost, a record in signing_out resumes)  *)
(*                                                                         *)
(* Abstractions (a proof holds only for this model)                        *)
(*   - token values are small integers; a token belongs to the family      *)
(*     issued at or after sStart                                           *)
(*   - time is a discrete clock; an access token is Fresh at age 0, Near   *)
(*     (inside the margin M, refresh first) at age 1 and Stale (inside the *)
(*     skew S, never sent) from age 2; clock skew, the values of L, S, B   *)
(*     and M, and earliest_refresh_at are the Z3 proof plan-refresh        *)
(*   - a refresh attempt ends answered, or given up (a timeout or lost     *)
(*     response: nothing is known about the server). After a give-up the   *)
(*     client may resend the same token up to MaxResend times in the same  *)
(*     request while holding the mutex (ReqRetry), or end the refresh as a *)
(*     transient failure at any give-up; the count is per request. The     *)
(*     backoff and the Retry-After cap are the Z3 proof plan-refresh       *)
(*   - the ID token, the JWKS, the scope verdict and PKCE are a candidate  *)
(*     subject and the client id of the registration the authorization     *)
(*     came from (inSrc); PlanSignIn models the attempt                    *)
(*   - the exchange of a code and the install are one step; a crash        *)
(*     before the install leaves the record unchanged, the same as not     *)
(*     starting                                                            *)
(*   - invalid_client and the state plan_disabled are not modelled: they   *)
(*     keep every token, so they cannot affect the properties              *)
(*   - the file system is an atomic register; a crash during a write       *)
(*     leaves the old or the new record, which are the states before and   *)
(*     after the write step                                                *)
(*   - the redactor, HTTP bodies, the 401 status of the Responses call:    *)
(*     the server answers a request with success, or with 401 when the     *)
(*     family is revoked or the 401 budget allows (a skewed or rejected    *)
(*     access token)                                                       *)
(*   - the answer of the server to a revocation of a consumed token is the *)
(*     pessimistic reading of open item O4: an empty 200 that revokes only *)
(*     the token it names, so the family stays live when the token named   *)
(*     is not the current one                                              *)
(*   - the 30-day refresh token expiry is a Disc (disconnect) step         *)
(*   - a persist failure is transient (retried, MaxPersistFail) or          *)
(*     deterministic (MaxDetFail): the memory state store_unwritable, mUnwr *)
(*     is memory only, requests go on while the token is not Stale, no     *)
(*     refresh starts, no retry, and a later write fails for the same      *)
(*     cause; sign-in and sign-out writes in that state fail without       *)
(*     effect. The intent write before a refresh cannot fail; a failure    *)
(*     there leaves nothing consumed                                       *)
(*   - a restart may find the record unreadable (MaxUnreadable): the       *)
(*     memory state store_unreadable with no tokens, the disk untouched;   *)
(*     sign-in and sign-out do not start; a later restart reads again      *)
(*                                                                         *)
(* Counters bound every fault: crashes, answers given up, disconnects,     *)
(* sign-ins, sign-outs, failed persists, spurious 401, failed revocations. *)
(*                                                                         *)
(* Ghost variables (they never influence an action except as a record)     *)
(*   slack[a][t]  unanswered sends of token t minus arrivals of t at the   *)
(*                server after t was consumed; negative means the server   *)
(*                saw a consumed token that the client had no reason to     *)
(*                send again                                               *)
(*   acked, badSend, forcedCnt, soDone, outConfirmed, lossKind,            *)
(*   startedAfterOut                                                       *)
(*                                                                         *)
(* Statements of the properties (the wording of review 1, F7 and rulings)  *)
(*   - I-C3: after a send whose answer was received, never resend; after   *)
(*     an unanswered send, resend at most attempts - 1 times within one    *)
(*     refresh. A send is unanswered when the client gave up, a crash      *)
(*     orphaned it, or a crash dropped the knowledge that the answer       *)
(*     arrived but was not yet persisted. Checked as: badSend (a token     *)
(*     whose answer was received is never sent) and slack (every arrival   *)
(*     at the server of an already consumed token is paid for by an        *)
(*     unanswered send of that token)                                      *)
(*   - I-C9: at most one forced refresh per generation per gateway         *)
(*     process; mForced is memory, so a restart may force once more, and   *)
(*     that resend is within I-C3                                          *)
(*   - I-C10: after sign-out has returned, no request starts (reads a      *)
(*     bearer) and neither the file nor the memory holds a refresh token   *)
(*     (SignOutFinal). The access token of a request already in flight is  *)
(*     not recalled. confirmed is reported only when the token revoked is  *)
(*     known to be the latest: no pendingRefresh on the file and the       *)
(*     memory record flushed; otherwise unconfirmed. Then a confirmed      *)
(*     revocation leaves no live family (SignOutRevokesFamily). With       *)
(*     GateConfirm = FALSE the report is confirmed whenever the server     *)
(*     answered 200, and the lost rotation refutes the property            *)
(*     (PlanCredential.signOutAfterLoss): the server answers an empty 200  *)
(*     for a consumed token and the family with the replacement stays live *)
(*   - I-C6: a record is in needs_sign_in only when the server family is   *)
(*     revoked (a terminal code was the answer)                            *)
(*   - I-C7: registration survives: an install writes dSub and dClient     *)
(*     only from absent (IdentityPinned), and LossDetected holds that the  *)
(*     record keeps its subject and client id; the cause of a              *)
(*     needs_sign_in that was caused by a consumed token is                *)
(*     refresh_interrupted (CauseAttributed)                               *)
(*   - I-C8: an install requires the same sub and client id as the record  *)
(*     (PinIdentity); AccountsIsolated says over content that the tokens   *)
(*     of the record of account a come from the family of a and the client *)
(*     id is the one registered for a; OtherAccountsUntouched says a step  *)
(*     changes the file of at most one account                             *)
(*                                                                         *)
(* Properties                                                              *)
(*   SingleUse (I-C3), MutualExclusion (I-C4), PersistBeforeForget         *)
(*   (I-C5), NoEraseOnTransient (I-C6), LossDetected and CauseAttributed   *)
(*   (I-C7), IdentityPinned, AccountsIsolated and OtherAccountsUntouched   *)
(*   (I-C8), Coalesced (I-C9), SignOutFinal and SignOutRevokesFamily       *)
(*   (I-C10), and the liveness properties Settles and AllServed            *)
(*                                                                         *)
(* Configurations (scripts/tlc.sh <name>, specs/tla/<name>.cfg)            *)
(*   PlanCredential              one account, two requests, one crash, one *)
(*                               answer given up, one disconnect, one      *)
(*                               sign-out: every safety property holds     *)
(*   PlanCredential.signIn       install racing refresh and sign-out,      *)
(*                               a candidate subject that does not match   *)
(*   PlanCredential.signOut      sign-out during a refresh, a crash during *)
(*                               signing_out, revocation outcomes          *)
(*   PlanCredential.crashPoints  persist failures with crashes, every      *)
(*                               crash point of section 5.5                *)
(*   PlanCredential.twoAccounts  two records, independent mutexes          *)
(*   PlanCredential.live         Settles under weak fairness with every    *)
(*                               fault but the deterministic persist fault *)
(*                               (excluded: its requests end in an error,  *)
(*                               not served) (-lncheck final)              *)
(*   PlanCredential.liveServed   AllServed with the faults it survives:    *)
(*                               401, failed persist, clock (-lncheck      *)
(*                               final)                                    *)
(*   PlanCredential.deep         larger bounds, with a sign-in             *)
(*   PlanCredential.persistDeterministic  the deterministic persist fault  *)
(*                               with sign-in and sign-out: PersistBefore  *)
(*                               Forget, NoRefreshWhileUnwritable hold     *)
(*   PlanCredential.refreshWhileUnwritable  a refresh starts in the state   *)
(*                               store_unwritable: PersistBeforeForget     *)
(*                               refuted (memory two generations ahead)    *)
(*   PlanCredential.unreadableAsSignIn  an unreadable restart is read as    *)
(*                               needs_sign_in: UnreadableKeepsMeaning     *)
(*                               refuted                                   *)
(*   PlanCredential.noMutex      no mutex: SingleUse refuted               *)
(*   PlanCredential.eraseOnTransient  tokens cleared on a given-up answer: *)
(*                               NoEraseOnTransient refuted                *)
(*   PlanCredential.forgetBeforePersist  the old refresh token is removed  *)
(*                               from the file before the replacement is   *)
(*                               written: PersistBeforeForget refuted      *)
(*   PlanCredential.signOutNoWait  sign-out does not wait for the mutex:   *)
(*                               SignOutFinal refuted                      *)
(*   PlanCredential.noCoalesceGen     a 401 on an older generation forces  *)
(*                               a refresh: Coalesced refuted              *)
(*   PlanCredential.noCoalesceForced  a 401 on the current generation      *)
(*                               after a forced refresh that failed        *)
(*                               forces again: Coalesced refuted           *)
(*   PlanCredential.pinIdentityOff  an install writes a subject or client  *)
(*                               that differs: IdentityPinned refuted      *)
(*   PlanCredential.crossAccount  an install takes the tokens of another   *)
(*                               account's registration: AccountsIsolated  *)
(*                               refuted                                   *)
(*   PlanCredential.mutexOnly    only the mutex; SingleUse and             *)
(*                               MutualExclusion hold                      *)
(*   PlanCredential.noIntent     no pendingRefresh; the safety properties  *)
(*                               hold, CauseAttributed is not checked      *)
(*   PlanCredential.noIntentCause  the same, CauseAttributed refuted: this *)
(*                               is what pendingRefresh buys               *)
(*   PlanCredential.signOutAfterLoss  GateConfirm = FALSE: SignOutRevokes  *)
(*                               Family refuted by a sign-out after a lost *)
(*                               rotation                                  *)
(*                                                                         *)
(* The design (section 9) states that the module and PlanSignIn share      *)
(* state names and terminal codes through a JSON emitted by the            *)
(* implementation and a drift test; neither exists before P5a, so the      *)
(* names below are the source until then.                                  *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, Sequences

CONSTANTS
    Reqs, SecondReqs, SecondAcct,
    MaxClock, MaxCrash, MaxGiveUp, MaxDisc, MaxSignIn, MaxSignOut,
    MaxPersistFail, MaxReject, MaxRevokeFail,
    UseMutex, CoalesceGen, CoalesceForced, EraseOnTransient, ForgetFirst, SignOutWaits, Intent,
    PinIdentity, GateConfirm, MaxResend,
    MaxDetFail, MaxUnreadable, RefreshWhenUnwritable, UnreadableAsSignIn

ASSUME Reqs # {} /\ SecondReqs \subseteq Reqs /\ SecondAcct \in BOOLEAN /\ (SecondReqs # {} => SecondAcct)

Accts == IF SecondAcct THEN {"a1", "a2"} ELSE {"a1"}
Subs == {"s1", "s2"}
AcctSub == [a \in Accts |-> IF a = "a1" THEN "s1" ELSE "s2"]
AcctClient == [a \in Accts |-> IF a = "a1" THEN 1 ELSE 2]
ReqAcct == [r \in Reqs |-> IF r \in SecondReqs THEN "a2" ELSE "a1"]

ASSUME \A c \in {MaxClock, MaxCrash, MaxGiveUp, MaxDisc, MaxSignIn, MaxSignOut, MaxPersistFail, MaxReject, MaxRevokeFail} : c \in Nat
ASSUME \A c \in {UseMutex, CoalesceGen, CoalesceForced, EraseOnTransient, ForgetFirst, SignOutWaits, Intent, PinIdentity, GateConfirm} : c \in BOOLEAN
ASSUME \A c \in {MaxResend, MaxDetFail, MaxUnreadable} : c \in Nat
ASSUME \A c \in {RefreshWhenUnwritable, UnreadableAsSignIn} : c \in BOOLEAN

None == "none"
MaxTok == 9
Toks == 0..MaxTok
Gens == 0..(MaxTok + 3)

TerminalCodes == {"refresh_token_reused", "refresh_token_invalidated", "invalid_grant"}
Causes == TerminalCodes \cup {"refresh_interrupted", "transient", None}
AcctStates == {"active", "needs_sign_in", "signing_out", "registered", "store_unreadable"}

VARIABLES
    dState, dGen, dRt, dCause, dPend, dIss, dSub, dClient, dFam,
    mState, mGen, mRt, mDirty, mIss, mForced, mUnwr,
    sCur, sUsed, sRev, sStart, sNext,
    net, pktN,
    holder, waitq,
    rph, rpur, rtok, rtry, rpkt, rgot, rgen, rretried, rres,
    inPh, inCand, inSrc, outPh, prPh,
    clock,
    crashes, giveups, discs, signins, signouts, pfails, rejects, rvfails, detFails, unreads,
    unreadMark, slack, acked, badSend, forcedCnt, soDone, outConfirmed, lossKind, startedAfterOut

diskVars == <<dState, dGen, dRt, dCause, dPend, dIss, dSub, dClient, dFam>>
memVars == <<mState, mGen, mRt, mDirty, mIss, mForced, mUnwr>>
srvVars == <<sCur, sUsed, sRev, sStart, sNext>>
netVars == <<net, pktN>>
lockVars == <<holder, waitq>>
reqVars == <<rph, rpur, rtok, rtry, rpkt, rgot, rgen, rretried, rres>>
actVars == <<inPh, inCand, inSrc, outPh, prPh>>
budgetVars == <<crashes, giveups, discs, signins, signouts, pfails, rejects, rvfails, detFails, unreads>>
ghostVars == <<unreadMark, slack, acked, badSend, forcedCnt, soDone, outConfirmed, lossKind, startedAfterOut>>
vars == <<diskVars, memVars, srvVars, netVars, lockVars, reqVars, actVars, clock, budgetVars, ghostVars>>

Max(x, y) == IF x > y THEN x ELSE y
Age(x) == clock - x

Init ==
    /\ dState = [a \in Accts |-> "active"]
    /\ dGen = [a \in Accts |-> 1]
    /\ dRt = [a \in Accts |-> 1]
    /\ dCause = [a \in Accts |-> None]
    /\ dPend = [a \in Accts |-> FALSE]
    /\ dIss = [a \in Accts |-> 0]
    /\ dSub = AcctSub
    /\ dClient = AcctClient
    /\ dFam = [a \in Accts |-> a]
    /\ mState = [a \in Accts |-> "active"]
    /\ mGen = [a \in Accts |-> 1]
    /\ mRt = [a \in Accts |-> 1]
    /\ mDirty = [a \in Accts |-> FALSE]
    /\ mIss = [a \in Accts |-> 0]
    /\ mForced = [a \in Accts |-> 0]
    /\ mUnwr = [a \in Accts |-> FALSE]
    /\ sCur = [a \in Accts |-> 1]
    /\ sUsed = [a \in Accts |-> {}]
    /\ sRev = [a \in Accts |-> FALSE]
    /\ sStart = [a \in Accts |-> 1]
    /\ sNext = [a \in Accts |-> 1]
    /\ net = {}
    /\ pktN = 0
    /\ holder = [a \in Accts |-> None]
    /\ waitq = [a \in Accts |-> <<>>]
    /\ rph = [r \in Reqs |-> "idle"]
    /\ rpur = [r \in Reqs |-> "read"]
    /\ rtok = [r \in Reqs |-> 0]
    /\ rpkt = [r \in Reqs |-> 0]
    /\ rgot = [r \in Reqs |-> 0]
    /\ rgen = [r \in Reqs |-> 0]
    /\ rretried = [r \in Reqs |-> FALSE]
    /\ rres = [r \in Reqs |-> None]
    /\ inPh = [a \in Accts |-> "none"]
    /\ inCand = [a \in Accts |-> AcctSub[a]]
    /\ inSrc = [a \in Accts |-> a]
    /\ rtry = [r \in Reqs |-> 0]
    /\ outPh = [a \in Accts |-> "none"]
    /\ prPh = [a \in Accts |-> "none"]
    /\ clock = 0
    /\ crashes = 0 /\ giveups = 0 /\ discs = 0 /\ signins = 0
    /\ signouts = 0 /\ pfails = 0 /\ rejects = 0 /\ rvfails = 0 /\ detFails = 0 /\ unreads = 0
    /\ unreadMark = [a \in Accts |-> FALSE]
    /\ slack = [a \in Accts |-> [t \in Toks |-> 0]]
    /\ acked = [a \in Accts |-> {}]
    /\ badSend = [a \in Accts |-> FALSE]
    /\ forcedCnt = [a \in Accts |-> [g \in Gens |-> 0]]
    /\ soDone = [a \in Accts |-> FALSE]
    /\ outConfirmed = [a \in Accts |-> None]
    /\ lossKind = [a \in Accts |-> None]
    /\ startedAfterOut = [a \in Accts |-> FALSE]

-----------------------------------------------------------------------------

CanTake(a, x) == IF UseMutex THEN holder[a] = None /\ Len(waitq[a]) > 0 /\ Head(waitq[a]) = x ELSE TRUE
Enqueue(a, x) == IF UseMutex THEN waitq' = [waitq EXCEPT ![a] = Append(@, x)] ELSE UNCHANGED waitq
Take(a, x) == IF UseMutex THEN holder' = [holder EXCEPT ![a] = x] /\ waitq' = [waitq EXCEPT ![a] = Tail(@)] ELSE UNCHANGED lockVars
Pop(a) == IF UseMutex THEN waitq' = [waitq EXCEPT ![a] = Tail(@)] /\ UNCHANGED holder ELSE UNCHANGED lockVars
Release(a) == IF UseMutex THEN holder' = [holder EXCEPT ![a] = None] /\ UNCHANGED waitq ELSE UNCHANGED lockVars

Set(f, k, v) == [f EXCEPT ![k] = v]

Blocked(a) == mUnwr[a] /\ ~RefreshWhenUnwritable

Unusable(a) == IF mState[a] = "store_unreadable" THEN "unreadable" ELSE "signIn"

Tick ==
    /\ clock < MaxClock
    /\ clock' = clock + 1
    /\ UNCHANGED <<diskVars, memVars, srvVars, netVars, lockVars, reqVars, actVars, budgetVars, ghostVars>>

-----------------------------------------------------------------------------
(* Requests *)

Begin(r, g) ==
    LET a == ReqAcct[r] IN
    /\ rph' = Set(rph, r, "inflight")
    /\ rgen' = Set(rgen, r, g)
    /\ startedAfterOut' = Set(startedAfterOut, a, startedAfterOut[a] \/ soDone[a])

Finish(r, res) ==
    /\ rph' = Set(rph, r, "done")
    /\ rres' = Set(rres, r, res)

Start(r) ==
    LET a == ReqAcct[r] IN
    /\ rph[r] = "idle"
    /\ UNCHANGED <<diskVars, memVars, srvVars, netVars, holder, rpur, rtok, rtry, rpkt, rgot, rretried, actVars, clock, budgetVars>>
    /\ UNCHANGED <<unreadMark, slack, acked, badSend, forcedCnt, soDone, outConfirmed, lossKind>>
    /\ IF mState[a] # "active"
        THEN /\ Finish(r, Unusable(a)) /\ UNCHANGED <<rgen, startedAfterOut, waitq>>
        ELSE IF Age(mIss[a]) = 0
            THEN /\ Begin(r, mGen[a]) /\ UNCHANGED <<rres, waitq>>
            ELSE IF Blocked(a)
                THEN IF Age(mIss[a]) < 2
                    THEN /\ Begin(r, mGen[a]) /\ UNCHANGED <<rres, waitq>>
                    ELSE /\ Finish(r, "unwritable") /\ UNCHANGED <<rgen, startedAfterOut, waitq>>
                ELSE /\ rph' = Set(rph, r, "want") /\ Enqueue(a, r) /\ UNCHANGED <<rgen, rres, startedAfterOut>>

NextRefreshPhase == IF Intent THEN "pend" ELSE "send"

ReqGrant(r) ==
    LET a == ReqAcct[r] IN
    /\ rph[r] = "want"
    /\ CanTake(a, r)
    /\ UNCHANGED <<diskVars, memVars, srvVars, netVars, rtok, rtry, rpkt, rgot, rretried, actVars, clock, budgetVars>>
    /\ UNCHANGED <<unreadMark, slack, acked, badSend, forcedCnt, soDone, outConfirmed, lossKind>>
    /\ IF mState[a] # "active"
        THEN /\ Finish(r, Unusable(a)) /\ Pop(a) /\ UNCHANGED <<rpur, rgen, startedAfterOut>>
        ELSE IF Age(mIss[a]) = 0
            THEN /\ Begin(r, mGen[a]) /\ Pop(a) /\ UNCHANGED <<rpur, rres>>
            ELSE IF Blocked(a)
                THEN IF Age(mIss[a]) < 2
                    THEN /\ Begin(r, mGen[a]) /\ Pop(a) /\ UNCHANGED <<rpur, rres>>
                    ELSE /\ Finish(r, "unwritable") /\ Pop(a) /\ UNCHANGED <<rpur, rgen, startedAfterOut>>
                ELSE /\ Take(a, r) /\ rph' = Set(rph, r, NextRefreshPhase) /\ rpur' = Set(rpur, r, "read") /\ UNCHANGED <<rgen, rres, startedAfterOut>>

ReqPend(r) ==
    LET a == ReqAcct[r] IN
    /\ rph[r] = "pend"
    /\ IF mUnwr[a]
        THEN UNCHANGED <<dState, dGen, dRt, dPend, dIss, mDirty>>
        ELSE /\ dState' = Set(dState, a, mState[a])
             /\ dGen' = Set(dGen, a, mGen[a])
             /\ dRt' = Set(dRt, a, mRt[a])
             /\ dPend' = Set(dPend, a, TRUE)
             /\ dIss' = Set(dIss, a, mIss[a])
             /\ mDirty' = Set(mDirty, a, FALSE)
    /\ rph' = Set(rph, r, "send")
    /\ UNCHANGED <<dCause, dSub, dClient, dFam, mState, mGen, mRt, mIss, mForced, mUnwr, srvVars, netVars, lockVars, rpur, rtok, rtry, rpkt, rgot, rgen, rretried, rres, actVars, clock, budgetVars, ghostVars>>

ReqSend(r) ==
    LET a == ReqAcct[r] IN
    /\ rph[r] = "send"
    /\ IF mRt[a] = 0
        THEN /\ Finish(r, "signIn") /\ Release(a)
             /\ UNCHANGED <<netVars, rtok, rpkt, badSend>>
        ELSE /\ rph' = Set(rph, r, "await")
             /\ rtok' = Set(rtok, r, mRt[a])
             /\ rpkt' = Set(rpkt, r, pktN)
             /\ net' = net \cup {[id |-> pktN, a |-> a, tok |-> mRt[a], live |-> TRUE, st |-> "sent", rk |-> None, rv |-> None]}
             /\ pktN' = pktN + 1
             /\ badSend' = Set(badSend, a, badSend[a] \/ mRt[a] \in acked[a])
             /\ UNCHANGED <<holder, waitq, rres>>
    /\ UNCHANGED <<diskVars, memVars, srvVars, rpur, rtry, rgot, rgen, rretried, actVars, clock, budgetVars, unreadMark, slack, acked, forcedCnt, soDone, outConfirmed, lossKind, startedAfterOut>>

Deliver(p) ==
    LET a == p.a
        t == p.tok
        stale == t < sStart[a]
        used == t \in sUsed[a]
        rotate == ~stale /\ ~sRev[a] /\ ~used /\ t = sCur[a]
        code == IF stale THEN "invalid_grant" ELSE IF used THEN "refresh_token_reused" ELSE "refresh_token_invalidated"
        reply == IF rotate THEN [p EXCEPT !.st = "replied", !.rk = "ok", !.rv = sNext[a] + 1]
                 ELSE [p EXCEPT !.st = "replied", !.rk = "term", !.rv = code]
    IN
    /\ p \in net
    /\ p.st = "sent"
    /\ rotate => sNext[a] < MaxTok
    /\ sCur' = IF rotate THEN Set(sCur, a, sNext[a] + 1) ELSE sCur
    /\ sNext' = IF rotate THEN Set(sNext, a, sNext[a] + 1) ELSE sNext
    /\ sUsed' = IF rotate THEN Set(sUsed, a, sUsed[a] \cup {t}) ELSE sUsed
    /\ sRev' = IF ~rotate /\ ~stale THEN Set(sRev, a, TRUE) ELSE sRev
    /\ slack' = IF used THEN Set(slack, a, Set(slack[a], t, slack[a][t] - 1)) ELSE slack
    /\ net' = IF p.live THEN (net \ {p}) \cup {reply} ELSE net \ {p}
    /\ UNCHANGED <<diskVars, memVars, sStart, pktN, lockVars, reqVars, actVars, clock, budgetVars>>
    /\ UNCHANGED <<unreadMark, acked, badSend, forcedCnt, soDone, outConfirmed, lossKind, startedAfterOut>>

ClearTokens(a, cause, loss) ==
    /\ dState' = Set(dState, a, "needs_sign_in")
    /\ dRt' = Set(dRt, a, 0)
    /\ dCause' = Set(dCause, a, cause)
    /\ dPend' = Set(dPend, a, FALSE)
    /\ mState' = Set(mState, a, "needs_sign_in")
    /\ mRt' = Set(mRt, a, 0)
    /\ mDirty' = Set(mDirty, a, FALSE)
    /\ lossKind' = Set(lossKind, a, loss)
    /\ UNCHANGED <<dGen, dIss, dSub, dClient, dFam, mGen, mIss, mForced, mUnwr>>

ReqRecv(r) ==
    LET a == ReqAcct[r] IN
    \E p \in net :
        /\ rph[r] = "await" /\ p.id = rpkt[r] /\ p.st = "replied" /\ p.live
        /\ net' = net \ {p}
        /\ IF p.rk = "ok"
            THEN /\ acked' = Set(acked, a, acked[a] \cup {p.tok})
                 /\ rgot' = Set(rgot, r, p.rv)
                 /\ rph' = Set(rph, r, IF ForgetFirst THEN "forget" ELSE "persist")
                 /\ UNCHANGED <<diskVars, memVars, lockVars, rres, lossKind>>
            ELSE /\ ClearTokens(a, IF dPend[a] THEN "refresh_interrupted" ELSE p.rv, IF p.rv = "refresh_token_reused" THEN "reused" ELSE "other")
                 /\ Finish(r, "signIn") /\ Release(a)
                 /\ UNCHANGED <<acked, rgot>>
        /\ UNCHANGED <<srvVars, pktN, rpur, rtok, rtry, rpkt, rgen, rretried, actVars, clock, budgetVars, unreadMark, slack, badSend, forcedCnt, soDone, outConfirmed, startedAfterOut>>

ReqGiveUp(r) ==
    LET a == ReqAcct[r]
        t == rtok[r]
    IN
    \E p \in net :
        /\ rph[r] = "await" /\ p.id = rpkt[r] /\ p.live
        /\ giveups < MaxGiveUp
        /\ giveups' = giveups + 1
        /\ net' = IF p.st = "replied" THEN net \ {p} ELSE (net \ {p}) \cup {[p EXCEPT !.live = FALSE]}
        /\ slack' = Set(slack, a, Set(slack[a], t, slack[a][t] + 1))
        /\ Release(a)
        /\ IF EraseOnTransient
            THEN /\ ClearTokens(a, "transient", "other") /\ Finish(r, "signIn") /\ UNCHANGED <<rgen, startedAfterOut>>
            ELSE /\ UNCHANGED <<diskVars, memVars, lossKind>>
                 /\ IF rpur[r] = "read"
                     THEN IF Age(mIss[a]) < 2
                            THEN Begin(r, mGen[a]) /\ UNCHANGED rres
                            ELSE Finish(r, "unavailable") /\ UNCHANGED <<rgen, startedAfterOut>>
                     ELSE Finish(r, "rejected") /\ UNCHANGED <<rgen, startedAfterOut>>
        /\ UNCHANGED <<srvVars, pktN, rpur, rtok, rtry, rpkt, rgot, rretried, actVars, clock, unreadMark, acked, badSend, forcedCnt, soDone, outConfirmed, crashes, discs, signins, signouts, pfails, rejects, rvfails, detFails, unreads>>

ReqRetry(r) ==
    LET a == ReqAcct[r]
        t == rtok[r]
    IN
    \E p \in net :
        /\ rph[r] = "await" /\ p.id = rpkt[r] /\ p.live
        /\ giveups < MaxGiveUp /\ rtry[r] < MaxResend
        /\ giveups' = giveups + 1
        /\ net' = IF p.st = "replied" THEN net \ {p} ELSE (net \ {p}) \cup {[p EXCEPT !.live = FALSE]}
        /\ slack' = Set(slack, a, Set(slack[a], t, slack[a][t] + 1))
        /\ rph' = Set(rph, r, "send")
        /\ rtry' = Set(rtry, r, rtry[r] + 1)
        /\ UNCHANGED <<diskVars, memVars, srvVars, pktN, lockVars, rpur, rtok, rpkt, rgot, rgen, rretried, rres, actVars, clock, unreadMark, acked, badSend, forcedCnt, soDone, outConfirmed, lossKind, startedAfterOut, crashes, discs, signins, signouts, pfails, rejects, rvfails, detFails, unreads>>

ReqForget(r) ==
    LET a == ReqAcct[r] IN
    /\ rph[r] = "forget"
    /\ dRt' = Set(dRt, a, 0)
    /\ rph' = Set(rph, r, "persist")
    /\ UNCHANGED <<dState, dGen, dCause, dPend, dIss, dSub, dClient, dFam, memVars, srvVars, netVars, lockVars, rpur, rtok, rtry, rpkt, rgot, rgen, rretried, rres, actVars, clock, budgetVars, ghostVars>>

ReqPersist(r) ==
    LET a == ReqAcct[r]
        g == mGen[a] + 1
    IN
    /\ rph[r] = "persist"
    /\ mState' = Set(mState, a, "active")
    /\ mGen' = Set(mGen, a, g)
    /\ mRt' = Set(mRt, a, rgot[r])
    /\ mIss' = Set(mIss, a, clock)
    /\ Release(a)
    /\ rph' = Set(rph, r, "inflight")
    /\ rgen' = Set(rgen, r, g)
    /\ rretried' = Set(rretried, r, rretried[r] \/ rpur[r] = "force")
    /\ startedAfterOut' = Set(startedAfterOut, a, startedAfterOut[a] \/ soDone[a])
    /\ \/ /\ ~mUnwr[a]
          /\ dState' = Set(dState, a, "active")
          /\ dGen' = Set(dGen, a, g)
          /\ dRt' = Set(dRt, a, rgot[r])
          /\ dCause' = Set(dCause, a, None)
          /\ dPend' = Set(dPend, a, FALSE)
          /\ dIss' = Set(dIss, a, clock)
          /\ mDirty' = Set(mDirty, a, FALSE)
          /\ pfails' = pfails
          /\ UNCHANGED <<mUnwr, detFails>>
       \/ /\ ~mUnwr[a] /\ pfails < MaxPersistFail
          /\ mDirty' = Set(mDirty, a, TRUE)
          /\ pfails' = pfails + 1
          /\ UNCHANGED <<dState, dGen, dRt, dCause, dPend, dIss, mUnwr, detFails>>
       \/ /\ mUnwr[a] \/ detFails < MaxDetFail
          /\ mDirty' = Set(mDirty, a, TRUE)
          /\ mUnwr' = Set(mUnwr, a, TRUE)
          /\ detFails' = IF mUnwr[a] THEN detFails ELSE detFails + 1
          /\ UNCHANGED <<dState, dGen, dRt, dCause, dPend, dIss, pfails>>
    /\ UNCHANGED <<dSub, dClient, dFam, mForced, srvVars, netVars, rpur, rtok, rtry, rpkt, rgot, rres, actVars, clock, crashes, giveups, discs, signins, signouts, rejects, rvfails, unreads, unreadMark, slack, acked, badSend, forcedCnt, soDone, outConfirmed, lossKind>>

ReqResult(r) ==
    LET a == ReqAcct[r] IN
    /\ rph[r] = "inflight"
    /\ UNCHANGED <<diskVars, memVars, srvVars, netVars, holder, rpur, rtok, rtry, rpkt, rgot, rgen, actVars, clock, crashes, giveups, discs, signins, signouts, pfails, rvfails, detFails, unreads, ghostVars>>
    /\ \/ /\ Finish(r, "served") /\ UNCHANGED <<waitq, rretried, rejects>>
       \/ /\ sRev[a] \/ rejects < MaxReject
          /\ rejects' = IF sRev[a] THEN rejects ELSE rejects + 1
          /\ IF rretried[r]
              THEN Finish(r, "rejected") /\ UNCHANGED <<waitq, rretried>>
              ELSE rph' = Set(rph, r, "wantForce") /\ Enqueue(a, r) /\ UNCHANGED <<rres, rretried>>

ForceGrant(r) ==
    LET a == ReqAcct[r]
        g == rgen[r]
    IN
    /\ rph[r] = "wantForce"
    /\ CanTake(a, r)
    /\ UNCHANGED <<diskVars, srvVars, netVars, rtok, rtry, rpkt, rgot, actVars, clock, budgetVars, unreadMark, slack, acked, badSend, soDone, outConfirmed, lossKind>>
    /\ IF mState[a] # "active"
        THEN /\ Finish(r, Unusable(a)) /\ Pop(a) /\ UNCHANGED <<memVars, rpur, rgen, rretried, startedAfterOut, forcedCnt>>
        ELSE IF CoalesceGen /\ mGen[a] > g
            THEN /\ Begin(r, mGen[a]) /\ Pop(a) /\ rretried' = Set(rretried, r, TRUE) /\ UNCHANGED <<memVars, rpur, rres, forcedCnt>>
            ELSE IF CoalesceForced /\ mGen[a] = g /\ mForced[a] = g
                THEN /\ Finish(r, "rejected") /\ Pop(a) /\ UNCHANGED <<memVars, rpur, rgen, rretried, startedAfterOut, forcedCnt>>
                ELSE IF Blocked(a)
                    THEN /\ Finish(r, "unwritable") /\ Pop(a) /\ UNCHANGED <<memVars, rpur, rgen, rretried, startedAfterOut, forcedCnt>>
                    ELSE /\ Take(a, r)
                         /\ mForced' = Set(mForced, a, g)
                         /\ forcedCnt' = Set(forcedCnt, a, Set(forcedCnt[a], g, forcedCnt[a][g] + 1))
                         /\ rph' = Set(rph, r, NextRefreshPhase)
                         /\ rpur' = Set(rpur, r, "force")
                         /\ UNCHANGED <<mState, mGen, mRt, mDirty, mIss, mUnwr, rgen, rres, rretried, startedAfterOut>>

-----------------------------------------------------------------------------
(* Sign-in install *)

SiStart(a) ==
    /\ inPh[a] = "none" /\ signins < MaxSignIn
    /\ mState[a] # "store_unreadable" /\ ~mUnwr[a]
    /\ \E c \in Subs, s \in Accts : inCand' = Set(inCand, a, c) /\ inSrc' = Set(inSrc, a, s)
    /\ inPh' = Set(inPh, a, "want")
    /\ Enqueue(a, "in")
    /\ signins' = signins + 1
    /\ UNCHANGED <<diskVars, memVars, srvVars, netVars, holder, reqVars, outPh, prPh, clock, crashes, giveups, discs, signouts, pfails, rejects, rvfails, detFails, unreads, ghostVars>>

SiGrant(a) ==
    /\ inPh[a] = "want" /\ CanTake(a, "in")
    /\ Take(a, "in")
    /\ inPh' = Set(inPh, a, "install")
    /\ UNCHANGED <<diskVars, memVars, srvVars, netVars, reqVars, inCand, inSrc, outPh, prPh, clock, budgetVars, ghostVars>>

SiInstall(a) ==
    LET s == inSrc[a]
        n == sNext[s] + 1
        g == Max(mGen[a], dGen[a]) + 1
        allowed == ~mUnwr[a] /\ (~PinIdentity \/ (inCand[a] = dSub[a] /\ AcctClient[s] = dClient[a]))
    IN
    /\ inPh[a] = "install"
    /\ Release(a)
    /\ inPh' = Set(inPh, a, "none")
    /\ IF allowed /\ sNext[s] < MaxTok
        THEN /\ sNext' = Set(sNext, s, n) /\ sCur' = Set(sCur, s, n) /\ sStart' = Set(sStart, s, n) /\ sRev' = Set(sRev, s, FALSE)
             /\ dSub' = Set(dSub, a, inCand[a]) /\ dClient' = Set(dClient, a, AcctClient[s]) /\ dFam' = Set(dFam, a, s)
             /\ dState' = Set(dState, a, "active") /\ dGen' = Set(dGen, a, g) /\ dRt' = Set(dRt, a, n)
             /\ dCause' = Set(dCause, a, None) /\ dPend' = Set(dPend, a, FALSE) /\ dIss' = Set(dIss, a, clock)
             /\ mState' = Set(mState, a, "active") /\ mGen' = Set(mGen, a, g) /\ mRt' = Set(mRt, a, n)
             /\ mDirty' = Set(mDirty, a, FALSE) /\ mIss' = Set(mIss, a, clock) /\ mForced' = Set(mForced, a, 0)
             /\ soDone' = Set(soDone, a, FALSE) /\ outConfirmed' = Set(outConfirmed, a, None) /\ lossKind' = Set(lossKind, a, None)
             /\ UNCHANGED <<sUsed, mUnwr>>
        ELSE UNCHANGED <<diskVars, memVars, srvVars, soDone, outConfirmed, lossKind>>
    /\ UNCHANGED <<netVars, reqVars, inCand, inSrc, outPh, prPh, clock, budgetVars, unreadMark, slack, acked, badSend, forcedCnt, startedAfterOut>>

-----------------------------------------------------------------------------
(* Sign-out *)

SoStart(a) ==
    /\ outPh[a] = "none" /\ signouts < MaxSignOut
    /\ dState[a] \in {"active", "needs_sign_in"} /\ mState[a] \in {"active", "needs_sign_in"} /\ ~mUnwr[a]
    /\ outPh' = Set(outPh, a, "want")
    /\ signouts' = signouts + 1
    /\ IF SignOutWaits THEN Enqueue(a, "out") ELSE UNCHANGED waitq
    /\ UNCHANGED <<diskVars, memVars, srvVars, netVars, holder, reqVars, inPh, inCand, inSrc, prPh, clock, crashes, giveups, discs, signins, pfails, rejects, rvfails, detFails, unreads, ghostVars>>

SoGrant(a) ==
    /\ outPh[a] = "want"
    /\ IF mUnwr[a]
        THEN /\ IF SignOutWaits THEN CanTake(a, "out") /\ Pop(a) ELSE UNCHANGED lockVars
             /\ outPh' = Set(outPh, a, "none")
             /\ UNCHANGED <<diskVars, memVars>>
        ELSE /\ IF SignOutWaits THEN CanTake(a, "out") /\ Take(a, "out") ELSE UNCHANGED lockVars
             /\ dState' = Set(dState, a, "signing_out")
             /\ mState' = Set(mState, a, "signing_out")
             /\ outPh' = Set(outPh, a, IF mRt[a] = 0 THEN "clear" ELSE "revoke")
             /\ UNCHANGED <<dGen, dRt, dCause, dPend, dIss, dSub, dClient, dFam, mGen, mRt, mDirty, mIss, mForced, mUnwr>>
    /\ UNCHANGED <<srvVars, netVars, reqVars, inPh, inCand, inSrc, prPh, clock, budgetVars, ghostVars>>

SoRevoke(a) ==
    LET t == mRt[a] IN
    /\ outPh[a] = "revoke"
    /\ outPh' = Set(outPh, a, "clear")
    /\ \/ /\ sRev' = IF t = sCur[a] /\ t >= sStart[a] THEN Set(sRev, a, TRUE) ELSE sRev
          /\ outConfirmed' = Set(outConfirmed, a, IF GateConfirm /\ (dPend[a] \/ mDirty[a]) THEN "no" ELSE "yes")
          /\ rvfails' = rvfails
       \/ /\ rvfails < MaxRevokeFail
          /\ rvfails' = rvfails + 1
          /\ outConfirmed' = Set(outConfirmed, a, "no")
          /\ UNCHANGED sRev
    /\ UNCHANGED <<diskVars, memVars, sCur, sUsed, sStart, sNext, netVars, lockVars, reqVars, inPh, inCand, inSrc, prPh, clock, crashes, giveups, discs, signins, signouts, pfails, rejects, detFails, unreads>>
    /\ UNCHANGED <<unreadMark, slack, acked, badSend, forcedCnt, soDone, lossKind, startedAfterOut>>

SoClear(a) ==
    /\ outPh[a] = "clear"
    /\ dState' = Set(dState, a, "registered")
    /\ dRt' = Set(dRt, a, 0)
    /\ dCause' = Set(dCause, a, None)
    /\ dPend' = Set(dPend, a, FALSE)
    /\ mState' = Set(mState, a, "registered")
    /\ mRt' = Set(mRt, a, 0)
    /\ mDirty' = Set(mDirty, a, FALSE)
    /\ soDone' = Set(soDone, a, TRUE)
    /\ lossKind' = Set(lossKind, a, None)
    /\ outPh' = Set(outPh, a, "none")
    /\ IF SignOutWaits THEN Release(a) ELSE UNCHANGED lockVars
    /\ UNCHANGED <<dGen, dIss, dSub, dClient, dFam, mGen, mIss, mForced, mUnwr, srvVars, netVars, reqVars, inPh, inCand, inSrc, prPh, clock, budgetVars, unreadMark, slack, acked, badSend, forcedCnt, outConfirmed, startedAfterOut>>

-----------------------------------------------------------------------------
(* Persist retry *)

PrStart(a) ==
    /\ prPh[a] = "none" /\ mDirty[a] /\ mState[a] = "active" /\ ~mUnwr[a]
    /\ prPh' = Set(prPh, a, "want")
    /\ Enqueue(a, "pr")
    /\ UNCHANGED <<diskVars, memVars, srvVars, netVars, holder, reqVars, inPh, inCand, inSrc, outPh, clock, budgetVars, ghostVars>>

PrGrant(a) ==
    /\ prPh[a] = "want" /\ CanTake(a, "pr")
    /\ Take(a, "pr")
    /\ prPh' = Set(prPh, a, "write")
    /\ UNCHANGED <<diskVars, memVars, srvVars, netVars, reqVars, inPh, inCand, inSrc, outPh, clock, budgetVars, ghostVars>>

PrWrite(a) ==
    /\ prPh[a] = "write"
    /\ prPh' = Set(prPh, a, "none")
    /\ Release(a)
    /\ \/ /\ mDirty[a] /\ mState[a] = "active" /\ ~mUnwr[a]
          /\ dState' = Set(dState, a, "active")
          /\ dGen' = Set(dGen, a, mGen[a])
          /\ dRt' = Set(dRt, a, mRt[a])
          /\ dCause' = Set(dCause, a, None)
          /\ dPend' = Set(dPend, a, FALSE)
          /\ dIss' = Set(dIss, a, mIss[a])
          /\ mDirty' = Set(mDirty, a, FALSE)
          /\ UNCHANGED <<pfails, detFails, mUnwr>>
       \/ /\ ~mDirty[a] \/ mState[a] # "active"
          /\ UNCHANGED <<dState, dGen, dRt, dCause, dPend, dIss, mDirty, pfails, detFails, mUnwr>>
       \/ /\ mDirty[a] /\ mState[a] = "active" /\ ~mUnwr[a] /\ pfails < MaxPersistFail
          /\ pfails' = pfails + 1
          /\ UNCHANGED <<dState, dGen, dRt, dCause, dPend, dIss, mDirty, detFails, mUnwr>>
       \/ /\ mDirty[a] /\ mState[a] = "active" /\ (mUnwr[a] \/ detFails < MaxDetFail)
          /\ mUnwr' = Set(mUnwr, a, TRUE)
          /\ detFails' = IF mUnwr[a] THEN detFails ELSE detFails + 1
          /\ UNCHANGED <<dState, dGen, dRt, dCause, dPend, dIss, mDirty, pfails>>
    /\ UNCHANGED <<dSub, dClient, dFam, mState, mGen, mRt, mIss, mForced, srvVars, netVars, reqVars, inPh, inCand, inSrc, outPh, clock, crashes, giveups, discs, signins, signouts, rejects, rvfails, unreads, ghostVars>>

-----------------------------------------------------------------------------
(* Faults *)

Disc(a) ==
    /\ discs < MaxDisc
    /\ discs' = discs + 1
    /\ sRev' = Set(sRev, a, TRUE)
    /\ UNCHANGED <<diskVars, memVars, sCur, sUsed, sStart, sNext, netVars, lockVars, reqVars, actVars, clock, crashes, giveups, signins, signouts, pfails, rejects, rvfails, detFails, unreads, ghostVars>>

Crash ==
    /\ crashes < MaxCrash
    /\ crashes' = crashes + 1
    /\ \E u \in Accts \cup {None} :
        /\ u # None => unreads < MaxUnreadable
        /\ unreads' = IF u = None THEN unreads ELSE unreads + 1
        /\ unreadMark' = [a \in Accts |-> a = u]
        /\ mState' = [a \in Accts |-> IF a = u THEN (IF UnreadableAsSignIn THEN "needs_sign_in" ELSE "store_unreadable") ELSE dState[a]]
        /\ mRt' = [a \in Accts |-> IF a = u THEN 0 ELSE dRt[a]]
        /\ holder' = [a \in Accts |-> IF UseMutex /\ SignOutWaits /\ dState[a] = "signing_out" /\ a # u THEN "out" ELSE None]
        /\ outPh' = [a \in Accts |-> IF dState[a] = "signing_out" /\ a # u THEN IF dRt[a] = 0 THEN "clear" ELSE "revoke" ELSE "none"]
    /\ mGen' = dGen
    /\ mDirty' = [a \in Accts |-> FALSE]
    /\ mIss' = dIss
    /\ mForced' = [a \in Accts |-> 0]
    /\ mUnwr' = [a \in Accts |-> FALSE]
    /\ net' = {[p EXCEPT !.live = FALSE] : p \in {q \in net : q.st = "sent"}}
    /\ slack' = [a \in Accts |-> [t \in Toks |->
                  slack[a][t]
                  + Cardinality({p \in net : p.a = a /\ p.tok = t /\ p.live})
                  + (IF t = dRt[a] /\ t \in acked[a] THEN 1 ELSE 0)]]
    /\ acked' = [a \in Accts |-> {}]
    /\ waitq' = [a \in Accts |-> <<>>]
    /\ rph' = [r \in Reqs |-> IF rph[r] \in {"idle", "done"} THEN rph[r] ELSE "done"]
    /\ rres' = [r \in Reqs |-> IF rph[r] \in {"idle", "done"} THEN rres[r] ELSE "aborted"]
    /\ inPh' = [a \in Accts |-> "none"]
    /\ prPh' = [a \in Accts |-> "none"]
    /\ forcedCnt' = [a \in Accts |-> [g \in Gens |-> 0]]
    /\ UNCHANGED <<diskVars, srvVars, pktN, rpur, rtok, rtry, rpkt, rgot, rgen, rretried, inCand, inSrc, clock, giveups, discs, signins, signouts, pfails, rejects, rvfails, detFails>>
    /\ UNCHANGED <<badSend, soDone, outConfirmed, lossKind, startedAfterOut>>

AllDone == \A r \in Reqs : rph[r] = "done"

Terminated == AllDone /\ UNCHANGED vars

Next ==
    \/ Tick
    \/ \E r \in Reqs : Start(r) \/ ReqGrant(r) \/ ReqPend(r) \/ ReqSend(r) \/ ReqRecv(r) \/ ReqGiveUp(r) \/ ReqRetry(r)
                       \/ ReqForget(r) \/ ReqPersist(r) \/ ReqResult(r) \/ ForceGrant(r)
    \/ \E p \in net : Deliver(p)
    \/ \E a \in Accts : SiStart(a) \/ SiGrant(a) \/ SiInstall(a) \/ SoStart(a) \/ SoGrant(a) \/ SoRevoke(a) \/ SoClear(a)
                        \/ PrStart(a) \/ PrGrant(a) \/ PrWrite(a) \/ Disc(a)
    \/ Crash
    \/ Terminated

Fairness ==
    /\ \A r \in Reqs : WF_vars(Start(r)) /\ WF_vars(ReqGrant(r)) /\ WF_vars(ReqPend(r)) /\ WF_vars(ReqSend(r))
                       /\ WF_vars(ReqRecv(r)) /\ WF_vars(ReqForget(r)) /\ WF_vars(ReqPersist(r))
                       /\ WF_vars(ReqResult(r)) /\ WF_vars(ForceGrant(r))
    /\ WF_vars(\E p \in net : Deliver(p))
    /\ \A a \in Accts : WF_vars(SiGrant(a)) /\ WF_vars(SiInstall(a)) /\ WF_vars(SoGrant(a)) /\ WF_vars(SoRevoke(a))
                        /\ WF_vars(SoClear(a)) /\ WF_vars(PrGrant(a)) /\ WF_vars(PrWrite(a))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
    /\ \A a \in Accts : dState[a] \in AcctStates /\ mState[a] \in AcctStates
    /\ \A a \in Accts : dRt[a] \in Toks /\ mRt[a] \in Toks /\ dGen[a] \in Gens /\ mGen[a] \in Gens
    /\ \A a \in Accts : dCause[a] \in Causes /\ dPend[a] \in BOOLEAN /\ mDirty[a] \in BOOLEAN /\ mUnwr[a] \in BOOLEAN
    /\ \A a \in Accts : sCur[a] \in Toks /\ sUsed[a] \subseteq Toks /\ sRev[a] \in BOOLEAN
    /\ \A r \in Reqs : rph[r] \in {"idle", "want", "pend", "send", "await", "forget", "persist", "inflight", "wantForce", "done"}
    /\ \A a \in Accts : holder[a] \in {None, "in", "out", "pr"} \cup Reqs

SingleUse == \A a \in Accts : ~badSend[a] /\ \A t \in Toks : slack[a][t] >= 0

Critical(a) ==
    {r \in Reqs : ReqAcct[r] = a /\ rph[r] \in {"pend", "send", "await", "forget", "persist"}}
    \cup (IF inPh[a] = "install" THEN {"in"} ELSE {})
    \cup (IF outPh[a] \in {"revoke", "clear"} THEN {"out"} ELSE {})
    \cup (IF prPh[a] = "write" THEN {"pr"} ELSE {})

MutualExclusion == \A a \in Accts : Cardinality(Critical(a)) <= 1

PersistBeforeForget ==
    \A a \in Accts :
        /\ dState[a] = "active" => dRt[a] # 0
        /\ (mState[a] = "active" /\ mGen[a] > dGen[a]) => (mDirty[a] /\ mGen[a] = dGen[a] + 1)

NoRefreshWhileUnwritable ==
    \A a \in Accts : mUnwr[a] => \A r \in Reqs : ReqAcct[r] = a => rph[r] \notin {"pend", "send", "await", "forget", "persist"}

UnreadableKeepsMeaning == \A a \in Accts : unreadMark[a] => mState[a] = "store_unreadable"

NoEraseOnTransient ==
    \A a \in Accts : (dState[a] = "needs_sign_in" => sRev[a]) /\ (mState[a] = "needs_sign_in" => sRev[a])

LossDetected ==
    \A a \in Accts : (dState[a] = "needs_sign_in" => dCause[a] # None) /\ dSub[a] = AcctSub[a] /\ dClient[a] = AcctClient[a]

CauseAttributed ==
    \A a \in Accts : (dState[a] = "needs_sign_in" /\ lossKind[a] = "reused") => dCause[a] = "refresh_interrupted"

IdentityPinned == [][\A a \in Accts : (dSub'[a] = dSub[a] \/ dSub[a] = None) /\ (dClient'[a] = dClient[a] \/ dClient[a] = 0)]_vars

DiskOf(a) == <<dState[a], dGen[a], dRt[a], dCause[a], dPend[a], dIss[a], dSub[a], dClient[a], dFam[a]>>

AccountsIsolated == \A a \in Accts : dFam[a] = a /\ dClient[a] = AcctClient[a]

OtherAccountsUntouched == [][Cardinality({a \in Accts : DiskOf(a)' # DiskOf(a)}) <= 1]_vars

Coalesced == \A a \in Accts : \A g \in Gens : forcedCnt[a][g] <= 1

SignOutFinal ==
    \A a \in Accts : soDone[a] => (dRt[a] = 0 /\ mRt[a] = 0 /\ ~startedAfterOut[a])

SignOutRevokesFamily ==
    \A a \in Accts : (soDone[a] /\ outConfirmed[a] = "yes") => sRev[a]

Settles == \A r \in Reqs : rph[r] # "idle" ~> rph[r] = "done"

AllServed == <>(\A r \in Reqs : rres[r] = "served")

=========================================================================
