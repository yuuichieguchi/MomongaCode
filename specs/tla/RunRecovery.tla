---------------------------- MODULE RunRecovery ----------------------------

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
    Workers,
    NoOwner,
    MaxStep,
    MaxAttempts,
    MaxTotalAttempts,
    UnfencedEffect,
    NoCallLock,
    NoReapBeforeReconcile,
    StatusEdgesRecorded,
    ParentCalls,
    Gen2Workers,
    Promotes,
    GenDies,
    KeepsLockWhileChild,
    NoUnknownGate,
    NeedsVerdict,
    RuleVerdicts,
    RefusingProps,
    UngatedRules,
    RefusesNotes

ASSUME ParentCalls \subseteq {"none", "exec", "rec", "spawn"}
ASSUME /\ MaxStep \in Nat \ {0}
       /\ MaxAttempts \in Nat \ {0}
       /\ MaxTotalAttempts \in Nat \ {0}
       /\ MaxTotalAttempts >= MaxAttempts
       /\ UnfencedEffect \in BOOLEAN
       /\ NoCallLock \in BOOLEAN
       /\ NoReapBeforeReconcile \in BOOLEAN
       /\ StatusEdgesRecorded \in BOOLEAN
       /\ Gen2Workers \subseteq Workers
       /\ Promotes \in BOOLEAN
       /\ GenDies \in BOOLEAN
       /\ KeepsLockWhileChild \in BOOLEAN
       /\ NoUnknownGate \in BOOLEAN
       /\ NeedsVerdict \in BOOLEAN
       /\ RuleVerdicts \subseteq {"proved", "refuted", "unknown"} /\ RuleVerdicts # {}
       /\ RefusingProps \subseteq BOOLEAN /\ RefusingProps # {}
       /\ UngatedRules \in BOOLEAN
       /\ RefusesNotes \in BOOLEAN

Parent == "P"
Child == "C"
Runs == {Parent, Child}
Steps == 1..MaxStep
Keys == Runs \X Steps
Gens == {1, 2}
GenOfW(w) == IF w \in Gen2Workers THEN 2 ELSE 1

-----------------------------------------------------------------------------

Statuses == {"QUEUED", "RUNNING", "WAITING_TOOL", "WAITING_HUMAN", "CANCELLING",
             "COMPLETED", "STOPPED", "FAILED", "CANCELLED"}

Terminal == {"COMPLETED", "STOPPED", "FAILED", "CANCELLED"}

ClaimStatuses == {"RUNNING", "CANCELLING"}

WorkerEdges == [
    QUEUED        |-> {},
    RUNNING       |-> {"WAITING_TOOL", "WAITING_HUMAN", "COMPLETED", "STOPPED", "FAILED", "CANCELLING", "QUEUED"},
    WAITING_TOOL  |-> {},
    WAITING_HUMAN |-> {},
    CANCELLING    |-> {"CANCELLED"},
    COMPLETED     |-> {},
    STOPPED       |-> {},
    FAILED        |-> {},
    CANCELLED     |-> {}]

ServiceEdges == [
    QUEUED        |-> {"CANCELLING"},
    RUNNING       |-> {"CANCELLING"},
    WAITING_TOOL  |-> {"QUEUED", "CANCELLING"},
    WAITING_HUMAN |-> {"QUEUED", "CANCELLING", "STOPPED"},
    CANCELLING    |-> {},
    COMPLETED     |-> {},
    STOPPED       |-> {},
    FAILED        |-> {},
    CANCELLED     |-> {}]

SweepEdges == [
    QUEUED        |-> {"STOPPED"},
    RUNNING       |-> {"CANCELLING"},
    WAITING_TOOL  |-> {"QUEUED", "CANCELLING"},
    WAITING_HUMAN |-> {"QUEUED", "CANCELLING", "STOPPED"},
    CANCELLING    |-> {},
    COMPLETED     |-> {},
    STOPPED       |-> {},
    FAILED        |-> {},
    CANCELLED     |-> {}]

DeadLetterEdges == [
    QUEUED        |-> {"FAILED", "CANCELLED"},
    RUNNING       |-> {"FAILED", "CANCELLED"},
    WAITING_TOOL  |-> {},
    WAITING_HUMAN |-> {},
    CANCELLING    |-> {"CANCELLED"},
    COMPLETED     |-> {},
    STOPPED       |-> {},
    FAILED        |-> {},
    CANCELLED     |-> {}]

ModelledEvents == {"user.message", "run.started", "run.status", "model.requested",
                   "model.responded", "tool.call", "tool.permission.requested",
                   "tool.permission.resolved", "tool.permission.cancelled",
                   "tool.started", "tool.completed", "tool.reconciled", "tool.waiting",
                   "tool.unknown.requested", "tool.unknown.resolved", "tool.unknown.cancelled"}

AskKinds == {"tool.permission.requested", "tool.unknown.requested"}

ToolKinds == {"exec", "rec", "spawn"}

CallChoices(r) == IF r = Parent THEN ParentCalls ELSE {"none"}

-----------------------------------------------------------------------------
VARIABLES run, ev, appr, idem, idemRes, eff, dl, child,
          pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags,
          serving, genLock, childGen, ownerDead,
          vstate, vref, stored, vflags

oldVars == <<run, ev, appr, idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags, serving, genLock, childGen, ownerDead>>

verdictVars == <<vstate, vref, stored, vflags>>

vars == <<oldVars, verdictVars>>

genVars == <<serving, genLock, childGen, ownerDead>>

E(k, s, x, y) == [k |-> k, s |-> s, x |-> x, y |-> y]

Max(S) == CHOOSE x \in S : \A y \in S : y <= x

Snap == [run |-> run, ev |-> ev, appr |-> appr]
SetStore(S) == /\ run' = S.run /\ ev' = S.ev /\ appr' = S.appr
KeepStore == UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr>>

IdxOf(r, k) == {i \in DOMAIN ev[r] : ev[r][i].k = k}
Has(r, k, s) == \E i \in DOMAIN ev[r] : ev[r][i].k = k /\ ev[r][i].s = s
CurStep(r) == LET ss == {ev[r][i].s : i \in IdxOf(r, "model.requested")}
              IN IF ss = {} THEN 0 ELSE Max(ss)
Responded(r, s) == Has(r, "model.responded", s)
CallDone(r, s) == Has(r, "tool.completed", s) \/ Has(r, "tool.reconciled", s)
EvOf(r, k, s) == ev[r][CHOOSE i \in DOMAIN ev[r] : ev[r][i].k = k /\ ev[r][i].s = s]
RespKind(r, s) == EvOf(r, "model.responded", s).x
ResolvedChoice(r, s) == EvOf(r, "tool.permission.resolved", s).x

UnknownAt(r, s) == Has(r, "tool.reconciled", s) /\ EvOf(r, "tool.reconciled", s).x = "unknown"

UnknownOpen(r, s) == UnknownAt(r, s) /\ ~Has(r, "tool.unknown.resolved", s)

LastAskKind(S, r, s) ==
    LET asks == {i \in DOMAIN S.ev[r] : S.ev[r][i].k \in AskKinds /\ S.ev[r][i].s = s}
    IN IF asks = {} THEN "none" ELSE S.ev[r][Max(asks)].k

CancelledKind(S, r, s) ==
    IF LastAskKind(S, r, s) = "tool.unknown.requested" THEN "tool.unknown.cancelled" ELSE "tool.permission.cancelled"

OutcomeEvent(r, s) ==
    IF idemRes[<<r, s>>] \in {"already_applied", "unknown"}
    THEN E("tool.reconciled", s, idemRes[<<r, s>>], "")
    ELSE E("tool.completed", s, "ok", "")

