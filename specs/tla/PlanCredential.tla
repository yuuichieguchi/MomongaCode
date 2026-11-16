------------------------- MODULE PlanCredential -------------------------
EXTENDS Integers, FiniteSets, Sequences

CONSTANTS
    Reqs, SecondReqs, SecondAcct,
    MaxClock, MaxCrash, MaxGiveUp, MaxDisc, MaxSignIn, MaxSignOut,
    MaxPersistFail, MaxReject, MaxRevokeFail, MaxSoAbort, ResumeAtLoad,
    UseMutex, CoalesceGen, CoalesceForced, EraseOnTransient, ForgetFirst, SignOutWaits, Intent,
    PinIdentity, GateConfirm, MaxResend,
    MaxDetFail, MaxUnreadable, RefreshWhenUnwritable, UnreadableAsSignIn,
    MaxNoAdopt, WeakForms, NoAdoptRule, LegacyCause, TransientSignsOut,
    TwoGens, MaxMove

ASSUME Reqs # {} /\ SecondReqs \subseteq Reqs /\ SecondAcct \in BOOLEAN /\ (SecondReqs # {} => SecondAcct)

Accts == IF SecondAcct THEN {"a1", "a2"} ELSE {"a1"}
Subs == {"s1", "s2"}
AcctSub == [a \in Accts |-> IF a = "a1" THEN "s1" ELSE "s2"]
AcctClient == [a \in Accts |-> IF a = "a1" THEN 1 ELSE 2]
ReqAcct == [r \in Reqs |-> IF r \in SecondReqs THEN "a2" ELSE "a1"]

ASSUME \A c \in {MaxClock, MaxCrash, MaxGiveUp, MaxDisc, MaxSignIn, MaxSignOut, MaxPersistFail, MaxReject, MaxRevokeFail, MaxSoAbort} : c \in Nat
ASSUME \A c \in {UseMutex, CoalesceGen, CoalesceForced, EraseOnTransient, ForgetFirst, SignOutWaits, Intent, PinIdentity, GateConfirm, ResumeAtLoad} : c \in BOOLEAN
ASSUME \A c \in {MaxResend, MaxDetFail, MaxUnreadable} : c \in Nat
ASSUME \A c \in {RefreshWhenUnwritable, UnreadableAsSignIn} : c \in BOOLEAN
ASSUME LegacyCause \in BOOLEAN
ASSUME TransientSignsOut \in BOOLEAN
ASSUME TwoGens \in {"off", "reread", "stale"} /\ MaxMove \in Nat
ASSUME TwoGens # "off" => SecondAcct = FALSE
ASSUME MaxNoAdopt \in Nat
ASSUME WeakForms \subseteq {"short", "noRtRotated", "noRtKept"}
ASSUME NoAdoptRule \in {"transient", "reject", "unanswered", "adopt", "signIn"}

None == "none"
MaxTok == 9
Toks == 0..MaxTok
Gens == 0..(MaxTok + 3)

TerminalCodes == {"refresh_token_reused", "refresh_token_invalidated", "invalid_grant"}
Flags == {"interrupted"}
EvidenceOnlyCauses == {"refresh_interrupted", "transient"}
Causes == TerminalCodes \cup EvidenceOnlyCauses \cup {None}
AcctStates == {"active", "needs_sign_in", "signing_out", "registered", "store_unreadable"}
PointerKeys == {"k1", "k2"}

VARIABLES
    dState, dGen, dRt, dCause, dPend, dIss, dSub, dClient, dFam,
    mState, mGen, mRt, mDirty, mIss, mForced, mUnwr,
    sCur, sUsed, sRev, sStart, sNext,
    net, pktN,
    holder, waitq,
    rph, rpur, rtok, rtry, rpkt, rgot, rgen, rretried, rres,
    inPh, inCand, inSrc, outPh, prPh,
    clock,
    crashes, giveups, discs, signins, signouts, pfails, rejects, rvfails, detFails, unreads, soAborts,
    unreadMark, slack, acked, badSend, forcedCnt, soDone, outConfirmed, lossKind, startedAfterOut,
    noadopts, dropped, silentRot, dInt, rint,
    gPh, gGen, gRt, gState, gTok, gPkt, staleOut, dAct, mAct, gAct, actWant, moves

