---------------------------- MODULE RunRecovery ----------------------------
(***************************************************************************)
(* Design model of MomongaCode run recovery. It describes what the code    *)
(* does, not what it should do.                                            *)
(*                                                                         *)
(* Code sources modelled                                                   *)
(*   packages/store/src/runtime-store.ts  claim, heartbeat, fence, append, *)
(*       release, transitions, cancel, sweeps, dead letter, child wake     *)
(*   packages/store/src/idempotency.ts    begin / complete / markUnknown   *)
(*   packages/store/src/approvals.ts      approvals                        *)
(*   packages/runtime/src/worker/*        claim-runner, model-step,        *)
(*       tool-step, cancel-recovery, journal, terminals                    *)
(*   packages/tools/src/executor.ts       idempotency, reconcile           *)
(*                                                                         *)
(* Abstractions (a proof holds only for this model):                       *)
(*   - time is not numeric: lease expiry, run deadline and approval expiry *)
(*     are nondeterministic actions                                        *)
(*   - the idempotency record TTL (7 days) is not modelled; it is never    *)
(*     shorter than the run deadline (timeoutMs <= 7 days, protocol)       *)
(*   - one tool call per model step; one child run (C) of one parent (P)   *)
(*   - session ordering of runs, snapshots, context inheritance, hooks,    *)
(*     compaction, background jobs, graceful shutdown are not modelled     *)
(*   - the result of reconcile is an oracle; see Reconcile                 *)
(*   - the check of the lease fence (Authorise) and the start of the       *)
(*     external effect (DoEffect) are two separate steps; the effect of    *)
(*     an exec call is a child process (child) that outlives its worker    *)
(*                                                                         *)
(* Configurations (scripts/tlc.sh <name>, specs/tla/<name>.cfg)            *)
(*   RunRecovery           the code with all three repairs of F1, every    *)
(*                         invariant: holds                                *)
(*   RunRecovery.children  parent and child run (spawn), every invariant   *)
(*   RunRecovery.unfixed   no repair (the code before the fix),            *)
(*                         AtMostOnceEffect: refuted                       *)
(*   RunRecovery.fenceOnly only the lease fence at the effect start:       *)
(*                         AtMostOnceEffect refuted (a takeover commits    *)
(*                         between Authorise and DoEffect)                 *)
(*   RunRecovery.unlocked  fence and reap, no per-call lock: the same      *)
(*                         window, AtMostOnceEffect refuted; shows that    *)
(*                         the reap does not close it                      *)
(*   RunRecovery.lockOnly  per-call lock and fence, no reap:               *)
(*                         AtMostOnceEffect holds on the split model       *)
(*   RunRecovery.noReap    the same switches as lockOnly, checking         *)
(*                         ReconcileSeesStoppedEffect: refuted (an orphan  *)
(*                         child survives until the reconcile), which      *)
(*                         shows that the reap is necessary                *)
(*   RunRecovery.reapOnly  only the reap before reconcile:                 *)
(*                         AtMostOnceEffect refuted; shows that the lock   *)
(*                         and the fence are necessary                     *)
(*   RunRecovery.liveNone  Settles under weak fairness, ParentCalls =      *)
(*                         {"none"}                                        *)
(*   RunRecovery.liveSpawn Settles under weak fairness, ParentCalls =      *)
(*                         {"spawn"}. The two cover ParentCalls =          *)
(*                         {"none", "spawn"}: a behaviour chooses once, in *)
(*                         Recv, between the two, enabledness of every     *)
(*                         fair action is the same in the union and in     *)
(*                         each part, so the property holds in the union   *)
(*                         exactly when it holds in both parts. Both run   *)
(*                         with -lncheck final (scripts/tlc.sh <name>      *)
(*                         -lncheck final).                                *)
(*                                                                         *)
(* F1 (repaired): a worker whose lease was taken over and who has not yet  *)
(* seen it (lost[w] is only set by the next heartbeat) could start the     *)
(* external effect of a call, because fencing protected the runs row and   *)
(* the events table but not the idempotency ledger and not the effect.     *)
(* The repair has three parts.                                             *)
(* (1) Every ledger write that authorises or records an effect (begin, the *)
(* adoption of an earlier record before reconcile, the authorisation at    *)
(* the effect start, complete) runs in one SQLite transaction with a check *)
(* of the lease token of the run; a stale worker gets lease lost and       *)
(* starts nothing (LedgerFenced).                                          *)
(* (2) A per-call kernel lock (callLockDir/<key>.lock, the KernelLock      *)
(* mechanism of the foundation package) is taken before the authorisation  *)
(* and held until the effect has ended and the call is recorded            *)
(* (wlock, LockCall). The new owner acquires it before it reconciles or    *)
(* abandons a call. The check of the fence and the start of the effect     *)
(* are two steps (Authorise, DoEffect), so a takeover can commit between  *)
(* them; but the new owner cannot reconcile until the lock is free, and    *)
(* the lock is free only when the older worker has recorded or dropped the *)
(* call (Complete, ToIdle) or its process is gone (Crash: the kernel       *)
(* releases the lock when the process dies). A worker that acquires the    *)
(* lock after the takeover fails Authorise and starts nothing. Whether the *)
(* older worker is a second process or a second worker of the same         *)
(* process makes no difference. On darwin the lock is flock on an open    *)
(* file description, so a second open in the same process conflicts. On    *)
(* linux and windows it is an exclusive SQLite transaction on              *)
(* callLockDir/<key>.lock.sqlite. SQLite takes POSIX locks there: its own  *)
(* bookkeeping excludes a second connection of the same process and the    *)
(* kernel excludes a second process. Closing any descriptor of that file   *)
(* would drop the locks of the process, so a claim never opens an existing *)
(* database file through the file system; it only creates the file when it *)
(* is absent. The holder removes the database and the holder record before *)
(* it drops the lock, and a claimant that locked a database checks that    *)
(* the path still names it, so no claimant keeps a lock on a removed file. *)
(* The lock covers Write, Edit and Bash alike: it is                       *)
(* taken for every call whose tool is not read only.                      *)
(* A call whose tool outlives its abort keeps the lock until the tool      *)
(* returns (the scope releases it when the tool's promise settles).        *)
(* The wait for a held lock is derived: waitMs = heartbeatMs + the abort  *)
(* settle limit + the kill grace bound (heldCallWaitMs in executor.ts).    *)
(* The older worker learns of its lost lease at its next heartbeat, at     *)
(* most heartbeatMs = leaseMs / 3 after the takeover, and aborts its tool. *)
(* The executor then waits at most ABORT_SETTLE_LIMIT_MS (2 s) for the     *)
(* tool, and the lock is held until the tool's promise settles. For a      *)
(* process group that takes the kill grace bound: SIGTERM, SIGKILL after   *)
(* SANDBOX_KILL_GRACE_MS (1 s), then at most max(grace, 1 s) more, and one *)
(* 10 ms poll after each wait (SANDBOX_STOP_BOUND_MS, 2020 ms). The        *)
(* heartbeat is the value the claim control uses, handed to the executor,  *)
(* so --lease-ms moves the wait with it; the cap that bounds reconcile is  *)
(* a separate concern. With the default 30 s lease the wait is 10 s, 2 s   *)
(* and 2.02 s. When                                                        *)
(* the wait expires the call fails with a typed error (LockWaitExpired) and *)
(* the run fails with its code.                                            *)
(* (3) After it holds the lock the new owner stops the process of the      *)
(* older attempt (the orphan child, which the kernel lock does not cover   *)
(* because a child does not inherit the lock) before it reconciles         *)
(* (NoReapBeforeReconcile = FALSE, Reap). The lock must come first: a      *)
(* child spawned after the reap but before the lock would be missed.       *)
(* A reap that fails, because the probe fails or because the process       *)
(* survives its kill, is a typed failure (Reap, then Leave "FAILED"): the  *)
(* reconcile does not run as if the older attempt were gone, the call      *)
(* record stays PENDING and the run fails with the code of the error; it   *)
(* is not retried. When cancel recovery cannot stop the older attempt it   *)
(* records the call as unknown and reports the error (CancelRec).          *)
(*                                                                         *)
(* F4 (modelled as the code behaves): a worker that yields (waiting for a  *)
(* human, for a tool, or requeueing) while the run is CANCELLING does not  *)
(* cancel it. terminals.ts yieldTo meets the conflict and calls            *)
(* yieldLease: the run stays CANCELLING, loses its owner and its lease,    *)
(* gets the attempt refunded and is claimed again by the next claim, which *)
(* runs cancel recovery (LeaveYield). A worker that finishes (Leave)       *)
(* moves a CANCELLING run directly to CANCELLED. WhenCancelling mirrors    *)
(* both and is checked against the real terminals by                       *)
(* packages/runtime/test/worker/terminals-cancelling-spec.test.ts. Recv    *)
(* may also leave through Leave "FAILED", which stands for the claim       *)
(* runner's error path ending a cancelled run with terminals.cancel.       *)
(***************************************************************************)
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
    ParentCalls

(* StatusEdgesRecorded = FALSE drops the from and to status of the         *)
(* run.status events. No worker action reads them; only OnlyDeclaredEdges  *)
(* does, so a configuration that sets it FALSE must not check that         *)
(* invariant. The liveness configurations use it: histories that differ    *)
(* only in the recorded edges are bisimilar, and Settles reads only the    *)
(* current status.                                                         *)

(* UnfencedEffect, NoCallLock and NoReapBeforeReconcile switch the three  *)
(* repairs of F1 off. All are FALSE in the code as it is now; the          *)
(* configurations that set any of them to TRUE exist as evidence of why    *)
(* every repair is needed.                                                 *)

(* ParentCalls bounds what the model may answer in the parent run: none   *)
(* ends the run, exec is a mutating tool without reconcile, rec is a      *)
(* mutating tool with reconcile (both need approval), spawn starts the    *)
(* child run. The cfg files split the state space along this set.        *)
ASSUME ParentCalls \subseteq {"none", "exec", "rec", "spawn"}
ASSUME /\ MaxStep \in Nat \ {0}
       /\ MaxAttempts \in Nat \ {0}
       /\ MaxTotalAttempts \in Nat \ {0}
       /\ MaxTotalAttempts >= MaxAttempts
       /\ UnfencedEffect \in BOOLEAN
       /\ NoCallLock \in BOOLEAN
       /\ NoReapBeforeReconcile \in BOOLEAN
       /\ StatusEdgesRecorded \in BOOLEAN

Parent == "P"
Child == "C"
Runs == {Parent, Child}
Steps == 1..MaxStep
Keys == Runs \X Steps

-----------------------------------------------------------------------------
(* Run states and edge tables: mirrored literally from runtime-store.ts and *)
(* checked against the code by test/spec-drift.test.ts.                     *)

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
    QUEUED        |-> {"CANCELLED"},
    RUNNING       |-> {"CANCELLING"},
    WAITING_TOOL  |-> {"QUEUED", "CANCELLING"},
    WAITING_HUMAN |-> {"QUEUED", "CANCELLED", "STOPPED"},
    CANCELLING    |-> {},
    COMPLETED     |-> {},
    STOPPED       |-> {},
    FAILED        |-> {},
    CANCELLED     |-> {}]

SweepEdges == [
    QUEUED        |-> {"STOPPED"},
    RUNNING       |-> {"CANCELLING"},
    WAITING_TOOL  |-> {"QUEUED", "CANCELLING"},
    WAITING_HUMAN |-> {"QUEUED", "CANCELLED", "STOPPED"},
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
                   "tool.started", "tool.completed", "tool.reconciled", "tool.waiting"}

ToolKinds == {"exec", "rec", "spawn"}

CallChoices(r) == IF r = Parent THEN ParentCalls ELSE {"none"}

-----------------------------------------------------------------------------
VARIABLES run, ev, appr, idem, idemRes, eff, dl, child,
          pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags

vars == <<run, ev, appr, idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

(* run[r]    the runs row: status, lease owner/token/liveness, attempts      *)
(* ev[r]     the events table of run r, in seq order                         *)
(* appr[r][s] approval row of the call at step s                             *)
(* idem[k], idemRes[k] the idempotency table row of the call key k           *)
(* eff[k]    count of external side effects performed for call key k        *)
(* dl[r]     the run deadline has passed                                     *)
(* child[k]  the process spawned by an exec call of key k is alive; it       *)
(*           outlives its worker and holds the process marker                *)
(* wlock[w]  worker w holds the per-call kernel lock of KeyOf(w)             *)
(* pc.. lost the per-worker program counter and local state                  *)
(* flags     history flags, each must stay FALSE                             *)

E(k, s, x, y) == [k |-> k, s |-> s, x |-> x, y |-> y]

Max(S) == CHOOSE x \in S : \A y \in S : y <= x

Snap == [run |-> run, ev |-> ev, appr |-> appr]
SetStore(S) == /\ run' = S.run /\ ev' = S.ev /\ appr' = S.appr
KeepStore == UNCHANGED <<run, ev, appr>>

IdxOf(r, k) == {i \in DOMAIN ev[r] : ev[r][i].k = k}
Has(r, k, s) == \E i \in DOMAIN ev[r] : ev[r][i].k = k /\ ev[r][i].s = s
CurStep(r) == LET ss == {ev[r][i].s : i \in IdxOf(r, "model.requested")}
              IN IF ss = {} THEN 0 ELSE Max(ss)
Responded(r, s) == Has(r, "model.responded", s)
CallDone(r, s) == Has(r, "tool.completed", s) \/ Has(r, "tool.reconciled", s)
EvOf(r, k, s) == ev[r][CHOOSE i \in DOMAIN ev[r] : ev[r][i].k = k /\ ev[r][i].s = s]
RespKind(r, s) == EvOf(r, "model.responded", s).x
ResolvedChoice(r, s) == EvOf(r, "tool.permission.resolved", s).x

OutcomeEvent(r, s) ==
    IF idemRes[<<r, s>>] \in {"already_applied", "unknown"}
    THEN E("tool.reconciled", s, idemRes[<<r, s>>], "")
    ELSE E("tool.completed", s, "ok", "")

-----------------------------------------------------------------------------
(* Store transactions. S is the triple [run, ev, appr].                     *)

AppendEvs(S, r, evs) == [S EXCEPT !.ev[r] = @ \o evs, !.run[r].lastSeq = @ + Len(evs)]

PendingStep(S, r) == {s \in Steps : S.appr[r][s] = "pending"}

Withdraw(S, r) ==
    IF PendingStep(S, r) = {} THEN S
    ELSE LET s == CHOOSE x \in PendingStep(S, r) : TRUE
         IN AppendEvs([S EXCEPT !.appr[r][s] = "withdrawn"], r,
                   <<E("tool.permission.cancelled", s, "withdrawn", "")>>)

(* changeStatus without its cascade *)
Base(S, r, to, lead, refund, resetFailures) ==
    LET x == S.run[r]
        S1 == AppendEvs(S, r, lead)
        S2 == IF to \in Terminal \/ to = "CANCELLING" THEN Withdraw(S1, r) ELSE S1
        S3 == AppendEvs(S2, r, <<IF StatusEdgesRecorded THEN E("run.status", 0, x.status, to) ELSE E("run.status", 0, "", "")>>)
        keeps == to \in ClaimStatuses
    IN [S3 EXCEPT !.run[r] = [@ EXCEPT
            !.status = to,
            !.cancelReq = @ \/ to = "CANCELLING" \/ to = "CANCELLED",
            !.failed = IF resetFailures THEN 0 ELSE @,
            !.attempts = IF refund THEN @ - 1 ELSE @,
            !.owner = IF keeps THEN @ ELSE NoOwner,
            !.live = IF keeps THEN @ ELSE FALSE]]

CancelTarget(status) == IF status \in {"QUEUED", "WAITING_HUMAN"} THEN "CANCELLED" ELSE "CANCELLING"

WakeParent(S) ==
    IF S.run[Parent].status = "WAITING_TOOL"
    THEN Base(S, Parent, "QUEUED", <<>>, FALSE, FALSE)
    ELSE S

CancelChild(S) ==
    LET c == S.run[Child]
    IN IF c.status \in Terminal \cup {"CANCELLING", "ABSENT"} THEN S
       ELSE LET to == CancelTarget(c.status)
                S1 == Base(S, Child, to, <<>>, FALSE, FALSE)
            IN IF to \in Terminal THEN WakeParent(S1) ELSE S1

Change(S, r, to, lead, refund, resetFailures) ==
    LET S1 == Base(S, r, to, lead, refund, resetFailures)
    IN IF r = Parent /\ (to \in Terminal \/ to = "CANCELLING") THEN CancelChild(S1)
       ELSE IF r = Child /\ to \in Terminal THEN WakeParent(S1)
       ELSE S1

Exhausted(x) ==
    \/ x.status \in ClaimStatuses /\ x.owner # NoOwner /\ x.failed + 1 >= MaxAttempts
    \/ x.attempts + 1 > MaxTotalAttempts

Claimable(S, r) ==
    LET x == S.run[r]
    IN \/ x.status = "QUEUED"
       \/ x.status \in ClaimStatuses /\ (x.owner = NoOwner \/ ~x.live)

DeadLetterOne(S, r) ==
    IF Claimable(S, r) /\ Exhausted(S.run[r])
    THEN LET x == S.run[r]
             to == IF x.cancelReq \/ x.status = "CANCELLING" THEN "CANCELLED" ELSE "FAILED"
         IN Change(S, r, to, <<>>, FALSE, FALSE)
    ELSE S

DeadLetterPass(S) ==
    DeadLetterOne(DeadLetterOne(DeadLetterOne(DeadLetterOne(S, Parent), Child), Parent), Child)

-----------------------------------------------------------------------------
(* Worker-side helpers *)

Fence(w) ==
    LET x == run[wr[w]]
    IN x.token = wt[w] /\ x.owner = w /\ x.status \in ClaimStatuses

(* An idle worker keeps no local state: the locals of a worker that is     *)
(* idle are never read before the next Claim writes them. Resetting them   *)
(* merges states that differ only in dead values (a bisimulation), so it   *)
(* changes no behaviour and keeps the state space small.                   *)
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

(* The per-call lock: callLockDir/<key>.lock in executor.ts, held through   *)
(* the kernel lock mechanism of the foundation package. A worker releases   *)
(* it in ToIdle (its scope ends, or its process dies and the kernel         *)
(* releases it) and when the call is recorded.                              *)
Held(k) == \E x \in Workers : wlock[x] /\ KeyOf(x) = k

(* After it holds the lock, the new owner kills the process of the older    *)
(* attempt on the same call: reapEarlierAttempt in executor.ts, the         *)
(* mechanism of abandonTarget (reapMarkedProcesses). The reap either        *)
(* stops the child or fails (the probe fails, the process survives).        *)
Reaped(k) ==
    [child EXCEPT ![k] = IF NoReapBeforeReconcile THEN @ ELSE FALSE]

(* The lease fence of the ledger: begin, authorise, complete and the       *)
(* effect start check the lease token of the run in the same transaction   *)
(* as the ledger write. A stale worker gets lease lost, starts nothing and *)
(* goes idle. attachProcess and checkpoint are fenced the same way; they   *)
(* do not change a modelled variable.                                      *)
LedgerFenced(w) == UnfencedEffect \/ Fence(w)

LedgerPcs == {"begin", "authorise", "complete", "reconDone", "spawnExec"}

StaleLedger(w) ==
    /\ pc[w] \in LedgerPcs
    /\ ~lost[w]
    /\ ~LedgerFenced(w)
    /\ ToIdle(w)
    /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, child, flags>>

ChildTerminal(S) == S.run[Child].status \in Terminal

(* What a worker's attempt to leave does to a CANCELLING run, by the       *)
(* terminals method it uses (terminals.ts). finish (a status the worker     *)
(* ends the run in) meets the conflict and calls cancel: the run becomes    *)
(* CANCELLED. yieldTo (waiting for a human or a tool, requeue) meets the    *)
(* conflict and calls yieldLease: the run stays CANCELLING without an       *)
(* owner and the next claim runs cancel recovery. test/spec-drift.test.ts   *)
(* runs the real terminals and compares.                                    *)
WhenCancelling == [finish |-> "CANCELLED", yield |-> "RELEASED"]

(* The terminals a worker has: finish and cancel end the run, yieldTo and  *)
(* yieldLease give it up. A new terminal needs a decision here.            *)
TerminalMethods == {"finish", "yieldTo", "cancel", "yieldLease"}

(* store.transition as called through terminals.finish *)
FinishTx(w, to) ==
    LET r == wr[w]
    IN IF run[r].status = "CANCELLING"
       THEN Change(Snap, r, WhenCancelling.finish, <<>>, FALSE, TRUE)
       ELSE Change(Snap, r, to, <<>>, FALSE, TRUE)

(* store.release as called through terminals.yieldTo, and releaseLease      *)
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

Leave(w, to) ==
    /\ UNCHANGED <<idem, idemRes, eff, dl, child, flags>>
    /\ ToIdle(w)
    /\ \/ /\ Fence(w)
          /\ run[wr[w]].status = "CANCELLING" \/ to \in WorkerEdges[run[wr[w]].status]
          /\ SetStore(FinishTx(w, to))
       \/ /\ ~Fence(w)
          /\ KeepStore

LeaveYield(w, to) ==
    /\ UNCHANGED <<idem, idemRes, eff, dl, child, flags>>
    /\ ToIdle(w)
    /\ \/ /\ Fence(w)
          /\ run[wr[w]].status = "CANCELLING" \/ to \in WorkerEdges[run[wr[w]].status]
          /\ SetStore(YieldTx(w, to))
       \/ /\ ~Fence(w)
          /\ KeepStore

AppendStepTo(w, evs, next, step) ==
    /\ UNCHANGED <<idem, idemRes, eff, dl, child>>
    /\ \/ /\ Fence(w)
          /\ SetStore(AppendEvs(Snap, wr[w], evs))
          /\ Goto(w, next)
          /\ wstep' = [wstep EXCEPT ![w] = step]
          /\ UNCHANGED <<wr, wt, ws, wcancel, wresp, wretry, wlock, lost>>
          /\ flags' = [flags EXCEPT !.stale = @ \/ run[wr[w]].token # wt[w]]
       \/ /\ ~Fence(w)
          /\ KeepStore
          /\ ToIdle(w)
          /\ UNCHANGED flags

AppendStep(w, evs, next) == AppendStepTo(w, evs, next, wstep[w])

PcOnly(w, p) ==
    /\ Goto(w, p)
    /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

Dropped(w) ==
    /\ ToIdle(w)
    /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, child, flags>>

-----------------------------------------------------------------------------
Init ==
    /\ run = [r \in Runs |->
                [status |-> IF r = Parent THEN "QUEUED" ELSE "ABSENT",
                 owner |-> NoOwner, token |-> 0, live |-> FALSE, cancelReq |-> FALSE,
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
    /\ flags = [stale |-> FALSE, reissue |-> FALSE, retryUnknown |-> FALSE]

-----------------------------------------------------------------------------
(* store.claim: dead-letter exhausted runs, then take one claimable run *)

Claim(w) ==
    /\ pc[w] = "idle"
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
    /\ UNCHANGED <<idem, idemRes, eff, dl, child, wresp, wlock, flags>>

ClaimNone(w) ==
    /\ pc[w] = "idle"
    /\ LET S1 == DeadLetterPass(Snap)
       IN /\ S1 # Snap
          /\ \A r \in Runs : ~(Claimable(S1, r) /\ ~Exhausted(S1.run[r]))
          /\ SetStore(S1)
    /\ UNCHANGED <<idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

HB(w) ==
    /\ pc[w] # "idle"
    /\ ~lost[w]
    /\ \/ /\ Fence(w)
          /\ run' = [run EXCEPT ![wr[w]].live = TRUE]
          /\ wcancel' = [wcancel EXCEPT ![w] = @ \/ run[wr[w]].cancelReq]
          /\ lost' = lost
       \/ /\ ~Fence(w)
          /\ lost' = [lost EXCEPT ![w] = TRUE]
          /\ UNCHANGED <<run, wcancel>>
    /\ UNCHANGED <<ev, appr, idem, idemRes, eff, dl, child, pc, wr, wt, ws, wresp, wretry, wlock, wstep, flags>>

Abort(w) ==
    /\ pc[w] # "idle"
    /\ lost[w]
    /\ Dropped(w)

Crash(w) ==
    /\ pc[w] # "idle"
    /\ Dropped(w)

-----------------------------------------------------------------------------
(* The worker program *)

DispatchTarget(r) ==
    LET s == CurStep(r)
    IN IF s > 0 /\ Responded(r, s) /\ ~Has(r, "tool.call", s) THEN "decide"
       ELSE IF s > 0 /\ Has(r, "tool.call", s) /\ ~CallDone(r, s) THEN "settle"
       ELSE IF s > 0 /\ ~Responded(r, s) THEN "stream"
       ELSE "loop"

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
          /\ PcOnly(w, "started")

Started(w) ==
    /\ pc[w] = "started"
    /\ AppendStep(w, <<E("run.started", 0, "", "")>>, "dispatch")

Dispatch(w) ==
    /\ pc[w] = "dispatch"
    /\ Goto(w, DispatchTarget(wr[w]))
    /\ wstep' = [wstep EXCEPT ![w] = CurStep(wr[w])]
    /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, flags>>

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
    /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep>>

Recv(w) ==
    /\ pc[w] = "recv"
    /\ ~lost[w]
    /\ \/ /\ \E c \in CallChoices(wr[w]) : wresp' = [wresp EXCEPT ![w] = c]
          /\ Goto(w, "respond")
          /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wretry, wlock, wstep, flags>>
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
          THEN Leave(w, "COMPLETED")
          ELSE AppendStep(w, <<E("tool.call", s, kind, "")>>, "settle")

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
                   /\ UNCHANGED <<wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>
                \/ /\ ~Fence(w) /\ KeepStore /\ ToIdle(w) /\ UNCHANGED flags
             /\ UNCHANGED <<idem, idemRes, eff, dl, child>>
          \/ /\ kind \in {"exec", "rec"} /\ a = "pending"
             /\ PcOnly(w, "yieldHuman")
          \/ /\ kind \in {"exec", "rec"} /\ a = "resolved" /\ ResolvedChoice(r, s) = "reject"
             /\ AppendStep(w, <<E("tool.completed", s, "rejected", "")>>, "loop")
          \/ /\ kind \in {"exec", "rec"} /\ a = "resolved" /\ ResolvedChoice(r, s) = "allow"
             /\ PcOnly(w, "begin")
          \/ /\ kind = "spawn"
             /\ PcOnly(w, "begin")

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
          /\ UNCHANGED <<idem, wretry>>
       \/ /\ idem[k] = "COMPLETED"
          /\ Goto(w, "journalOut")
          /\ UNCHANGED <<idem, wretry>>
    /\ UNCHANGED <<run, ev, appr, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wlock, wstep, flags>>

ExecStart(w) ==
    /\ pc[w] = "execStart"
    /\ LET r == wr[w]
           s == wstep[w]
       IN AppendStep(w, <<E("tool.started", s, RespKind(r, s), "")>>,
                     IF RespKind(r, s) = "spawn" THEN "spawnExec" ELSE "lock")

(* execute in executor.ts: the lock is taken before the authorisation. A    *)
(* held lock is waited for; the wait is bounded (LockWaitExpired).          *)
LockCall(w) ==
    /\ pc[w] = "lock"
    /\ ~lost[w]
    /\ NoCallLock \/ ~Held(KeyOf(w))
    /\ wlock' = [wlock EXCEPT ![w] = ~NoCallLock]
    /\ Goto(w, "authorise")
    /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wstep, flags>>

LockWaitExpired(w) ==
    /\ pc[w] \in {"lock", "reconLock"}
    /\ ~NoCallLock /\ Held(KeyOf(w))
    /\ Leave(w, "FAILED")

(* ledger.authorise: the check of the lease fence *)
Authorise(w) ==
    /\ pc[w] = "authorise"
    /\ ~lost[w]
    /\ LedgerFenced(w)
    /\ Goto(w, "doEffect")
    /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

(* The tool starts the external effect: the write, or the spawn of the      *)
(* child process. It checks nothing; whatever happened since Authorise      *)
(* (a takeover) is not seen here.                                           *)
DoEffect(w) ==
    /\ pc[w] = "doEffect"
    /\ ~lost[w]
    /\ LET k == KeyOf(w)
           recorded == idem[k] = "UNKNOWN" \/ idemRes[k] = "unknown"
       IN /\ eff' = [eff EXCEPT ![k] = @ + 1]
          /\ child' = [child EXCEPT ![k] = @ \/ RespKind(wr[w], wstep[w]) = "exec"]
          /\ flags' = [flags EXCEPT !.retryUnknown = @ \/ (wretry[w] /\ recorded)]
    /\ Goto(w, "complete")
    /\ UNCHANGED <<run, ev, appr, idem, idemRes, dl, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep>>

ChildExit(k) ==
    /\ child[k]
    /\ child' = [child EXCEPT ![k] = FALSE]
    /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

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
            /\ UNCHANGED <<wr, wt, ws, lost, wcancel, wresp, wretry, wstep>>
       ELSE /\ ToIdle(w)
            /\ UNCHANGED <<idem, idemRes>>
    /\ UNCHANGED <<run, ev, appr, eff, dl, child, flags>>

JournalOut(w) ==
    /\ pc[w] = "journalOut"
    /\ AppendStep(w, <<OutcomeEvent(wr[w], wstep[w])>>, "loop")

(* ReconcileOracle: the result of Tool.reconcile. A tool without reconcile  *)
(* yields unknown unless it is read_only; the spawn tool yields not_applied.*)
(* A tool with reconcile reports the external truth at the moment it runs,  *)
(* or unknown.                                                              *)
ReconLock(w) ==
    /\ pc[w] = "reconLock"
    /\ ~lost[w]
    /\ NoCallLock \/ ~Held(KeyOf(w))
    /\ wlock' = [wlock EXCEPT ![w] = ~NoCallLock]
    /\ Goto(w, "reap")
    /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wstep, flags>>

(* reapEarlierAttempt in executor.ts. A failure of the reap is a typed      *)
(* error (EarlierAttemptNotStopped): the reconcile does not run, the call   *)
(* record stays PENDING, the run fails and is not retried.                  *)
Reap(w) ==
    /\ pc[w] = "reap"
    /\ ~lost[w]
    /\ \/ /\ child' = Reaped(KeyOf(w))
          /\ Goto(w, "reconcile")
          /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>
       \/ Leave(w, "FAILED")

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
    /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, dl, child, wr, wt, ws, lost, wcancel, wretry, wlock, wstep, flags>>

ReconDone(w) ==
    /\ pc[w] = "reconDone"
    /\ ~lost[w]
    /\ LedgerFenced(w)
    /\ LET k == KeyOf(w)
           o == wresp[w]
       IN IF o = "not_applied"
          THEN /\ wretry' = [wretry EXCEPT ![w] = TRUE]
               /\ Goto(w, "authorise")
               /\ UNCHANGED <<idem, idemRes, wr, wt, ws, lost, wcancel, wresp, wlock, wstep>>
          ELSE IF idem[k] \in {"PENDING", "UNKNOWN"}
          THEN /\ idem' = [idem EXCEPT ![k] = "COMPLETED"]
               /\ idemRes' = [idemRes EXCEPT ![k] = o]
               /\ Goto(w, "journalOut")
               /\ wlock' = [wlock EXCEPT ![w] = FALSE]
               /\ UNCHANGED <<wr, wt, ws, lost, wcancel, wresp, wretry, wstep>>
          ELSE /\ ToIdle(w)
               /\ UNCHANGED <<idem, idemRes>>
    /\ UNCHANGED <<run, ev, appr, eff, dl, child, flags>>

(* The agent tool: createChildRun is idempotent per (parent, call) and is   *)
(* not fenced; execute returns the child's outcome when terminal, else it   *)
(* asks to wait.                                                            *)
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
                            cancelReq |-> FALSE, attempts |-> 0, failed |-> 0, lastSeq |-> 1],
                       !.ev[Child] = <<E("user.message", 0, "", "")>>]
       IN \/ /\ c.status # "ABSENT" /\ c.status \in Terminal /\ canComplete
             /\ UNCHANGED <<run, ev, appr>>
             /\ idem' = [idem EXCEPT ![k] = "COMPLETED"]
             /\ idemRes' = [idemRes EXCEPT ![k] = "completed"]
             /\ Goto(w, "journalOut")
          \/ /\ c.status # "ABSENT" /\ ~(c.status \in Terminal)
             /\ UNCHANGED <<run, ev, appr, idem, idemRes>>
             /\ Goto(w, "waitAppend")
          \/ /\ c.status = "ABSENT" /\ ~parentActive /\ canComplete
             /\ UNCHANGED <<run, ev, appr>>
             /\ idem' = [idem EXCEPT ![k] = "COMPLETED"]
             /\ idemRes' = [idemRes EXCEPT ![k] = "completed"]
             /\ Goto(w, "journalOut")
          \/ /\ c.status = "ABSENT" /\ parentActive
             /\ SetStore(created)
             /\ UNCHANGED <<idem, idemRes>>
             /\ Goto(w, "waitAppend")
    /\ UNCHANGED <<eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

WaitAppend(w) ==
    /\ pc[w] = "waitAppend"
    /\ LET r == wr[w]
           s == wstep[w]
       IN IF Has(r, "tool.waiting", s)
          THEN PcOnly(w, "yieldTool")
          ELSE AppendStep(w, <<E("tool.waiting", s, "", "")>>, "yieldTool")

(* cancel-recovery.ts: reconcileStartedCalls, then terminals.cancel *)
CancelRec(w) ==
    /\ pc[w] = "cancelRec"
    /\ ~lost[w]
    /\ LET r == wr[w]
           s == wstep[w]
           k == <<r, s>>
           kind == RespKind(r, s)
           open == s > 0 /\ Has(r, "tool.started", s) /\ ~CallDone(r, s)
       IN \/ /\ ~open
             /\ PcOnly(w, "cancelFinish")
          \/ /\ open /\ idem[k] = "COMPLETED"
             /\ PcOnly(w, "cancelJournal")
          \/ /\ open /\ idem[k] = "UNKNOWN"
             /\ idemRes' = [idemRes EXCEPT ![k] = "unknown"]
             /\ Goto(w, "cancelJournal")
             /\ UNCHANGED <<run, ev, appr, idem, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>
          \/ /\ open /\ idem[k] = "PENDING" /\ kind = "spawn"
             /\ idem' = [idem EXCEPT ![k] = "COMPLETED"]
             /\ idemRes' = [idemRes EXCEPT ![k] = "completed"]
             /\ Goto(w, "cancelJournal")
             /\ UNCHANGED <<run, ev, appr, eff, dl, child, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>
          \/ /\ open /\ idem[k] = "PENDING" /\ kind \in {"exec", "rec"}
             /\ \/ /\ NoCallLock \/ ~Held(k)
                   /\ child' = Reaped(k)
                   /\ \E o \in (IF kind = "exec" THEN {"unknown", "abandon"}
                                ELSE IF eff[k] > 0 THEN {"already_applied", "unknown", "abandon"}
                                ELSE {"not_applied", "unknown", "abandon"}) :
                        IF o = "abandon"
                        THEN /\ idem' = [idem EXCEPT ![k] = "UNKNOWN"]
                             /\ idemRes' = [idemRes EXCEPT ![k] = "unknown"]
                        ELSE /\ idem' = [idem EXCEPT ![k] = "COMPLETED"]
                             /\ idemRes' = [idemRes EXCEPT ![k] = IF o = "not_applied" THEN "completed" ELSE o]
                \/ /\ UNCHANGED child
                   /\ idem' = [idem EXCEPT ![k] = "UNKNOWN"]
                   /\ idemRes' = [idemRes EXCEPT ![k] = "unknown"]
             /\ Goto(w, "cancelJournal")
             /\ UNCHANGED <<run, ev, appr, eff, dl, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

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
    \/ CancelRec(w) \/ CancelJournal(w) \/ CancelFinish(w) \/ StaleLedger(w)

-----------------------------------------------------------------------------
(* Environment: user cancel, approvals, deadline, sweeps, lease expiry *)

Deadline(r) ==
    /\ ~dl[r]
    /\ dl' = [dl EXCEPT ![r] = TRUE]
    /\ UNCHANGED <<run, ev, appr, idem, idemRes, eff, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

RequestCancel(r) ==
    /\ run[r].status \notin Terminal \cup {"CANCELLING", "ABSENT"}
    /\ LET to == CancelTarget(run[r].status)
       IN /\ to \in ServiceEdges[run[r].status]
          /\ SetStore(Change(Snap, r, to, <<>>, FALSE, FALSE))
    /\ UNCHANGED <<idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

Resolve(r, s, choice) ==
    /\ appr[r][s] = "pending"
    /\ ~run[r].cancelReq
    /\ LET S0 == [Snap EXCEPT !.appr[r][s] = "resolved"]
           lead == <<E("tool.permission.resolved", s, choice, "")>>
           settled == run[r].status = "WAITING_HUMAN" /\ PendingStep(S0, r) = {}
       IN SetStore(IF settled THEN Change(S0, r, "QUEUED", lead, FALSE, FALSE) ELSE AppendEvs(S0, r, lead))
    /\ UNCHANGED <<idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

SweepQueued(r) ==
    /\ run[r].status = "QUEUED" /\ dl[r]
    /\ "STOPPED" \in SweepEdges["QUEUED"]
    /\ SetStore(Change(Snap, r, "STOPPED", <<>>, FALSE, FALSE))
    /\ UNCHANGED <<idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

SweepHuman(r) ==
    /\ run[r].status = "WAITING_HUMAN"
    /\ PendingStep(Snap, r) # {} \/ dl[r]
    /\ "STOPPED" \in ServiceEdges["WAITING_HUMAN"]
    /\ LET due == PendingStep(Snap, r)
           S0 == [Snap EXCEPT !.appr[r] = [s \in Steps |-> IF s \in due THEN "expired" ELSE @[s]]]
           lead == IF due = {} THEN <<>>
                   ELSE LET s == CHOOSE x \in due : TRUE
                        IN <<E("tool.permission.cancelled", s, "expired", "")>>
       IN SetStore(Change(S0, r, "STOPPED", lead, FALSE, FALSE))
    /\ UNCHANGED <<idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

SweepTool(r) ==
    /\ run[r].status = "WAITING_TOOL" /\ dl[r]
    /\ "QUEUED" \in ServiceEdges["WAITING_TOOL"]
    /\ SetStore(Change(Snap, r, "QUEUED", <<>>, FALSE, FALSE))
    /\ UNCHANGED <<idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

ExpireLease(r) ==
    /\ run[r].status \in ClaimStatuses /\ run[r].owner # NoOwner /\ run[r].live
    /\ run' = [run EXCEPT ![r].live = FALSE]
    /\ UNCHANGED <<ev, appr, idem, idemRes, eff, dl, child, pc, wr, wt, ws, lost, wcancel, wresp, wretry, wlock, wstep, flags>>

HolderAlive(r) ==
    \E w \in Workers : pc[w] # "idle" /\ wr[w] = r /\ wt[w] = run[r].token /\ ~lost[w]

ExpireDead(r) == ~HolderAlive(r) /\ ExpireLease(r)

AllDone == \A r \in Runs : run[r].status \in Terminal \cup {"ABSENT"}

Terminated == AllDone /\ UNCHANGED vars

Next ==
    \/ \E w \in Workers : Claim(w) \/ ClaimNone(w) \/ Step(w) \/ HB(w) \/ Abort(w) \/ Crash(w)
    \/ \E r \in Runs : Deadline(r) \/ RequestCancel(r) \/ ExpireLease(r)
                       \/ SweepQueued(r) \/ SweepHuman(r) \/ SweepTool(r)
    \/ \E k \in Keys : ChildExit(k)
    \/ \E r \in Runs, s \in Steps, c \in {"allow", "reject"} : Resolve(r, s, c)
    \/ Terminated

Fairness ==
    /\ \A w \in Workers : WF_vars(Claim(w)) /\ WF_vars(ClaimNone(w)) /\ WF_vars(Step(w)) /\ WF_vars(HB(w)) /\ WF_vars(Abort(w))
    /\ \A r \in Runs : WF_vars(ExpireDead(r)) /\ WF_vars(SweepQueued(r))
                       /\ WF_vars(SweepHuman(r)) /\ WF_vars(SweepTool(r))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

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

ContiguousEvents == \A r \in Runs : run[r].lastSeq = Len(ev[r])

AtMostOnePendingApproval == \A r \in Runs : Cardinality(PendingStep(Snap, r)) <= 1

NoStaleAppend == ~flags.stale

AtMostOnceEffect == \A k \in Keys : eff[k] <= 1

(* When a worker holds the result of a reconcile, no process of the older   *)
(* attempt is alive any more: the reconcile reported on a call that has     *)
(* stopped.                                                                  *)
ReconcileSeesStoppedEffect == \A w \in Workers : pc[w] = "reconDone" => ~child[KeyOf(w)]

(* No worker is between the authorisation and the start of its effect       *)
(* while another worker reconciles the same call.                           *)
NoEffectDuringReconcile ==
    \A w, x \in Workers :
        (w # x /\ pc[w] \in {"reap", "reconcile", "reconDone"} /\ pc[x] = "doEffect") => KeyOf(w) # KeyOf(x)

LockIsExclusive ==
    \A w, x \in Workers : (w # x /\ wlock[w] /\ wlock[x]) => KeyOf(w) # KeyOf(x)

UnknownNeverRetried == ~flags.retryUnknown

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

WorkerSymmetry == Permutations(Workers)

=============================================================================