-----------------------------------------------------------------------------

AppendEvs(S, r, evs) == [S EXCEPT !.ev[r] = @ \o evs, !.run[r].lastSeq = @ + Len(evs)]

PendingStep(S, r) == {s \in Steps : S.appr[r][s] = "pending"}

Withdraw(S, r) ==
    IF PendingStep(S, r) = {} THEN S
    ELSE LET s == CHOOSE x \in PendingStep(S, r) : TRUE
         IN AppendEvs([S EXCEPT !.appr[r][s] = "withdrawn"], r,
                   <<E(CancelledKind(S, r, s), s, "withdrawn", "")>>)

Base(S, r, to, lead, refund, resetFailures) ==
    LET x == S.run[r]
        S1 == AppendEvs(S, r, lead)
        S2 == IF to \in Terminal \/ to = "CANCELLING" THEN Withdraw(S1, r) ELSE S1
        S3 == AppendEvs(S2, r, <<IF StatusEdgesRecorded THEN E("run.status", 0, x.status, to) ELSE E("run.status", 0, "", "")>>)
        keeps == to \in ClaimStatuses
    IN [S3 EXCEPT !.run[r] = [@ EXCEPT
            !.status = to,
            !.cancelReq = @ \/ to = "CANCELLING" \/ to = "CANCELLED",
            !.cancelOrigin = IF to = "CANCELLING" THEN x.status ELSE @,
            !.failed = IF resetFailures THEN 0 ELSE @,
            !.attempts = IF refund THEN @ - 1 ELSE @,
            !.owner = IF keeps THEN @ ELSE NoOwner,
            !.live = IF keeps THEN @ ELSE FALSE]]

WakeParent(S) ==
    IF S.run[Parent].status = "WAITING_TOOL"
    THEN Base(S, Parent, "QUEUED", <<>>, FALSE, FALSE)
    ELSE S

CancelChild(S) ==
    LET c == S.run[Child]
    IN IF c.status \in Terminal \cup {"CANCELLING", "ABSENT"} THEN S
       ELSE Base(S, Child, "CANCELLING", <<>>, FALSE, FALSE)

Change(S, r, to, lead, refund, resetFailures) ==
    LET S1 == Base(S, r, to, lead, refund, resetFailures)
    IN IF r = Parent /\ (to \in Terminal \/ to = "CANCELLING") THEN CancelChild(S1)
       ELSE IF r = Child /\ to \in Terminal THEN WakeParent(S1)
       ELSE S1

Exhausted(x) ==
    \/ x.status \in ClaimStatuses /\ x.owner # NoOwner /\ x.failed + 1 >= MaxAttempts
    \/ x.attempts + 1 > MaxTotalAttempts

SweeperOwned(x) == x.status = "CANCELLING" /\ x.cancelOrigin \in {"QUEUED", "WAITING_HUMAN"}

Claimable(S, r) ==
    LET x == S.run[r]
    IN \/ x.status = "QUEUED"
       \/ x.status \in ClaimStatuses /\ (x.owner = NoOwner \/ ~x.live) /\ ~SweeperOwned(x)

DeadLetterOne(S, r) ==
    IF Claimable(S, r) /\ Exhausted(S.run[r])
    THEN LET x == S.run[r]
             to == IF x.cancelReq \/ x.status = "CANCELLING" THEN "CANCELLED" ELSE "FAILED"
         IN Change(S, r, to, <<>>, FALSE, FALSE)
    ELSE S

DeadLetterPass(S) ==
    DeadLetterOne(DeadLetterOne(DeadLetterOne(DeadLetterOne(S, Parent), Child), Parent), Child)

-----------------------------------------------------------------------------

Fence(w) ==
    LET x == run[wr[w]]
    IN x.token = wt[w] /\ x.owner = w /\ x.status \in ClaimStatuses

ToIdle(w) ==
    /\ pc' = [pc EXCEPT ![w] = "idle"]
    /\ wr' = [wr EXCEPT ![w] = Parent]
    /\ wt' = [wt EXCEPT ![w] = 0]
    /\ ws' = [ws EXCEPT ![w] = "RUNNING"]
    /\ lost' = [lost EXCEPT ![w] = FALSE]
    /\ wcancel' = [wcancel EXCEPT ![w] = FALSE]
    /\ wresp' = [wresp EXCEPT ![w] = "none"]
    /\ wretry' = [wretry EXCEPT ![w] = FALSE]
    /\ wlock' = [wlock EXCEPT ![w] = FALSE]
    /\ wstep' = [wstep EXCEPT ![w] = 0]

Goto(w, p) == pc' = [pc EXCEPT ![w] = p]

KeyOf(w) == <<wr[w], wstep[w]>>

Held(k) == \E x \in Workers : wlock[x] /\ KeyOf(x) = k

Reaped(k) ==
    [child EXCEPT ![k] = IF NoReapBeforeReconcile THEN @ ELSE FALSE]

LedgerFenced(w) == UnfencedEffect \/ Fence(w)

LedgerPcs == {"begin", "authorise", "complete", "reconDone", "spawnExec", "verifyStart"}

StaleLedger(w) ==
    /\ pc[w] \in LedgerPcs
    /\ ~lost[w]
    /\ ~LedgerFenced(w)
    /\ IF KeepsLockWhileChild /\ wstep[w] > 0 /\ child[KeyOf(w)]
       THEN /\ pc' = [pc EXCEPT ![w] = "orphanWait"]
            /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, child, flags, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, serving, genLock, childGen, ownerDead>>
       ELSE /\ ToIdle(w)
            /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, child, flags, serving, genLock, childGen, ownerDead>>

ChildTerminal(S) == S.run[Child].status \in Terminal

WhenCancelling == [finish |-> "CANCELLED", yield |-> "RELEASED"]

TerminalMethods == {"finish", "yieldTo", "cancel", "yieldLease"}

FinishTx(w, to) ==
    LET r == wr[w]
    IN IF run[r].status = "CANCELLING"
       THEN Change(Snap, r, WhenCancelling.finish, <<>>, FALSE, TRUE)
       ELSE Change(Snap, r, to, <<>>, FALSE, TRUE)

YieldTx(w, to) ==
    LET r == wr[w]
        S == Snap
    IN IF run[r].status = "CANCELLING" /\ WhenCancelling.yield = "RELEASED"
       THEN [S EXCEPT !.run[r] = [@ EXCEPT !.owner = NoOwner, !.live = FALSE,
                                   !.failed = 0, !.attempts = @ - 1]]
       ELSE IF run[r].status = "CANCELLING"
       THEN Change(S, r, "CANCELLED", <<>>, FALSE, TRUE)
       ELSE LET target == IF to = "WAITING_HUMAN" /\ PendingStep(S, r) = {} THEN "QUEUED"
                          ELSE IF to = "WAITING_TOOL" /\ ChildTerminal(S) THEN "QUEUED"
                          ELSE to
                refund == to = "WAITING_TOOL"
            IN Change(S, r, target, <<>>, refund, TRUE)

CheckAlive(r) ==
    \E s \in Steps : Responded(r, s) /\ RespKind(r, s) = "none" /\ child[<<r, s>>]

LeaveAs(w, to, stopConfirmed) ==
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, eff, dl, child>>
    /\ flags' = [flags EXCEPT !.cancelLeftCheck = @ \/ (stopConfirmed /\ Fence(w) /\ run[wr[w]].status = "CANCELLING" /\ CheckAlive(wr[w]))]
    /\ ToIdle(w)
    /\ \/ /\ Fence(w)
          /\ run[wr[w]].status = "CANCELLING" \/ to \in WorkerEdges[run[wr[w]].status]
          /\ SetStore(FinishTx(w, to))
       \/ /\ ~Fence(w)
          /\ KeepStore