diskVars == <<dState, dGen, dRt, dCause, dPend, dIss, dSub, dClient, dFam>>
memVars == <<mState, mGen, mRt, mDirty, mIss, mForced, mUnwr>>
srvVars == <<sCur, sUsed, sRev, sStart, sNext>>
netVars == <<net, pktN>>
lockVars == <<holder, waitq>>
reqVars == <<rph, rpur, rtok, rtry, rpkt, rgot, rgen, rretried, rres>>
actVars == <<inPh, inCand, inSrc, outPh, prPh>>
budgetVars == <<crashes, giveups, discs, signins, signouts, pfails, rejects, rvfails, detFails, unreads, soAborts>>
ghostVars == <<unreadMark, slack, acked, badSend, forcedCnt, soDone, outConfirmed, lossKind, startedAfterOut>>
extraVars == <<noadopts, dropped, silentRot, dInt, rint>>
oldGenVars == <<gPh, gGen, gRt, gState, gTok, gPkt>>
pointerVars == <<dAct, mAct, gAct, actWant, moves>>
twoVars == <<oldGenVars, staleOut, pointerVars>>
vars == <<diskVars, memVars, srvVars, netVars, lockVars, reqVars, actVars, clock, budgetVars, ghostVars, extraVars, twoVars>>

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
    /\ signouts = 0 /\ pfails = 0 /\ rejects = 0 /\ rvfails = 0 /\ detFails = 0 /\ unreads = 0 /\ soAborts = 0
    /\ unreadMark = [a \in Accts |-> FALSE]
    /\ slack = [a \in Accts |-> [t \in Toks |-> 0]]
    /\ acked = [a \in Accts |-> {}]
    /\ badSend = [a \in Accts |-> FALSE]
    /\ forcedCnt = [a \in Accts |-> [g \in Gens |-> 0]]
    /\ soDone = [a \in Accts |-> FALSE]
    /\ outConfirmed = [a \in Accts |-> None]
    /\ lossKind = [a \in Accts |-> None]
    /\ startedAfterOut = [a \in Accts |-> FALSE]
    /\ noadopts = 0
    /\ dropped = [a \in Accts |-> FALSE]
    /\ silentRot = [a \in Accts |-> FALSE]
    /\ dInt = [a \in Accts |-> FALSE]
    /\ rint = [r \in Reqs |-> FALSE]
    /\ gPh = IF TwoGens = "off" THEN "done" ELSE "idle"
    /\ gGen = 1
    /\ gRt = 1
    /\ gState = "active"
    /\ gTok = 0
    /\ gPkt = 0
    /\ staleOut = FALSE
    /\ dAct = [k \in PointerKeys |-> 0]
    /\ mAct = [k \in PointerKeys |-> 0]
    /\ gAct = [k \in PointerKeys |-> 0]
    /\ actWant = [k \in PointerKeys |-> 0]
    /\ moves = 0

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

GrantPhase == IF TwoGens = "reread" THEN "reread" ELSE NextRefreshPhase