Leave(w, to) == LeaveAs(w, to, TRUE)

LeaveYield(w, to) ==
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, eff, dl, child, flags>>
    /\ ToIdle(w)
    /\ \/ /\ Fence(w)
          /\ run[wr[w]].status = "CANCELLING" \/ to \in WorkerEdges[run[wr[w]].status]
          /\ SetStore(YieldTx(w, to))
       \/ /\ ~Fence(w)
          /\ KeepStore

AppendStepTo(w, evs, next, step) ==
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, eff, dl, child>>
    /\ \/ /\ Fence(w)
          /\ SetStore(AppendEvs(Snap, wr[w], evs))
          /\ Goto(w, next)
          /\ wstep' = [wstep EXCEPT ![w] = step]
          /\ UNCHANGED <<serving, genLock, childGen, ownerDead, wr, wt, ws, wcancel, wresp, wretry, wlock, lost>>
          /\ flags' = [flags EXCEPT !.stale = @ \/ run[wr[w]].token # wt[w]]
       \/ /\ ~Fence(w)
          /\ KeepStore
          /\ ToIdle(w)
          /\ UNCHANGED flags

AppendStep(w, evs, next) == AppendStepTo(w, evs, next, wstep[w])

PcOnly(w, p) ==
    /\ Goto(w, p)
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

Dropped(w) ==
    /\ ToIdle(w)
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, child, flags>>

-----------------------------------------------------------------------------
Init ==
    /\ run = [r \in Runs |->
                [status |-> IF r = Parent THEN "QUEUED" ELSE "ABSENT",
                 owner |-> NoOwner, token |-> 0, live |-> FALSE, cancelReq |-> FALSE, cancelOrigin |-> "",
                 attempts |-> 0, failed |-> 0, lastSeq |-> IF r = Parent THEN 1 ELSE 0]]
    /\ ev = [r \in Runs |-> IF r = Parent THEN <<E("user.message", 0, "", "")>> ELSE <<>>]
    /\ appr = [r \in Runs |-> [s \in Steps |-> "none"]]
    /\ idem = [k \in Keys |-> "NONE"]
    /\ idemRes = [k \in Keys |-> "none"]
    /\ eff = [k \in Keys |-> 0]
    /\ dl = [r \in Runs |-> FALSE]
    /\ child = [k \in Keys |-> FALSE]
    /\ wlock = [w \in Workers |-> FALSE]
    /\ pc = [w \in Workers |-> "idle"]
    /\ wr = [w \in Workers |-> Parent]
    /\ wt = [w \in Workers |-> 0]
    /\ ws = [w \in Workers |-> "RUNNING"]
    /\ lost = [w \in Workers |-> FALSE]
    /\ wcancel = [w \in Workers |-> FALSE]
    /\ wresp = [w \in Workers |-> "none"]
    /\ wretry = [w \in Workers |-> FALSE]
    /\ wstep = [w \in Workers |-> 0]
    /\ serving = 1
    /\ genLock = [g \in Gens |-> g = 1]
    /\ childGen = [k \in Keys |-> 1]
    /\ ownerDead = [k \in Keys |-> FALSE]
    /\ flags = [stale |-> FALSE, reissue |-> FALSE, retryUnknown |-> FALSE, killed |-> {}, reapedLive |-> FALSE, checkOverlap |-> FALSE, cancelLeftCheck |-> FALSE]
    /\ vstate \in RuleVerdicts
    /\ vref \in RefusingProps
    /\ stored = "none"
    /\ vflags = [refutedRan |-> FALSE, noteRefused |-> FALSE]

-----------------------------------------------------------------------------

Claim(w) ==
    /\ pc[w] = "idle"
    /\ GenOfW(w) = serving
    /\ LET S1 == DeadLetterPass(Snap)
       IN \E r \in Runs :
            /\ Claimable(S1, r)
            /\ ~Exhausted(S1.run[r])
            /\ LET x == S1.run[r]
                   takeover == x.status \in ClaimStatuses /\ x.owner # NoOwner
                   status2 == IF x.status = "QUEUED" THEN "RUNNING" ELSE x.status
               IN /\ run' = [S1.run EXCEPT ![r] = [x EXCEPT
                                !.status = status2,
                                !.owner = w,
                                !.token = x.token + 1,
                                !.live = TRUE,
                                !.attempts = x.attempts + 1,
                                !.failed = IF takeover THEN x.failed + 1 ELSE x.failed]]
                  /\ ev' = S1.ev
                  /\ appr' = S1.appr
                  /\ wr' = [wr EXCEPT ![w] = r]
                  /\ wt' = [wt EXCEPT ![w] = x.token + 1]
                  /\ ws' = [ws EXCEPT ![w] = status2]
    /\ pc' = [pc EXCEPT ![w] = "drive"]
    /\ lost' = [lost EXCEPT ![w] = FALSE]
    /\ wcancel' = [wcancel EXCEPT ![w] = FALSE]
    /\ wretry' = [wretry EXCEPT ![w] = FALSE]
    /\ wstep' = [wstep EXCEPT ![w] = 0]
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, eff, dl, child, wresp, wlock, flags>>

ClaimNone(w) ==
    /\ pc[w] = "idle"
    /\ GenOfW(w) = serving
    /\ LET S1 == DeadLetterPass(Snap)
       IN /\ S1 # Snap
          /\ \A r \in Runs : ~(Claimable(S1, r) /\ ~Exhausted(S1.run[r]))
          /\ SetStore(S1)
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

HB(w) ==
    /\ pc[w] # "idle"
    /\ ~lost[w]
    /\ \/ /\ Fence(w)
          /\ run' = [run EXCEPT ![wr[w]].live = TRUE]
          /\ wcancel' = [wcancel EXCEPT ![w] = @ \/ run[wr[w]].cancelReq]
          /\ lost' = lost
       \/ /\ ~Fence(w)
          /\ lost' = [lost EXCEPT ![w] = TRUE]
          /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, wcancel>>
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, ev, appr, idem, idemRes, eff, dl, child, pc, wr, wt, ws, wresp, wretry, wlock, wstep, flags>>

Abort(w) ==
    /\ pc[w] \notin {"idle", "orphanWait"}
    /\ lost[w]
    /\ IF KeepsLockWhileChild /\ wstep[w] > 0 /\ child[KeyOf(w)]
       THEN PcOnly(w, "orphanWait")
       ELSE Dropped(w)

AbortDone(w) ==
    /\ pc[w] = "orphanWait"
    /\ ~child[KeyOf(w)]
    /\ Dropped(w)

Crash(w) ==
    /\ pc[w] # "idle"
    /\ ToIdle(w)
    /\ ownerDead' = [k \in Keys |-> ownerDead[k] \/ (k = KeyOf(w) /\ child[k])]
    /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, child, flags, serving, genLock, childGen>>

GenDie(g) ==
    /\ GenDies
    /\ g # serving
    /\ genLock[g]
    /\ genLock' = [genLock EXCEPT ![g] = FALSE]
    /\ ownerDead' = [k \in Keys |-> ownerDead[k] \/ (child[k] /\ childGen[k] = g)]
    /\ pc' = [w \in Workers |-> IF GenOfW(w) = g THEN "idle" ELSE pc[w]]
    /\ wr' = [w \in Workers |-> IF GenOfW(w) = g THEN Parent ELSE wr[w]]
    /\ wt' = [w \in Workers |-> IF GenOfW(w) = g THEN 0 ELSE wt[w]]
    /\ ws' = [w \in Workers |-> IF GenOfW(w) = g THEN "RUNNING" ELSE ws[w]]
    /\ lost' = [w \in Workers |-> IF GenOfW(w) = g THEN FALSE ELSE lost[w]]
    /\ wcancel' = [w \in Workers |-> IF GenOfW(w) = g THEN FALSE ELSE wcancel[w]]
    /\ wresp' = [w \in Workers |-> IF GenOfW(w) = g THEN "none" ELSE wresp[w]]
    /\ wretry' = [w \in Workers |-> IF GenOfW(w) = g THEN FALSE ELSE wretry[w]]
    /\ wlock' = [w \in Workers |-> IF GenOfW(w) = g THEN FALSE ELSE wlock[w]]
    /\ wstep' = [w \in Workers |-> IF GenOfW(w) = g THEN 0 ELSE wstep[w]]
    /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, child, flags, serving, childGen>>

Promote ==
    /\ Promotes
    /\ serving = 1
    /\ Gen2Workers # {}
    /\ serving' = 2
    /\ genLock' = [genLock EXCEPT ![2] = TRUE]
    /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags, childGen, ownerDead>>

RetireYield(w) ==
    /\ GenOfW(w) # serving
    /\ genLock[GenOfW(w)]
    /\ pc[w] = "loop"
    /\ LeaveYield(w, "QUEUED")

-----------------------------------------------------------------------------

DispatchTarget(r) ==
    LET s == CurStep(r)
    IN IF s > 0 /\ Responded(r, s) /\ ~Has(r, "tool.call", s) THEN "decide"
       ELSE IF s > 0 /\ Has(r, "tool.call", s) /\ ~CallDone(r, s) THEN "settle"
       ELSE IF s > 0 /\ ~Responded(r, s) THEN "stream"
       ELSE IF s > 0 /\ CallDone(r, s) /\ UnknownOpen(r, s) /\ ~NoUnknownGate THEN "unknownGate"
       ELSE "loop"

StartPc == IF NeedsVerdict THEN "ruleVerify" ELSE "started"

BatchPc == IF NeedsVerdict THEN "ruleVerifyBatch" ELSE "begin"

Drive(w) ==
    /\ pc[w] = "drive"
    /\ LET r == wr[w] IN
       \/ /\ ws[w] = "CANCELLING" \/ run[r].cancelReq
          /\ PcOnly(w, "cancelRec")
       \/ /\ ~(ws[w] = "CANCELLING" \/ run[r].cancelReq)
          /\ dl[r]
          /\ Leave(w, "STOPPED")
       \/ /\ ~(ws[w] = "CANCELLING" \/ run[r].cancelReq)
          /\ ~dl[r]
          /\ PcOnly(w, StartPc)

Started(w) ==
    /\ pc[w] = "started"
    /\ AppendStep(w, <<E("run.started", 0, "", "")>>, "dispatch")

Dispatch(w) ==
    /\ pc[w] = "dispatch"
    /\ Goto(w, DispatchTarget(wr[w]))
    /\ wstep' = [wstep EXCEPT ![w] = CurStep(wr[w])]
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, flags>>

Loop(w) ==
    /\ pc[w] = "loop"
    /\ LET r == wr[w]
           s == wstep[w]
       IN \/ /\ wcancel[w]
             /\ Leave(w, "CANCELLED")
          \/ /\ ~wcancel[w] /\ dl[r]
             /\ Leave(w, "STOPPED")
          \/ /\ ~wcancel[w] /\ ~dl[r] /\ s >= MaxStep
             /\ Leave(w, "STOPPED")
          \/ /\ ~wcancel[w] /\ ~dl[r] /\ s < MaxStep
             /\ AppendStepTo(w, <<E("model.requested", s + 1, "", "")>>, "stream", s + 1)

Issue(w) ==
    /\ pc[w] = "stream"
    /\ ~lost[w]
    /\ LET r == wr[w] IN
       flags' = [flags EXCEPT !.reissue = @ \/ (Responded(r, wstep[w]) /\ Fence(w))]
    /\ Goto(w, "recv")
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep>>

Recv(w) ==
    /\ pc[w] = "recv"
    /\ ~lost[w]
    /\ \/ /\ \E c \in CallChoices(wr[w]) : wresp' = [wresp EXCEPT ![w] = c]
          /\ Goto(w, "respond")
          /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wretry, wlock, wstep, flags>>
       \/ LeaveYield(w, "QUEUED")
       \/ Leave(w, "FAILED")

Respond(w) ==
    /\ pc[w] = "respond"
    /\ AppendStep(w, <<E("model.responded", wstep[w], wresp[w], "")>>, "decide")

Decide(w) ==
    /\ pc[w] = "decide"
    /\ LET r == wr[w]
           s == wstep[w]
           kind == RespKind(r, s)
       IN IF kind = "none"
          THEN PcOnly(w, "verifyLock")
          ELSE AppendStep(w, <<E("tool.call", s, kind, "")>>, "settle")

VerifyLock(w) ==
    /\ pc[w] = "verifyLock"
    /\ ~lost[w]
    /\ NoCallLock \/ ~Held(KeyOf(w))
    /\ wlock' = [wlock EXCEPT ![w] = ~NoCallLock]
    /\ Goto(w, "verifyReap")
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wstep, flags>>

VerifyReap(w) ==
    /\ pc[w] = "verifyReap"
    /\ ~lost[w]
    /\ \/ /\ child' = Reaped(KeyOf(w))
          /\ flags' = [flags EXCEPT !.reapedLive = @ \/ (child[KeyOf(w)] /\ ~ownerDead[KeyOf(w)] /\ ~NoReapBeforeReconcile)]
          /\ Goto(w, "verifyStart")
          /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep>>
       \/ LeaveAs(w, "FAILED", FALSE)

VerifyStart(w) ==
    /\ pc[w] = "verifyStart"
    /\ ~lost[w]
    /\ LedgerFenced(w)
    /\ child' = [child EXCEPT ![KeyOf(w)] = TRUE]
    /\ childGen' = [childGen EXCEPT ![KeyOf(w)] = GenOfW(w)]
    /\ ownerDead' = [ownerDead EXCEPT ![KeyOf(w)] = FALSE]
    /\ flags' = [flags EXCEPT !.checkOverlap = @ \/ child[KeyOf(w)]]
    /\ Goto(w, "verifyRun")
    /\ UNCHANGED <<serving, genLock, run, ev, appr, idem, idemRes, eff, dl, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep>>

VerifyCancel(w) ==
    /\ pc[w] \in {"verifyLock", "verifyReap", "verifyStart"}
    /\ ~lost[w]
    /\ wcancel[w]
    /\ wlock' = [wlock EXCEPT ![w] = FALSE]
    /\ Goto(w, "cancelRec")
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wstep, flags>>

VerifyKill(w) ==
    /\ pc[w] = "verifyRun"
    /\ ~lost[w]
    /\ (wcancel[w] \/ dl[wr[w]])
    /\ child' = [child EXCEPT ![KeyOf(w)] = FALSE]
    /\ Goto(w, "verifyAbort")
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

VerifyAbort(w) ==
    /\ pc[w] = "verifyAbort"
    /\ IF wcancel[w] THEN Leave(w, "CANCELLED") ELSE Leave(w, "STOPPED")