ReqReRead(r) ==
    LET a == ReqAcct[r] IN
    /\ rph[r] = "reread"
    /\ UNCHANGED <<diskVars, mForced, mUnwr, srvVars, netVars, waitq, rpur, rtok, rtry, rpkt, rgot, actVars, clock, budgetVars>>
    /\ UNCHANGED <<unreadMark, slack, acked, badSend, forcedCnt, soDone, outConfirmed, lossKind>>
    /\ IF mDirty[a]
        THEN /\ rph' = Set(rph, r, NextRefreshPhase)
             /\ UNCHANGED <<mState, mGen, mRt, mIss, mDirty, holder, rgen, rretried, rres, startedAfterOut>>
        ELSE /\ mState' = Set(mState, a, dState[a])
             /\ mGen' = Set(mGen, a, dGen[a])
             /\ mRt' = Set(mRt, a, dRt[a])
             /\ mIss' = Set(mIss, a, dIss[a])
             /\ UNCHANGED mDirty
             /\ IF dState[a] # "active"
                 THEN Finish(r, "signIn") /\ Release(a) /\ UNCHANGED <<rgen, rretried, startedAfterOut>>
                 ELSE IF dGen[a] > mGen[a]
                     THEN /\ Begin(r, dGen[a]) /\ Release(a) /\ UNCHANGED rres
                          /\ rretried' = Set(rretried, r, rretried[r] \/ rpur[r] = "force")
                     ELSE /\ rph' = Set(rph, r, NextRefreshPhase)
                          /\ UNCHANGED <<holder, rgen, rretried, rres, startedAfterOut>>

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
                ELSE /\ Take(a, r) /\ rph' = Set(rph, r, GrantPhase) /\ rpur' = Set(rpur, r, "read") /\ UNCHANGED <<rgen, rres, startedAfterOut>>

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
    /\ rint' = Set(rint, r, dPend[a])
    /\ UNCHANGED <<dCause, dSub, dClient, dFam, mState, mGen, mRt, mIss, mForced, mUnwr, srvVars, netVars, lockVars, rpur, rtok, rtry, rpkt, rgot, rgen, rretried, rres, actVars, clock, budgetVars, ghostVars, noadopts, dropped, silentRot, dInt>>

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
    IN
    /\ p \in net
    /\ p.st = "sent"
    /\ \E f \in {"std"} \cup (IF rotate /\ noadopts < MaxNoAdopt THEN WeakForms ELSE {}) :
        LET kept == (f = "noRtKept")
            adv == rotate /\ ~kept
            reply == IF rotate THEN [p EXCEPT !.st = "replied", !.rk = IF f = "std" THEN "ok" ELSE f, !.rv = IF kept THEN t ELSE sNext[a] + 1]
                     ELSE [p EXCEPT !.st = "replied", !.rk = "term", !.rv = code]
        IN
        /\ adv => sNext[a] < MaxTok
        /\ sCur' = IF adv THEN Set(sCur, a, sNext[a] + 1) ELSE sCur
        /\ sNext' = IF adv THEN Set(sNext, a, sNext[a] + 1) ELSE sNext
        /\ sUsed' = IF adv THEN Set(sUsed, a, sUsed[a] \cup {t}) ELSE sUsed
        /\ sRev' = IF ~rotate /\ ~stale THEN Set(sRev, a, TRUE) ELSE sRev
        /\ slack' = IF used THEN Set(slack, a, Set(slack[a], t, slack[a][t] - 1)) ELSE slack
        /\ net' = IF p.live THEN (net \ {p}) \cup {reply} ELSE net \ {p}
        /\ noadopts' = IF f = "std" THEN noadopts ELSE noadopts + 1
        /\ silentRot' = IF f = "noRtRotated" THEN Set(silentRot, a, TRUE) ELSE silentRot
    /\ UNCHANGED <<diskVars, memVars, sStart, pktN, lockVars, reqVars, actVars, clock, budgetVars>>
    /\ UNCHANGED <<unreadMark, acked, badSend, forcedCnt, soDone, outConfirmed, lossKind, startedAfterOut, dropped, dInt, rint>>

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
        /\ rph[r] = "await" /\ p.id = rpkt[r] /\ p.st = "replied" /\ p.live /\ p.rk \in {"ok", "term"}
        /\ net' = net \ {p}
        /\ IF p.rk = "ok"
            THEN /\ acked' = Set(acked, a, acked[a] \cup {p.tok})
                 /\ rgot' = Set(rgot, r, p.rv)
                 /\ rph' = Set(rph, r, IF ForgetFirst THEN "forget" ELSE "persist")
                 /\ UNCHANGED <<diskVars, memVars, lockVars, rres, lossKind>>
            ELSE /\ ClearTokens(a, IF LegacyCause /\ dPend[a] THEN "refresh_interrupted" ELSE p.rv, IF p.rv = "refresh_token_reused" THEN "reused" ELSE "other")
                 /\ Finish(r, "signIn") /\ Release(a)
                 /\ UNCHANGED <<acked, rgot>>
        /\ dInt' = IF p.rk = "ok" THEN dInt ELSE Set(dInt, a, rint[r])
        /\ staleOut' = IF p.rk = "ok" THEN staleOut ELSE staleOut \/ rtok[r] # dRt[a]
        /\ UNCHANGED <<oldGenVars, pointerVars>>
        /\ UNCHANGED <<srvVars, pktN, rpur, rtok, rtry, rpkt, rgen, rretried, actVars, clock, budgetVars, unreadMark, slack, badSend, forcedCnt, soDone, outConfirmed, startedAfterOut, noadopts, dropped, silentRot, rint>>

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
        /\ rint' = Set(rint, r, TRUE)
        /\ UNCHANGED <<srvVars, pktN, rpur, rtok, rtry, rpkt, rgot, rretried, actVars, clock, unreadMark, acked, badSend, forcedCnt, soDone, outConfirmed, crashes, discs, signins, signouts, pfails, rejects, rvfails, detFails, unreads, soAborts, noadopts, dropped, silentRot, dInt>>

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
        /\ rint' = Set(rint, r, TRUE)
        /\ UNCHANGED <<diskVars, memVars, srvVars, pktN, lockVars, rpur, rtok, rpkt, rgot, rgen, rretried, rres, actVars, clock, unreadMark, acked, badSend, forcedCnt, soDone, outConfirmed, lossKind, startedAfterOut, crashes, discs, signins, signouts, pfails, rejects, rvfails, detFails, unreads, soAborts, noadopts, dropped, silentRot, dInt>>