VerifyDone(w) ==
    /\ pc[w] = "verifyRun"
    /\ ~lost[w]
    /\ ~child[KeyOf(w)]
    /\ \/ Leave(w, "COMPLETED")
       \/ Leave(w, "STOPPED")
       \/ /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, eff, dl, child, flags>>
          /\ \/ /\ Fence(w)
                /\ SetStore(AppendEvs(Snap, wr[w], <<E("user.message", 0, "", "")>>))
                /\ Goto(w, "loop")
                /\ wlock' = [wlock EXCEPT ![w] = FALSE]
                /\ UNCHANGED <<wr, wt, ws, lost, wcancel, wresp, wretry, wstep>>
             \/ /\ ~Fence(w)
                /\ KeepStore
                /\ ToIdle(w)

Settle(w) ==
    /\ pc[w] = "settle"
    /\ LET r == wr[w]
           s == wstep[w]
           kind == RespKind(r, s)
           a == appr[r][s]
       IN \/ /\ kind \in {"exec", "rec"} /\ a = "none"
             /\ \/ /\ Fence(w)
                   /\ SetStore(AppendEvs([Snap EXCEPT !.appr[r][s] = "pending"], r,
                                      <<E("tool.permission.requested", s, "", "")>>))
                   /\ Goto(w, "yieldHuman")
                   /\ UNCHANGED <<serving, genLock, childGen, ownerDead, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>
                \/ /\ ~Fence(w) /\ KeepStore /\ ToIdle(w) /\ UNCHANGED flags
             /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, eff, dl, child>>
          \/ /\ kind \in {"exec", "rec"} /\ a = "pending"
             /\ PcOnly(w, "yieldHuman")
          \/ /\ kind \in {"exec", "rec"} /\ a = "resolved" /\ ResolvedChoice(r, s) = "reject"
             /\ AppendStep(w, <<E("tool.completed", s, "rejected", "")>>, "loop")
          \/ /\ kind \in {"exec", "rec"} /\ a = "resolved" /\ ResolvedChoice(r, s) = "allow"
             /\ PcOnly(w, BatchPc)
          \/ /\ kind = "spawn"
             /\ PcOnly(w, BatchPc)

YieldHuman(w) == pc[w] = "yieldHuman" /\ LeaveYield(w, "WAITING_HUMAN")

YieldTool(w) == pc[w] = "yieldTool" /\ LeaveYield(w, "WAITING_TOOL")

Begin(w) ==
    /\ pc[w] = "begin"
    /\ ~lost[w]
    /\ LedgerFenced(w)
    /\ LET k == KeyOf(w) IN
       \/ /\ idem[k] = "NONE"
          /\ idem' = [idem EXCEPT ![k] = "PENDING"]
          /\ wretry' = [wretry EXCEPT ![w] = FALSE]
          /\ Goto(w, "execStart")
       \/ /\ idem[k] \in {"PENDING", "UNKNOWN"}
          /\ Goto(w, IF RespKind(wr[w], wstep[w]) = "spawn" THEN "spawnExec" ELSE "reconLock")
          /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, wretry>>
       \/ /\ idem[k] = "COMPLETED"
          /\ Goto(w, "journalOut")
          /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, wretry>>
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wlock, wstep, flags>>

ExecStart(w) ==
    /\ pc[w] = "execStart"
    /\ LET r == wr[w]
           s == wstep[w]
       IN AppendStep(w, <<E("tool.started", s, RespKind(r, s), "")>>,
                     IF RespKind(r, s) = "spawn" THEN "spawnExec" ELSE "lock")

LockCall(w) ==
    /\ pc[w] = "lock"
    /\ ~lost[w]
    /\ NoCallLock \/ ~Held(KeyOf(w))
    /\ wlock' = [wlock EXCEPT ![w] = ~NoCallLock]
    /\ Goto(w, "authorise")
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wstep, flags>>

LockWaitExpired(w) ==
    /\ pc[w] \in {"lock", "reconLock", "verifyLock"}
    /\ ~NoCallLock /\ Held(KeyOf(w))
    /\ LeaveAs(w, "FAILED", FALSE)

Authorise(w) ==
    /\ pc[w] = "authorise"
    /\ ~lost[w]
    /\ LedgerFenced(w)
    /\ Goto(w, "doEffect")
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

DoEffect(w) ==
    /\ pc[w] = "doEffect"
    /\ ~lost[w]
    /\ LET k == KeyOf(w)
           recorded == idem[k] = "UNKNOWN" \/ idemRes[k] = "unknown"
           spawns == RespKind(wr[w], wstep[w]) = "exec"
       IN /\ eff' = [eff EXCEPT ![k] = @ + 1]
          /\ child' = [child EXCEPT ![k] = @ \/ spawns]
          /\ childGen' = [childGen EXCEPT ![k] = IF spawns THEN GenOfW(w) ELSE @]
          /\ ownerDead' = [ownerDead EXCEPT ![k] = IF spawns THEN FALSE ELSE @]
          /\ flags' = [flags EXCEPT !.retryUnknown = @ \/ (wretry[w] /\ recorded)]
    /\ Goto(w, "complete")
    /\ UNCHANGED <<serving, genLock, run, ev, appr, idem, idemRes, dl, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep>>

ChildExit(k) ==
    /\ child[k]
    /\ child' = [child EXCEPT ![k] = FALSE]
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

Complete(w) ==
    /\ pc[w] = "complete"
    /\ ~lost[w]
    /\ ~child[KeyOf(w)]
    /\ LedgerFenced(w)
    /\ LET k == KeyOf(w) IN
       IF idem[k] \in {"PENDING", "UNKNOWN"}
       THEN /\ idem' = [idem EXCEPT ![k] = "COMPLETED"]
            /\ idemRes' = [idemRes EXCEPT ![k] = "completed"]
            /\ Goto(w, "journalOut")
            /\ wlock' = [wlock EXCEPT ![w] = FALSE]
            /\ UNCHANGED <<serving, genLock, childGen, ownerDead, wr, wt, ws, lost, wcancel, wresp, wretry, wstep>>
       ELSE /\ ToIdle(w)
            /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes>>
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, eff, dl, child, flags>>

JournalOut(w) ==
    /\ pc[w] = "journalOut"
    /\ AppendStep(w, <<OutcomeEvent(wr[w], wstep[w])>>,
                  IF idemRes[KeyOf(w)] = "unknown" /\ ~NoUnknownGate THEN "unknownGate" ELSE "loop")

UnknownGate(w) ==
    /\ pc[w] = "unknownGate"
    /\ LET r == wr[w]
           s == wstep[w]
       IN \/ /\ ~UnknownOpen(r, s)
             /\ PcOnly(w, "loop")
          \/ /\ UnknownOpen(r, s) /\ appr[r][s] = "pending"
             /\ PcOnly(w, "yieldHuman")
          \/ /\ UnknownOpen(r, s) /\ appr[r][s] # "pending"
             /\ \/ /\ Fence(w)
                   /\ SetStore(AppendEvs([Snap EXCEPT !.appr[r][s] = "pending"], r,
                                      <<E("tool.unknown.requested", s, "", "")>>))
                   /\ Goto(w, "yieldHuman")
                   /\ UNCHANGED <<serving, genLock, childGen, ownerDead, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>
                \/ /\ ~Fence(w) /\ KeepStore /\ ToIdle(w) /\ UNCHANGED flags
             /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, eff, dl, child>>

ReconLock(w) ==
    /\ pc[w] = "reconLock"
    /\ ~lost[w]
    /\ NoCallLock \/ ~Held(KeyOf(w))
    /\ wlock' = [wlock EXCEPT ![w] = ~NoCallLock]
    /\ Goto(w, "reap")
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wstep, flags>>

Reap(w) ==
    /\ pc[w] = "reap"
    /\ ~lost[w]
    /\ \/ /\ child' = Reaped(KeyOf(w))
          /\ flags' = [flags EXCEPT !.reapedLive = @ \/ (child[KeyOf(w)] /\ ~ownerDead[KeyOf(w)] /\ ~NoReapBeforeReconcile)]
          /\ Goto(w, "reconcile")
          /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep>>
       \/ LeaveAs(w, "FAILED", FALSE)

Reconcile(w) ==
    /\ pc[w] = "reconcile"
    /\ ~lost[w]
    /\ LET r == wr[w]
           s == wstep[w]
           kind == RespKind(r, s)
           k == <<r, s>>
       IN \/ /\ kind = "exec"
             /\ wresp' = [wresp EXCEPT ![w] = "unknown"]
          \/ /\ kind = "rec"
             /\ \E o \in (IF eff[k] > 0 THEN {"already_applied", "unknown"} ELSE {"not_applied", "unknown"}) :
                    wresp' = [wresp EXCEPT ![w] = o]
    /\ Goto(w, "reconDone")
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wretry, wlock, wstep, flags>>

ReconDone(w) ==
    /\ pc[w] = "reconDone"
    /\ ~lost[w]
    /\ LedgerFenced(w)
    /\ LET k == KeyOf(w)
           o == wresp[w]
       IN IF o = "not_applied"
          THEN /\ wretry' = [wretry EXCEPT ![w] = TRUE]
               /\ Goto(w, "authorise")
               /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, wr, wt, ws, lost, wcancel, wresp, wlock, wstep>>
          ELSE IF idem[k] \in {"PENDING", "UNKNOWN"}
          THEN /\ idem' = [idem EXCEPT ![k] = "COMPLETED"]
               /\ idemRes' = [idemRes EXCEPT ![k] = o]
               /\ Goto(w, "journalOut")
               /\ wlock' = [wlock EXCEPT ![w] = FALSE]
               /\ UNCHANGED <<serving, genLock, childGen, ownerDead, wr, wt, ws, lost, wcancel, wresp, wretry, wstep>>
          ELSE /\ ToIdle(w)
               /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes>>
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, eff, dl, child, flags>>

SpawnExec(w) ==
    /\ pc[w] = "spawnExec"
    /\ ~lost[w]
    /\ LedgerFenced(w)
    /\ LET k == KeyOf(w)
           c == run[Child]
           p == run[Parent]
           parentActive == ~(p.status \in Terminal \/ p.status = "CANCELLING" \/ p.cancelReq)
           canComplete == idem[k] \in {"PENDING", "UNKNOWN"}
           created == [Snap EXCEPT !.run[Child] =
                           [status |-> "QUEUED", owner |-> NoOwner, token |-> 0, live |-> FALSE,
                            cancelReq |-> FALSE, cancelOrigin |-> "", attempts |-> 0, failed |-> 0, lastSeq |-> 1],
                       !.ev[Child] = <<E("user.message", 0, "", "")>>]
       IN \/ /\ c.status # "ABSENT" /\ c.status \in Terminal /\ canComplete
             /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr>>
             /\ idem' = [idem EXCEPT ![k] = "COMPLETED"]
             /\ idemRes' = [idemRes EXCEPT ![k] = "completed"]
             /\ Goto(w, "journalOut")
          \/ /\ c.status # "ABSENT" /\ ~(c.status \in Terminal)
             /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes>>
             /\ Goto(w, "waitAppend")
          \/ /\ c.status = "ABSENT" /\ ~parentActive /\ canComplete
             /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr>>
             /\ idem' = [idem EXCEPT ![k] = "COMPLETED"]
             /\ idemRes' = [idemRes EXCEPT ![k] = "completed"]
             /\ Goto(w, "journalOut")
          \/ /\ c.status = "ABSENT" /\ parentActive
             /\ SetStore(created)
             /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes>>
             /\ Goto(w, "waitAppend")
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

WaitAppend(w) ==
    /\ pc[w] = "waitAppend"
    /\ LET r == wr[w]
           s == wstep[w]
       IN IF Has(r, "tool.waiting", s)
          THEN PcOnly(w, "yieldTool")
          ELSE AppendStep(w, <<E("tool.waiting", s, "", "")>>, "yieldTool")

CancelRec(w) ==
    /\ pc[w] = "cancelRec"
    /\ ~lost[w]
    /\ LET r == wr[w]
           s == wstep[w]
           k == <<r, s>>
           kind == RespKind(r, s)
           open == s > 0 /\ Has(r, "tool.started", s) /\ ~CallDone(r, s)
       IN \/ /\ ~open
             /\ PcOnly(w, "cancelReap")
          \/ /\ open /\ idem[k] = "COMPLETED"
             /\ PcOnly(w, "cancelJournal")
          \/ /\ open /\ idem[k] = "UNKNOWN"
             /\ idemRes' = [idemRes EXCEPT ![k] = "unknown"]
             /\ Goto(w, "cancelJournal")
             /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>
          \/ /\ open /\ idem[k] = "PENDING" /\ kind = "spawn"
             /\ idem' = [idem EXCEPT ![k] = "COMPLETED"]
             /\ idemRes' = [idemRes EXCEPT ![k] = "completed"]
             /\ Goto(w, "cancelJournal")
             /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>
          \/ /\ open /\ idem[k] = "PENDING" /\ kind \in {"exec", "rec"}
             /\ \/ /\ NoCallLock \/ ~Held(k)
                   /\ child' = Reaped(k)
                   /\ flags' = [flags EXCEPT !.reapedLive = @ \/ (child[k] /\ ~ownerDead[k] /\ ~NoReapBeforeReconcile)]
                   /\ \E o \in (IF kind = "exec" THEN {"unknown", "abandon"}
                                ELSE IF eff[k] > 0 THEN {"already_applied", "unknown", "abandon"}
                                ELSE {"not_applied", "unknown", "abandon"}) :
                        IF o = "abandon"
                        THEN /\ idem' = [idem EXCEPT ![k] = "UNKNOWN"]
                             /\ idemRes' = [idemRes EXCEPT ![k] = "unknown"]
                        ELSE /\ idem' = [idem EXCEPT ![k] = "COMPLETED"]
                             /\ idemRes' = [idemRes EXCEPT ![k] = IF o = "not_applied" THEN "completed" ELSE o]
                \/ /\ UNCHANGED <<child, flags>>
                   /\ idem' = [idem EXCEPT ![k] = "UNKNOWN"]
                   /\ idemRes' = [idemRes EXCEPT ![k] = "unknown"]
             /\ Goto(w, "cancelJournal")
             /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, eff, dl, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep>>

CancelReap(w) ==
    /\ pc[w] = "cancelReap"
    /\ ~lost[w]
    /\ LET r == wr[w]
           s == CurStep(r)
           isCheck == s > 0 /\ Responded(r, s) /\ RespKind(r, s) = "none"
       IN IF isCheck
          THEN /\ NoCallLock \/ ~Held(<<r, s>>)
               /\ child' = [child EXCEPT ![<<r, s>>] = IF NoReapBeforeReconcile THEN @ ELSE FALSE]
               /\ Goto(w, "cancelFinish")
          ELSE /\ Goto(w, "cancelFinish")
               /\ UNCHANGED child
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, dl, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

CancelJournal(w) ==
    /\ pc[w] = "cancelJournal"
    /\ AppendStep(w, <<OutcomeEvent(wr[w], wstep[w])>>, "cancelFinish")

CancelFinish(w) == pc[w] = "cancelFinish" /\ Leave(w, "CANCELLED")