ReqWeak(r) ==
    LET a == ReqAcct[r]
        t == rtok[r]
    IN
    \E p \in net :
        /\ rph[r] = "await" /\ p.id = rpkt[r] /\ p.st = "replied" /\ p.live /\ p.rk \in WeakForms
        /\ net' = net \ {p}
        /\ LET lost == p.rk # "noRtKept"
               EndRefresh ==
                   /\ Release(a)
                   /\ IF rpur[r] = "read"
                       THEN IF Age(mIss[a]) < 2
                              THEN Begin(r, mGen[a]) /\ UNCHANGED rres
                              ELSE Finish(r, "unavailable") /\ UNCHANGED <<rgen, startedAfterOut>>
                       ELSE Finish(r, "rejected") /\ UNCHANGED <<rgen, startedAfterOut>>
           IN
           \/ /\ NoAdoptRule \in {"transient", "reject", "unanswered"}
              /\ acked' = IF NoAdoptRule = "unanswered" THEN acked ELSE Set(acked, a, acked[a] \cup {t})
              /\ slack' = IF NoAdoptRule = "unanswered" THEN Set(slack, a, Set(slack[a], t, slack[a][t] + 1)) ELSE slack
              /\ dropped' = Set(dropped, a, dropped[a] \/ lost)
              /\ \/ /\ NoAdoptRule \in {"transient", "unanswered"} /\ rtry[r] < MaxResend
                    /\ rph' = Set(rph, r, "send") /\ rtry' = Set(rtry, r, rtry[r] + 1)
                    /\ UNCHANGED <<lockVars, rgen, rres, startedAfterOut>>
                 \/ /\ EndRefresh /\ UNCHANGED rtry
              /\ UNCHANGED <<diskVars, memVars, lossKind, rgot>>
           \/ /\ NoAdoptRule = "signIn"
              /\ ClearTokens(a, "transient", "other")
              /\ UNCHANGED slack
              /\ acked' = Set(acked, a, acked[a] \cup {t})
              /\ dropped' = Set(dropped, a, dropped[a] \/ lost)
              /\ Finish(r, "signIn") /\ Release(a)
              /\ UNCHANGED <<rgen, startedAfterOut, rtry, rgot>>
           \/ /\ NoAdoptRule = "adopt"
              /\ rph' = Set(rph, r, IF ForgetFirst THEN "forget" ELSE "persist")
              /\ rgot' = Set(rgot, r, IF p.rk = "short" THEN p.rv ELSE t)
              /\ acked' = IF p.rk = "short" THEN Set(acked, a, acked[a] \cup {t}) ELSE acked
              /\ UNCHANGED <<diskVars, memVars, lockVars, rres, lossKind, dropped, rtry, rgen, startedAfterOut, slack>>
        /\ UNCHANGED <<srvVars, pktN, rpur, rtok, rpkt, rretried, actVars, clock, budgetVars, unreadMark, badSend, forcedCnt, soDone, outConfirmed, noadopts, silentRot, dInt, rint>>

Quiet(A) == A /\ UNCHANGED <<extraVars, twoVars>>

Two(A) == A /\ UNCHANGED twoVars

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
          /\ dPend' = Set(dPend, a, IF rgot[r] = rtok[r] THEN rint[r] ELSE FALSE)
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
    /\ UNCHANGED <<dSub, dClient, dFam, mForced, srvVars, netVars, rpur, rtok, rtry, rpkt, rgot, rres, actVars, clock, crashes, giveups, discs, signins, signouts, rejects, rvfails, unreads, soAborts, unreadMark, slack, acked, badSend, forcedCnt, soDone, outConfirmed, lossKind>>

ReqResult(r) ==
    LET a == ReqAcct[r] IN
    /\ rph[r] = "inflight"
    /\ UNCHANGED <<diskVars, memVars, srvVars, netVars, holder, rpur, rtok, rtry, rpkt, rgot, rgen, actVars, clock, crashes, giveups, discs, signins, signouts, pfails, rvfails, detFails, unreads, soAborts, ghostVars>>
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
                         /\ rph' = Set(rph, r, GrantPhase)
                         /\ rpur' = Set(rpur, r, "force")
                         /\ UNCHANGED <<mState, mGen, mRt, mDirty, mIss, mUnwr, rgen, rres, rretried, startedAfterOut>>

-----------------------------------------------------------------------------