Step(w) ==
    \/ Drive(w) \/ Started(w) \/ Dispatch(w) \/ Loop(w) \/ Issue(w) \/ Recv(w)
    \/ Respond(w) \/ Decide(w) \/ Settle(w) \/ YieldHuman(w) \/ YieldTool(w)
    \/ Begin(w) \/ ExecStart(w) \/ LockCall(w) \/ LockWaitExpired(w) \/ Authorise(w)
    \/ DoEffect(w) \/ Complete(w) \/ JournalOut(w)
    \/ ReconLock(w) \/ Reap(w) \/ Reconcile(w) \/ ReconDone(w) \/ SpawnExec(w) \/ WaitAppend(w)
    \/ VerifyLock(w) \/ VerifyReap(w) \/ VerifyStart(w) \/ VerifyCancel(w) \/ VerifyKill(w)
    \/ VerifyAbort(w) \/ VerifyDone(w) \/ CancelReap(w)
    \/ CancelRec(w) \/ CancelJournal(w) \/ CancelFinish(w) \/ StaleLedger(w)
    \/ RetireYield(w) \/ AbortDone(w) \/ UnknownGate(w)

-----------------------------------------------------------------------------

Deadline(r) ==
    /\ ~dl[r]
    /\ dl' = [dl EXCEPT ![r] = TRUE]
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, idem, idemRes, eff, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

RequestCancel(r) ==
    /\ run[r].status \notin Terminal \cup {"CANCELLING", "ABSENT"}
    /\ "CANCELLING" \in ServiceEdges[run[r].status]
    /\ SetStore(Change(Snap, r, "CANCELLING", <<>>, FALSE, FALSE))
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

Resolve(r, s, choice) ==
    /\ appr[r][s] = "pending"
    /\ ~run[r].cancelReq
    /\ LET unknownAsk == LastAskKind(Snap, r, s) = "tool.unknown.requested"
           S0 == [Snap EXCEPT !.appr[r][s] = "resolved"]
           lead == <<E(IF unknownAsk THEN "tool.unknown.resolved" ELSE "tool.permission.resolved", s, choice, "")>>
       IN /\ unknownAsk => choice = "allow"
          /\ LET settled == run[r].status = "WAITING_HUMAN" /\ PendingStep(S0, r) = {}
             IN SetStore(IF settled THEN Change(S0, r, "QUEUED", lead, FALSE, FALSE) ELSE AppendEvs(S0, r, lead))
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

SweepQueued(r) ==
    /\ run[r].status = "QUEUED" /\ dl[r]
    /\ "STOPPED" \in SweepEdges["QUEUED"]
    /\ SetStore(Change(Snap, r, "STOPPED", <<>>, FALSE, FALSE))
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

SweepHuman(r) ==
    /\ run[r].status = "WAITING_HUMAN"
    /\ PendingStep(Snap, r) # {} \/ dl[r]
    /\ "STOPPED" \in ServiceEdges["WAITING_HUMAN"]
    /\ LET due == PendingStep(Snap, r)
           S0 == [Snap EXCEPT !.appr[r] = [s \in Steps |-> IF s \in due THEN "expired" ELSE @[s]]]
           lead == IF due = {} THEN <<>>
                   ELSE LET s == CHOOSE x \in due : TRUE
                        IN <<E(CancelledKind(Snap, r, s), s, "expired", "")>>
       IN SetStore(Change(S0, r, "STOPPED", lead, FALSE, FALSE))
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

SweepTool(r) ==
    /\ run[r].status = "WAITING_TOOL" /\ dl[r]
    /\ "QUEUED" \in ServiceEdges["WAITING_TOOL"]
    /\ SetStore(Change(Snap, r, "QUEUED", <<>>, FALSE, FALSE))
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

FinishCancelled(r) ==
    /\ SweeperOwned(run[r])
    /\ (run[r].owner = NoOwner \/ ~run[r].live)
    /\ SetStore(Change(Snap, r, "CANCELLED", <<>>, FALSE, FALSE))
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

ExpireLease(r) ==
    /\ run[r].status \in ClaimStatuses /\ run[r].owner # NoOwner /\ run[r].live
    /\ run' = [run EXCEPT ![r].live = FALSE]
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, ev, appr, idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

HolderAlive(r) ==
    \E w \in Workers : pc[w] # "idle" /\ wr[w] = r /\ wt[w] = run[r].token /\ ~lost[w]

ExpireDead(r) == ~HolderAlive(r) /\ ExpireLease(r)

Refuses(v) == v = "refuted" /\ (vref \/ RefusesNotes)

VerdictSeen == IF stored # "none" THEN stored ELSE vstate

RuleVerify(w, from, next) ==
    /\ pc[w] = from
    /\ ~lost[w]
    /\ LET v == VerdictSeen
           refuse == Refuses(v) /\ ~UngatedRules
       IN /\ stored' = IF v # "unknown" THEN v ELSE stored
          /\ vflags' = [vflags EXCEPT !.refutedRan = @ \/ (~refuse /\ v = "refuted" /\ vref),
                                      !.noteRefused = @ \/ (refuse /\ ~(v = "refuted" /\ vref))]
          /\ IF refuse /\ run[wr[w]].cancelReq THEN PcOnly(w, "cancelRec")
             ELSE IF refuse THEN Leave(w, "FAILED") ELSE PcOnly(w, next)
    /\ UNCHANGED <<vstate, vref>>

RuleVerifyStart(w) == RuleVerify(w, "ruleVerify", "started")

RuleVerifyBatch(w) == RuleVerify(w, "ruleVerifyBatch", "begin")

RetryVerdict ==
    /\ vstate = "unknown"
    /\ \E v \in RuleVerdicts \ {"unknown"} : vstate' = v /\ stored' = v
    /\ UNCHANGED <<oldVars, vref, vflags>>

KeepVerdict(A) == A /\ UNCHANGED verdictVars

VerdictStep(w) == RuleVerifyStart(w) \/ RuleVerifyBatch(w)

AllDone == \A r \in Runs : run[r].status \in Terminal \cup {"ABSENT"}

Terminated == AllDone /\ UNCHANGED vars

OldNextWithoutSweeper ==
    \/ \E w \in Workers : Claim(w) \/ ClaimNone(w) \/ Step(w) \/ HB(w) \/ Abort(w) \/ Crash(w)
    \/ \E r \in Runs : Deadline(r) \/ RequestCancel(r) \/ ExpireLease(r)
                       \/ SweepQueued(r) \/ SweepHuman(r) \/ SweepTool(r)
    \/ \E k \in Keys : ChildExit(k)
    \/ \E r \in Runs, s \in Steps, c \in {"allow", "reject"} : Resolve(r, s, c)
    \/ Promote
    \/ \E g \in Gens : GenDie(g)

NextWithoutSweeper ==
    \/ KeepVerdict(OldNextWithoutSweeper)
    \/ \E w \in Workers : VerdictStep(w)
    \/ RetryVerdict
    \/ Terminated

Next == NextWithoutSweeper \/ \E r \in Runs : KeepVerdict(FinishCancelled(r))

WorkerStep(w) == KeepVerdict(Step(w)) \/ VerdictStep(w)

Fairness ==
    /\ \A w \in Workers : WF_vars(KeepVerdict(Claim(w))) /\ WF_vars(KeepVerdict(ClaimNone(w))) /\ WF_vars(WorkerStep(w)) /\ WF_vars(KeepVerdict(HB(w))) /\ WF_vars(KeepVerdict(Abort(w)))
    /\ \A k \in Keys : WF_vars(KeepVerdict(ChildExit(k)))
    /\ \A r \in Runs : WF_vars(KeepVerdict(ExpireDead(r))) /\ WF_vars(KeepVerdict(SweepQueued(r)))
                       /\ WF_vars(KeepVerdict(SweepHuman(r))) /\ WF_vars(KeepVerdict(SweepTool(r))) /\ WF_vars(KeepVerdict(FinishCancelled(r)))