SiStart(a) ==
    /\ inPh[a] = "none" /\ signins < MaxSignIn
    /\ mState[a] # "store_unreadable" /\ ~mUnwr[a]
    /\ \E c \in Subs, s \in Accts : inCand' = Set(inCand, a, c) /\ inSrc' = Set(inSrc, a, s)
    /\ inPh' = Set(inPh, a, "want")
    /\ Enqueue(a, "in")
    /\ signins' = signins + 1
    /\ UNCHANGED <<diskVars, memVars, srvVars, netVars, holder, reqVars, outPh, prPh, clock, crashes, giveups, discs, signouts, pfails, rejects, rvfails, detFails, unreads, soAborts, ghostVars>>

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

SoStart(a) ==
    /\ outPh[a] = "none" /\ signouts < MaxSignOut
    /\ dState[a] \in {"active", "needs_sign_in"} /\ mState[a] \in {"active", "needs_sign_in"} /\ ~mUnwr[a]
    /\ outPh' = Set(outPh, a, "want")
    /\ signouts' = signouts + 1
    /\ IF SignOutWaits THEN Enqueue(a, "out") ELSE UNCHANGED waitq
    /\ UNCHANGED <<diskVars, memVars, srvVars, netVars, holder, reqVars, inPh, inCand, inSrc, prPh, clock, crashes, giveups, discs, signins, pfails, rejects, rvfails, detFails, unreads, soAborts, ghostVars>>

SoGrant(a) ==
    /\ outPh[a] = "want"
    /\ IF mUnwr[a]
        THEN /\ IF SignOutWaits THEN CanTake(a, "out") /\ Pop(a) ELSE UNCHANGED lockVars
             /\ outPh' = Set(outPh, a, "none")
             /\ UNCHANGED <<diskVars, memVars>>
        ELSE LET reread == TwoGens = "reread" /\ ~mDirty[a]
                 rt == IF reread THEN dRt[a] ELSE mRt[a]
             IN
             /\ IF SignOutWaits THEN CanTake(a, "out") /\ Take(a, "out") ELSE UNCHANGED lockVars
             /\ dState' = Set(dState, a, "signing_out")
             /\ mState' = Set(mState, a, "signing_out")
             /\ mRt' = Set(mRt, a, rt)
             /\ mGen' = IF reread THEN Set(mGen, a, dGen[a]) ELSE mGen
             /\ mIss' = IF reread THEN Set(mIss, a, dIss[a]) ELSE mIss
             /\ outPh' = Set(outPh, a, IF rt = 0 THEN "clear" ELSE "revoke")
             /\ UNCHANGED <<dGen, dRt, dCause, dPend, dIss, dSub, dClient, dFam, mDirty, mForced, mUnwr>>
    /\ UNCHANGED <<srvVars, netVars, reqVars, inPh, inCand, inSrc, prPh, clock, budgetVars, ghostVars>>

SoGrantFails(a) ==
    /\ outPh[a] = "want" /\ ~mUnwr[a] /\ pfails < MaxPersistFail
    /\ IF SignOutWaits THEN CanTake(a, "out") /\ Pop(a) ELSE UNCHANGED lockVars
    /\ pfails' = pfails + 1
    /\ outPh' = Set(outPh, a, "none")
    /\ UNCHANGED <<diskVars, memVars, srvVars, netVars, reqVars, inPh, inCand, inSrc, prPh, clock, crashes, giveups, discs, signins, signouts, rejects, rvfails, detFails, unreads, soAborts, ghostVars>>

ReqPersistSignsOut(r) ==
    LET a == ReqAcct[r] IN
    /\ TransientSignsOut
    /\ rph[r] = "persist" /\ ~mUnwr[a] /\ pfails < MaxPersistFail
    /\ pfails' = pfails + 1
    /\ ClearTokens(a, "transient", "other")
    /\ Finish(r, "signIn") /\ Release(a)
    /\ UNCHANGED <<srvVars, netVars, rpur, rtok, rtry, rpkt, rgot, rgen, rretried, actVars, clock, crashes, giveups, discs, signins, signouts, rejects, rvfails, detFails, unreads, soAborts, unreadMark, slack, acked, badSend, forcedCnt, soDone, outConfirmed, startedAfterOut>>

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
    /\ UNCHANGED <<diskVars, memVars, sCur, sUsed, sStart, sNext, netVars, lockVars, reqVars, inPh, inCand, inSrc, prPh, clock, crashes, giveups, discs, signins, signouts, pfails, rejects, detFails, unreads, soAborts>>
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