Spec == Init /\ [][Next]_vars /\ Fairness

SpecWithoutWorkers == Init /\ [][Next]_vars /\ \A r \in Runs : WF_vars(KeepVerdict(ExpireDead(r))) /\ WF_vars(KeepVerdict(FinishCancelled(r)))

SpecWithoutSweeper == Init /\ [][NextWithoutSweeper]_vars /\ \A r \in Runs : WF_vars(KeepVerdict(ExpireDead(r)))

LiveTimeoutOutcomes(kind, k) ==
    IF kind = "exec" THEN {"unknown"}
    ELSE IF eff[k] > 0 THEN {"already_applied", "unknown"}
    ELSE {"not_applied", "unknown"}

LiveKill(w, outcomes(_, _)) ==
    /\ pc[w] = "complete"
    /\ ~lost[w]
    /\ LedgerFenced(w)
    /\ LET r == wr[w]
           s == wstep[w]
           k == <<r, s>>
           kind == RespKind(r, s)
       IN /\ child' = [child EXCEPT ![k] = FALSE]
          /\ IF idem[k] \in {"PENDING", "UNKNOWN"}
             THEN /\ \E o \in outcomes(kind, k) :
                        /\ idem' = [idem EXCEPT ![k] = "COMPLETED"]
                        /\ idemRes' = [idemRes EXCEPT ![k] = o]
                  /\ flags' = [flags EXCEPT !.killed = @ \cup (IF kind = "exec" THEN {k} ELSE {})]
                  /\ Goto(w, "journalOut")
                  /\ wlock' = [wlock EXCEPT ![w] = FALSE]
                  /\ UNCHANGED <<serving, genLock, childGen, ownerDead, wr, wt, ws, lost, wcancel, wresp, wretry, wstep>>
             ELSE /\ ToIdle(w)
                  /\ UNCHANGED <<serving, genLock, childGen, ownerDead, idem, idemRes, flags>>
    /\ UNCHANGED <<serving, genLock, childGen, ownerDead, run, ev, appr, eff, dl>>

LiveTimeout(w) == LiveKill(w, LiveTimeoutOutcomes)

RecordedCompleted(kind, k) == {"completed"}

LiveTimeoutRecordsCompleted(w) == LiveKill(w, RecordedCompleted)

SpecLiveTimeout == Init /\ [][Next \/ \E w \in Workers : KeepVerdict(LiveTimeout(w))]_vars

SpecLiveTimeoutFailed == Init /\ [][Next \/ \E w \in Workers : KeepVerdict(LiveTimeoutRecordsCompleted(w))]_vars

-----------------------------------------------------------------------------

RunTypeOK(x) ==
    /\ x.status \in Statuses \cup {"ABSENT"}
    /\ x.attempts \in Nat /\ x.failed \in Nat /\ x.token \in Nat
    /\ (x.owner = NoOwner \/ x.owner \in Workers)

TypeOK ==
    /\ \A r \in Runs : RunTypeOK(run[r])
    /\ \A r \in Runs : \A i \in DOMAIN ev[r] : ev[r][i].k \in ModelledEvents
    /\ \A k \in Keys : idem[k] \in {"NONE", "PENDING", "UNKNOWN", "COMPLETED"}
    /\ \A k \in Keys : child[k] \in BOOLEAN
    /\ \A w \in Workers : wlock[w] \in BOOLEAN
    /\ serving \in Gens
    /\ genLock \in [Gens -> BOOLEAN]
    /\ \A k \in Keys : childGen[k] \in Gens /\ ownerDead[k] \in BOOLEAN

ContiguousEvents == \A r \in Runs : run[r].lastSeq = Len(ev[r])

AtMostOnePendingApproval == \A r \in Runs : Cardinality(PendingStep(Snap, r)) <= 1

NoStaleAppend == ~flags.stale

AtMostOnceEffect == \A k \in Keys : eff[k] <= 1

ReconcileSeesStoppedEffect == \A w \in Workers : pc[w] = "reconDone" => ~child[KeyOf(w)]

RetiringChildNeverReaped == ~flags.reapedLive

NoEffectDuringReconcile ==
    \A w, x \in Workers :
        (w # x /\ pc[w] \in {"reap", "reconcile", "reconDone"} /\ pc[x] = "doEffect") => KeyOf(w) # KeyOf(x)

LockIsExclusive ==
    \A w, x \in Workers : (w # x /\ wlock[w] /\ wlock[x]) => KeyOf(w) # KeyOf(x)

UnknownNeverRetried == ~flags.retryUnknown

ExclusiveCheck == ~flags.checkOverlap

VerifyStartSeesStoppedCheck == \A w \in Workers : pc[w] = "verifyStart" => ~child[KeyOf(w)]

CancelReapsCheck == ~flags.cancelLeftCheck

KilledExecIsUnknown == \A k \in flags.killed : idem[k] = "COMPLETED" => idemRes[k] = "unknown"

RecordedResponseNeverReRequested == ~flags.reissue

OneResponsePerStep ==
    \A r \in Runs, s \in Steps :
        Cardinality({i \in DOMAIN ev[r] : ev[r][i].k = "model.responded" /\ ev[r][i].s = s}) <= 1

TerminalHasNoPendingApproval ==
    \A r \in Runs : run[r].status \in Terminal => PendingStep(Snap, r) = {}

ParentWakeNeverLost ==
    (run[Parent].status = "WAITING_TOOL" /\ \E s \in Steps : Has(Parent, "tool.waiting", s))
        => run[Child].status \notin Terminal

TerminalNeverChanges ==
    [][\A r \in Runs : run[r].status \in Terminal =>
            (run'[r] = run[r] /\ ev'[r] = ev[r] /\ appr'[r] = appr[r])]_vars

OnlyDeclaredEdges ==
    \A r \in Runs : \A i \in IdxOf(r, "run.status") :
        LET from == ev[r][i].x
            to == ev[r][i].y
        IN \/ to \in WorkerEdges[from]
           \/ to \in ServiceEdges[from]
           \/ to \in SweepEdges[from]
           \/ to \in DeadLetterEdges[from]

EventsAppendOnly ==
    [][\A r \in Runs : SubSeq(ev'[r], 1, Len(ev[r])) = ev[r]]_vars

Settles ==
    \A r \in Runs :
        (run[r].status \in {"QUEUED", "RUNNING", "CANCELLING"})
            ~> (run[r].status \in Terminal \cup {"WAITING_TOOL", "WAITING_HUMAN"})

CancelNeedsNoWorker ==
    \A r \in Runs : SweeperOwned(run[r]) ~> (run[r].status \in Terminal)

UnknownNeedsHuman ==
    \A w \in Workers : pc[w] = "loop" => ~UnknownOpen(wr[w], wstep[w])

UnknownNeedsHumanEvents ==
    \A r \in Runs, s \in Steps :
        UnknownOpen(r, s) => ~\E i \in DOMAIN ev[r] : ev[r][i].k = "model.requested" /\ ev[r][i].s > s

UnknownResolvedWasRequested ==
    \A r \in Runs, s \in Steps : Has(r, "tool.unknown.resolved", s) => Has(r, "tool.unknown.requested", s)

RefutedNeverRuns == ~vflags.refutedRan

NotesNeverRefuse == ~vflags.noteRefused

UnknownNotFinal == stored # "unknown"

NoWaitWithoutRefusal == ~NeedsVerdict => \A w \in Workers : pc[w] \notin {"ruleVerify", "ruleVerifyBatch"}

WorkerSymmetry == Permutations(Workers)

=============================================================================