SoAbort(a) ==
    /\ outPh[a] \in {"revoke", "clear"} /\ soAborts < MaxSoAbort
    /\ soAborts' = soAborts + 1
    /\ outPh' = Set(outPh, a, "none")
    /\ IF SignOutWaits THEN Release(a) ELSE UNCHANGED lockVars
    /\ UNCHANGED <<diskVars, memVars, srvVars, netVars, reqVars, inPh, inCand, inSrc, prPh, clock, crashes, giveups, discs, signins, signouts, pfails, rejects, rvfails, detFails, unreads, ghostVars>>

SoReload(a) ==
    /\ ResumeAtLoad
    /\ dState[a] = "signing_out" /\ mState[a] = "signing_out" /\ outPh[a] = "none"
    /\ IF SignOutWaits /\ UseMutex
        THEN holder[a] = None /\ holder' = [holder EXCEPT ![a] = "out"] /\ UNCHANGED waitq
        ELSE UNCHANGED lockVars
    /\ outPh' = Set(outPh, a, IF dRt[a] = 0 THEN "clear" ELSE "revoke")
    /\ UNCHANGED <<diskVars, memVars, srvVars, netVars, reqVars, inPh, inCand, inSrc, prPh, clock, budgetVars, ghostVars>>

-----------------------------------------------------------------------------

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
          /\ dPend' = Set(dPend, a, IF mRt[a] = dRt[a] THEN dPend[a] ELSE FALSE)
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
    /\ UNCHANGED <<dSub, dClient, dFam, mState, mGen, mRt, mIss, mForced, srvVars, netVars, reqVars, inPh, inCand, inSrc, outPh, clock, crashes, giveups, discs, signins, signouts, rejects, rvfails, unreads, soAborts, ghostVars>>

-----------------------------------------------------------------------------

Disc(a) ==
    /\ discs < MaxDisc
    /\ discs' = discs + 1
    /\ sRev' = Set(sRev, a, TRUE)
    /\ UNCHANGED <<diskVars, memVars, sCur, sUsed, sStart, sNext, netVars, lockVars, reqVars, actVars, clock, crashes, giveups, signins, signouts, pfails, rejects, rvfails, detFails, unreads, soAborts, ghostVars>>

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
    /\ UNCHANGED <<diskVars, srvVars, pktN, rpur, rtok, rtry, rpkt, rgot, rgen, rretried, inCand, inSrc, clock, giveups, discs, signins, signouts, pfails, rejects, rvfails, detFails, soAborts>>
    /\ UNCHANGED <<badSend, soDone, outConfirmed, lossKind, startedAfterOut>>

-----------------------------------------------------------------------------

OgLocks == TwoGens = "reread"

OgStart ==
    /\ gPh = "idle"
    /\ gPh' = "want"
    /\ IF OgLocks THEN Enqueue("a1", "og") ELSE UNCHANGED waitq
    /\ UNCHANGED <<gGen, gRt, gState, gTok, gPkt, staleOut, pointerVars, holder>>

OgGrant ==
    /\ gPh = "want"
    /\ IF OgLocks
        THEN /\ CanTake("a1", "og")
             /\ gGen' = dGen["a1"] /\ gRt' = dRt["a1"] /\ gState' = dState["a1"]
             /\ IF dState["a1"] = "active" /\ dRt["a1"] # 0
                 THEN Take("a1", "og") /\ gPh' = "send"
                 ELSE Pop("a1") /\ gPh' = "done"
        ELSE /\ UNCHANGED <<gGen, gRt, gState, lockVars>>
             /\ gPh' = IF gState = "active" /\ gRt # 0 THEN "send" ELSE "done"
    /\ UNCHANGED <<gTok, gPkt, staleOut, pointerVars>>

OgSend ==
    /\ gPh = "send"
    /\ gPh' = "await"
    /\ gTok' = gRt
    /\ gPkt' = pktN
    /\ net' = net \cup {[id |-> pktN, a |-> "a1", tok |-> gRt, live |-> TRUE, st |-> "sent", rk |-> None, rv |-> None]}
    /\ pktN' = pktN + 1
    /\ UNCHANGED <<gGen, gRt, gState, staleOut, pointerVars, lockVars>>

OgRecv ==
    \E p \in net :
        /\ gPh = "await" /\ p.id = gPkt /\ p.st = "replied" /\ p.live
        /\ net' = net \ {p}
        /\ gPh' = "done"
        /\ IF OgLocks THEN Release("a1") ELSE UNCHANGED lockVars
        /\ IF p.rk = "term"
            THEN /\ dState' = Set(dState, "a1", "needs_sign_in")
                 /\ dRt' = Set(dRt, "a1", 0)
                 /\ dCause' = Set(dCause, "a1", p.rv)
                 /\ staleOut' = staleOut \/ gTok # dRt["a1"]
                 /\ gState' = "needs_sign_in" /\ gRt' = 0
                 /\ UNCHANGED <<dGen, dIss, gGen>>
            ELSE /\ dState' = Set(dState, "a1", "active")
                 /\ dRt' = Set(dRt, "a1", p.rv)
                 /\ dCause' = Set(dCause, "a1", None)
                 /\ dGen' = Set(dGen, "a1", gGen + 1)
                 /\ dIss' = Set(dIss, "a1", clock)
                 /\ gGen' = gGen + 1 /\ gRt' = p.rv
                 /\ UNCHANGED <<staleOut, gState>>
        /\ dPend' = Set(dPend, "a1", FALSE)
        /\ UNCHANGED <<dSub, dClient, dFam, gTok, gPkt, pointerVars, pktN>>

MoveActive(x, k) ==
    LET base == IF TwoGens = "reread" THEN dAct ELSE IF x = "g1" THEN mAct ELSE gAct
        moved == [base EXCEPT ![k] = 1 - base[k]]
    IN
    /\ TwoGens # "off" /\ moves < MaxMove
    /\ moves' = moves + 1
    /\ dAct' = moved
    /\ mAct' = IF x = "g1" THEN moved ELSE mAct
    /\ gAct' = IF x = "og" THEN moved ELSE gAct
    /\ actWant' = [actWant EXCEPT ![k] = moved[k]]
    /\ UNCHANGED <<oldGenVars, staleOut>>

OldGen ==
    /\ \/ OgStart /\ UNCHANGED <<diskVars, netVars>>
       \/ OgGrant /\ UNCHANGED <<diskVars, netVars>>
       \/ OgSend /\ UNCHANGED diskVars
       \/ OgRecv
       \/ \E x \in {"g1", "og"}, k \in PointerKeys : MoveActive(x, k) /\ UNCHANGED <<diskVars, netVars, lockVars>>
    /\ UNCHANGED <<memVars, srvVars, reqVars, actVars, clock, budgetVars, ghostVars, extraVars>>

AllDone == \A r \in Reqs : rph[r] = "done"

Terminated == AllDone /\ UNCHANGED vars

Next ==
    \/ Quiet(Tick)
    \/ \E r \in Reqs : Quiet(Start(r) \/ ReqGrant(r) \/ ReqSend(r)
                       \/ ReqForget(r) \/ ReqPersist(r) \/ ReqPersistSignsOut(r) \/ ReqResult(r) \/ ForceGrant(r) \/ ReqReRead(r))
                       \/ Two(ReqPend(r) \/ ReqGiveUp(r) \/ ReqRetry(r) \/ ReqWeak(r)) \/ ReqRecv(r)
    \/ \E p \in net : Two(Deliver(p))
    \/ OldGen
    \/ \E a \in Accts : Quiet(SiStart(a) \/ SiGrant(a) \/ SiInstall(a) \/ SoStart(a) \/ SoGrant(a) \/ SoGrantFails(a) \/ SoRevoke(a) \/ SoClear(a) \/ SoAbort(a) \/ SoReload(a)
                        \/ PrStart(a) \/ PrGrant(a) \/ PrWrite(a) \/ Disc(a))
    \/ Quiet(Crash)
    \/ Terminated

Fairness ==
    /\ \A r \in Reqs : WF_vars(Quiet(Start(r))) /\ WF_vars(Quiet(ReqGrant(r))) /\ WF_vars(Two(ReqPend(r))) /\ WF_vars(Quiet(ReqSend(r)))
                       /\ WF_vars(ReqRecv(r)) /\ WF_vars(Quiet(ReqForget(r))) /\ WF_vars(Quiet(ReqPersist(r)))
                       /\ WF_vars(Quiet(ReqResult(r))) /\ WF_vars(Quiet(ForceGrant(r))) /\ WF_vars(Two(ReqWeak(r))) /\ WF_vars(Quiet(ReqReRead(r)))
    /\ WF_vars(\E p \in net : Two(Deliver(p)))
    /\ \A a \in Accts : WF_vars(Quiet(SiGrant(a))) /\ WF_vars(Quiet(SiInstall(a))) /\ WF_vars(Quiet(SoGrant(a))) /\ WF_vars(Quiet(SoRevoke(a)))
                        /\ WF_vars(Quiet(SoClear(a))) /\ WF_vars(Quiet(SoReload(a))) /\ WF_vars(Quiet(PrGrant(a))) /\ WF_vars(Quiet(PrWrite(a)))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------

TypeOK ==
    /\ \A a \in Accts : dState[a] \in AcctStates /\ mState[a] \in AcctStates
    /\ \A a \in Accts : dRt[a] \in Toks /\ mRt[a] \in Toks /\ dGen[a] \in Gens /\ mGen[a] \in Gens
    /\ \A a \in Accts : dCause[a] \in Causes /\ dPend[a] \in BOOLEAN /\ mDirty[a] \in BOOLEAN /\ mUnwr[a] \in BOOLEAN
    /\ \A a \in Accts : sCur[a] \in Toks /\ sUsed[a] \subseteq Toks /\ sRev[a] \in BOOLEAN
    /\ \A r \in Reqs : rph[r] \in {"idle", "want", "reread", "pend", "send", "await", "forget", "persist", "inflight", "wantForce", "done"}
    /\ \A a \in Accts : holder[a] \in {None, "in", "out", "pr", "og"} \cup Reqs
    /\ gPh \in {"idle", "want", "send", "await", "done"}

SingleUseServer == \A a \in Accts : \A t \in Toks : slack[a][t] >= 0

SingleUseUnlessSilent == \A a \in Accts : ~silentRot[a] => \A t \in Toks : slack[a][t] >= 0

SingleUse == SingleUseServer

CauseIsServerCode == \A a \in Accts : dState[a] = "needs_sign_in" => dCause[a] \in TerminalCodes

SuccessorKept == \A a \in Accts : ~dropped[a]

NoEraseUnlessDropped ==
    \A a \in Accts : (dState[a] = "needs_sign_in" => sRev[a] \/ dropped[a]) /\ (mState[a] = "needs_sign_in" => sRev[a] \/ dropped[a])

Critical(a) ==
    {r \in Reqs : ReqAcct[r] = a /\ rph[r] \in {"pend", "send", "await", "forget", "persist"}}
    \cup (IF inPh[a] = "install" THEN {"in"} ELSE {})
    \cup (IF outPh[a] \in {"revoke", "clear"} THEN {"out"} ELSE {})
    \cup (IF prPh[a] = "write" THEN {"pr"} ELSE {})
    \cup (IF a = "a1" /\ gPh \in {"send", "await"} THEN {"og"} ELSE {})

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

TransientNeverSignsOut == \A a \in Accts : dState[a] = "needs_sign_in" => dCause[a] # "transient"

LossDetected ==
    \A a \in Accts : (dState[a] = "needs_sign_in" => dCause[a] # None) /\ dSub[a] = AcctSub[a] /\ dClient[a] = AcctClient[a]

InterruptedRecorded ==
    \A a \in Accts : (dState[a] = "needs_sign_in" /\ lossKind[a] = "reused" /\ ~silentRot[a]) => dInt[a]

PlainLossNotInterrupted == \A a \in Accts : dState[a] = "needs_sign_in" => ~dInt[a]

IdentityPinned == [][\A a \in Accts : (dSub'[a] = dSub[a] \/ dSub[a] = None) /\ (dClient'[a] = dClient[a] \/ dClient[a] = 0)]_vars

DiskOf(a) == <<dState[a], dGen[a], dRt[a], dCause[a], dPend[a], dIss[a], dSub[a], dClient[a], dFam[a]>>

AccountsIsolated == \A a \in Accts : dFam[a] = a /\ dClient[a] = AcctClient[a]

OtherAccountsUntouched == [][Cardinality({a \in Accts : DiskOf(a)' # DiskOf(a)}) <= 1]_vars

Coalesced == \A a \in Accts : \A g \in Gens : forcedCnt[a][g] <= 1

SignOutFinal ==
    \A a \in Accts : soDone[a] => (dRt[a] = 0 /\ mRt[a] = 0 /\ ~startedAfterOut[a])

SignOutRevokesFamily ==
    \A a \in Accts : (soDone[a] /\ outConfirmed[a] = "yes") => sRev[a]

NoStaleSignOut == ~staleOut

ActivePointerNotLost == \A k \in PointerKeys : dAct[k] = actWant[k]

Settles == \A r \in Reqs : rph[r] # "idle" ~> rph[r] = "done"

SigningOutResolves == \A a \in Accts : dState[a] = "signing_out" ~> dState[a] # "signing_out"

AllServed == <>(\A r \in Reqs : rres[r] = "served")

=========================================================================
