---------------------------- MODULE RunRecord -----------------------------
(***************************************************************************)
(* Model of the record that makes recovery measurable (design              *)
(* design-reliability-report.md, increment I4): the journal events        *)
(* attempt.failed (F) and the takeover record (L), the run.started        *)
(* recovery field (S), and the fold that turns the journal into recovery   *)
(* episodes. Specs/tla/RunRecovery.tla models what the run may do; this    *)
(* module models what is written down about a failure and whether the     *)
(* fold of the journal recovers the truth.                                 *)
(*                                                                         *)
(* Code sources modelled (release/rc1)                                    *)
(*   packages/store/src/runtime-store.ts  claim (TAKEOVER), heartbeat,     *)
(*       transition, release, releaseLease, requestCancel, appendAsService,*)
(*       finishCancelled, deadLetterExhausted, expireApprovals, resolve    *)
(*       approval / elicitation (the QUEUED wake), changeStatus           *)
(*   packages/runtime/src/worker/claim-runner.ts  drive, requeueOrStop,    *)
(*       the run.started append                                           *)
(*   packages/runtime/src/worker/terminals.ts  finish, yieldTo, cancel,    *)
(*       yieldLease                                                        *)
(*   packages/runtime/src/service/terminal-sweeper.ts                     *)
(*   packages/reliability/src/fold-facts.ts  the fold                      *)
(*                                                                         *)
(* Ghost variables (they decide nothing, they only state the truth): ghost *)
(* time is the logical clock clk; chain is the failure chain that is open *)
(* (a failure with no progress yet); truth is the list of chains that     *)
(* ended and how; unc is the earliest failure that no run.started carries *)
(* yet; miss and badRec are history flags.                                 *)
(*                                                                         *)
(* Abstractions (a proof holds only for this model):                       *)
(*   - one run. Parent and child runs act on each other only through the  *)
(*     service edges (a cancel cascade, the wake of a parent), which are   *)
(*     the RequestCancel and ResolveWake actions of a run; the record      *)
(*     rules are per run                                                   *)
(*   - time is a counter that moves when a lease is set or renewed and    *)
(*     when attempt.failed is stamped; wall-clock units are not modelled   *)
(*   - the lease lifetime and the heartbeat period are not modelled; the   *)
(*     lease expires nondeterministically (ExpireLease). The arithmetic     *)
(*     lastLiveAt = lease_expires_at - leaseMs holds only while the        *)
(*     process that renewed and the process that claims use one leaseMs;    *)
(*     that is not modelled and not claimed                                *)
(*   - model request, model response, tool call, tool completion or       *)
(*     reconcile are the events Q, R, O, C; one call at a time. The        *)
(*     reconcile result is an oracle (ok or unknown)                       *)
(*   - the cancel recovery of a CANCELLING run (reconciling started calls) *)
(*     is one step to CANCELLED                                            *)
(*   - the gateway, the tools, the hooks, the context step and background *)
(*     jobs write no field of the run row and no recovery event; their    *)
(*     failures reach the record only through requeueOrStop (Fail) or the  *)
(*     graceful yields (Drain)                                             *)
(*   - the deadline is not a clock: FinishStop stands for every stop that  *)
(*     is not a failure (deadline, budget, loop, refusal, max tokens)      *)
(*   - the facts sweeper and its cursor are in FactsSweeper.tla            *)
(*                                                                         *)
(* Switches. The configuration RunRecord is the design that the models     *)
(* hold. Every other configuration flips one switch back to the design as  *)
(* written, or to the code of rc1, and is evidence that an invariant       *)
(* catches it.                                                             *)
(*   LostAtClaim        claim appends the takeover record L in its own     *)
(*                      transaction                                        *)
(*   FailedBeforeYield  the failing worker appends F before the yield      *)
(*                      (FALSE: rc1, which never writes F, and a F after   *)
(*                      the yield, which the fence rejects)                *)
(*   FoldOpensOn        "records": a chain opens on F or L. "started": it  *)
(*                      opens on a run.started that carries recovery      *)
(*   EarliestFailure    the recovery field of run.started names the        *)
(*                      earliest failure record since the last run.started *)
(*                      (FALSE: the latest)                                *)
(*   MergeChain         failures with no progress between them are one     *)
(*                      episode (FALSE: each record opens an episode and   *)
(*                      closes the one before it as failed)                *)
(*   RequestIsProgress  Q and O count as progress                          *)
(*   StopAsProgress     a STOPPED or CANCELLED end counts as progress      *)
(*   Refunds            a failed attempt may be refunded                   *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    Workers,
    NoOwner,
    MaxClaims,
    MaxAttempts,
    MaxTotalAttempts,
    MaxEvents,
    MaxClk,
    LostAtClaim,
    FailedBeforeYield,
    FoldOpensOn,
    EarliestFailure,
    MergeChain,
    RequestIsProgress,
    StopAsProgress,
    Refunds

ASSUME /\ MaxClaims \in Nat \ {0}
       /\ MaxAttempts \in Nat \ {0}
       /\ MaxTotalAttempts \in Nat \ {0}
       /\ MaxTotalAttempts >= MaxAttempts
       /\ LostAtClaim \in BOOLEAN
       /\ FailedBeforeYield \in BOOLEAN
       /\ FoldOpensOn \in {"records", "started"}
       /\ EarliestFailure \in BOOLEAN
       /\ MergeChain \in BOOLEAN
       /\ RequestIsProgress \in BOOLEAN
       /\ StopAsProgress \in BOOLEAN
       /\ Refunds \in BOOLEAN

NoOpen == [on |-> FALSE, at |-> 0, aw |-> FALSE, unk |-> FALSE]
NoChain == [on |-> FALSE, at |-> 0]
NoUnc == [on |-> FALSE, at |-> 0, cause |-> ""]

Terminal == {"COMPLETED", "STOPPED", "FAILED", "CANCELLED"}
ClaimSt == {"RUNNING", "CANCELLING"}

(* WAITING stands for WAITING_HUMAN and WAITING_TOOL. Every status edge    *)
(* the model takes; test/spec-drift-record.test.ts checks each against the *)
(* transition tables of the store.                                         *)
DeclaredEdges ==
    {<<"RUNNING", "QUEUED">>, <<"RUNNING", "WAITING">>, <<"RUNNING", "COMPLETED">>,
     <<"RUNNING", "STOPPED">>, <<"RUNNING", "FAILED">>, <<"RUNNING", "CANCELLING">>,
     <<"QUEUED", "CANCELLING">>, <<"WAITING", "CANCELLING">>, <<"CANCELLING", "CANCELLED">>,
     <<"QUEUED", "STOPPED">>, <<"WAITING", "STOPPED">>, <<"WAITING", "QUEUED">>,
     <<"QUEUED", "FAILED">>}

(* The journal event type of every event kind of the model *)
ProtocolEvent ==
    [S |-> "run.started", F |-> "attempt.failed", L |-> "attempt.lost", T |-> "run.status",
     Q |-> "model.requested", R |-> "model.responded", O |-> "tool.started", C |-> "tool.completed"]

VARIABLES st, owner, tok, live, rnw, origin, att, fa, nclaim, clk, ev,
          pc, wtok, wtake, wfail,
          truth, chain, unc, miss, badRec

vars == <<st, owner, tok, live, rnw, origin, att, fa, nclaim, clk, ev,
          pc, wtok, wtake, wfail, truth, chain, unc, miss, badRec>>

(* st, owner, tok, live, rnw, origin, att, fa  the runs row: status, lease *)
(*   owner, lease token, lease unexpired, the clock at the last renewal,   *)
(*   cancel origin, attempts, consecutive failed attempts                  *)
(* ev     the events table; an event is [k, x, y, why]; why is a ghost    *)
(*        tag that no reader of the journal may use                       *)
(* pc, wtok, wtake, wfail  the worker: program counter, lease token,      *)
(*        Claim.takeover (taken, lastLiveAt), refund of the failed attempt *)

Ev(k, x, y, why) == [k |-> k, x |-> x, y |-> y, why |-> why]

Max(S) == CHOOSE x \in S : \A y \in S : y <= x
Min(S) == CHOOSE x \in S : \A y \in S : x <= y

-----------------------------------------------------------------------------
(* Journal queries *)

IdxOf(k) == {i \in DOMAIN ev : ev[i].k = k}
LastIdx(k) == IF IdxOf(k) = {} THEN 0 ELSE Max(IdxOf(k))
Count(k) == Cardinality(IdxOf(k))

Phase ==
    LET work == {i \in DOMAIN ev : ev[i].k \in {"Q", "R", "O", "C"}}
        last == ev[Max(work)].k
    IN IF work = {} \/ last = "C" THEN "loop"
       ELSE IF last = "Q" THEN "stream"
       ELSE IF last = "R" THEN "decide"
       ELSE "settle"

CallPredatesStart == LastIdx("O") < LastIdx("S")

FailureRecordsSinceStart ==
    {i \in DOMAIN ev : i > LastIdx("S") /\ ev[i].k \in {"F", "L"}}

(* The rule of the worker that appends run.started (claim-runner.ts): the  *)
(* recovery field. The journal is read first; the claim's takeover is the  *)
(* fallback.                                                               *)
RecOf(w) ==
    IF FailureRecordsSinceStart # {}
    THEN LET p == IF EarliestFailure THEN Min(FailureRecordsSinceStart) ELSE Max(FailureRecordsSinceStart)
         IN [x |-> IF ev[p].k = "F" THEN "worker_failure" ELSE "process_lost", y |-> ev[p].x]
    ELSE IF wtake[w].t THEN [x |-> "process_lost", y |-> wtake[w].at]
    ELSE [x |-> "none", y |-> 0]

-----------------------------------------------------------------------------
(* The fold: fold-facts.ts over the journal. It reads event kinds and the  *)
(* fields x and y; it never reads why.                                     *)

Opens(e) == IF FoldOpensOn = "records" THEN e.k \in {"F", "L"}
            ELSE e.k = "S" /\ e.x # "none"

OpenAt(e) == IF e.k = "S" THEN e.y ELSE e.x

IsProgress(e) ==
    \/ e.k \in {"R", "C"}
    \/ RequestIsProgress /\ e.k \in {"Q", "O"}
    \/ e.k = "T" /\ e.y = "COMPLETED"
    \/ StopAsProgress /\ e.k = "T" /\ e.y \in {"STOPPED", "CANCELLED"}

FoldStep(fs, e) ==
    LET s1 == IF e.k = "O" THEN [fs EXCEPT !.callOpen = TRUE]
              ELSE IF e.k = "C"
              THEN [fs EXCEPT !.callOpen = FALSE,
                              !.open = IF ~fs.open.on THEN NoOpen
                                       ELSE [fs.open EXCEPT !.aw = FALSE, !.unk = @ \/ e.x = "unknown"]]
              ELSE fs
        fresh == [on |-> TRUE, at |-> OpenAt(e), aw |-> s1.callOpen, unk |-> FALSE]
        closed(o) == [s1 EXCEPT !.out = Append(@, [at |-> s1.open.at, out |-> o]), !.open = NoOpen]
        verdict == IF s1.open.on /\ (s1.open.aw \/ s1.open.unk) THEN "unknown_effect" ELSE "recovered"
    IN IF Opens(e)
       THEN IF ~s1.open.on THEN [s1 EXCEPT !.open = fresh]
            ELSE IF MergeChain THEN s1
            ELSE LET c == closed("failed") IN [c EXCEPT !.open = fresh]
       ELSE IF ~s1.open.on THEN s1
       ELSE IF e.k = "T" /\ e.y = "FAILED" THEN closed("failed")
       ELSE IF IsProgress(e) THEN closed(verdict)
       ELSE IF e.k = "T" /\ e.y \in {"STOPPED", "CANCELLED"} THEN closed("stopped")
       ELSE s1

RECURSIVE FoldFrom(_, _)
FoldFrom(fs, i) == IF i > Len(ev) THEN fs ELSE FoldFrom(FoldStep(fs, ev[i]), i + 1)

Folded == FoldFrom([open |-> NoOpen, callOpen |-> FALSE, out |-> <<>>], 1)

-----------------------------------------------------------------------------
(* Ghost updates *)

GFail(at, cause) ==
    /\ chain' = IF ~chain.on THEN [on |-> TRUE, at |-> at] ELSE chain
    /\ unc' = IF ~unc.on THEN [on |-> TRUE, at |-> at, cause |-> cause] ELSE unc
    /\ UNCHANGED truth

GClose(o) ==
    /\ truth' = IF ~chain.on THEN truth ELSE Append(truth, [at |-> chain.at, out |-> o])
    /\ chain' = NoChain
    /\ UNCHANGED unc

GKeep == UNCHANGED <<chain, truth, unc>>

-----------------------------------------------------------------------------
(* Store helpers *)

Fence(w) == tok = wtok[w] /\ owner = w /\ st \in ClaimSt

SweeperOwned == st = "CANCELLING" /\ origin \in {"QUEUED", "WAITING"}

Takeover == st \in ClaimSt /\ owner # NoOwner

Claimable ==
    \/ st = "QUEUED"
    \/ st \in ClaimSt /\ ~SweeperOwned /\ (owner = NoOwner \/ ~live)

Exhausted ==
    \/ Takeover /\ fa + 1 >= MaxAttempts
    \/ att + 1 > MaxTotalAttempts

ToIdle(w) ==
    /\ pc' = [pc EXCEPT ![w] = "idle"]
    /\ wtok' = [wtok EXCEPT ![w] = 0]
    /\ wtake' = [wtake EXCEPT ![w] = [t |-> FALSE, at |-> 0]]
    /\ wfail' = [wfail EXCEPT ![w] = FALSE]

KeepWorker(w) == UNCHANGED <<pc, wtok, wtake, wfail>>

KeepLease == UNCHANGED <<tok, rnw, nclaim, clk>>

Init ==
    /\ st = "QUEUED" /\ owner = NoOwner /\ tok = 0 /\ live = FALSE /\ rnw = 0
    /\ origin = "" /\ att = 0 /\ fa = 0 /\ nclaim = 0 /\ clk = 0
    /\ ev = <<>>
    /\ pc = [w \in Workers |-> "idle"]
    /\ wtok = [w \in Workers |-> 0]
    /\ wtake = [w \in Workers |-> [t |-> FALSE, at |-> 0]]
    /\ wfail = [w \in Workers |-> FALSE]
    /\ truth = <<>> /\ chain = NoChain /\ unc = NoUnc
    /\ miss = FALSE /\ badRec = FALSE

-----------------------------------------------------------------------------
(* store.claim. It does not append a status event. When LostAtClaim, a      *)
(* takeover appends L in the same transaction.                              *)

Claim(w) ==
    /\ pc[w] = "idle" /\ nclaim < MaxClaims
    /\ Claimable /\ ~Exhausted
    /\ st' = IF st = "QUEUED" THEN "RUNNING" ELSE st
    /\ owner' = w /\ tok' = tok + 1 /\ live' = TRUE
    /\ clk' = clk + 1 /\ rnw' = clk + 1
    /\ att' = att + 1
    /\ fa' = IF Takeover THEN fa + 1 ELSE fa
    /\ nclaim' = nclaim + 1
    /\ wtok' = [wtok EXCEPT ![w] = tok + 1]
    /\ wtake' = [wtake EXCEPT ![w] = [t |-> Takeover, at |-> rnw]]
    /\ wfail' = [wfail EXCEPT ![w] = FALSE]
    /\ pc' = [pc EXCEPT ![w] = "claimed"]
    /\ ev' = IF Takeover /\ LostAtClaim THEN Append(ev, Ev("L", rnw, 0, "")) ELSE ev
    /\ IF Takeover THEN GFail(rnw, "process_lost") ELSE GKeep
    /\ miss' = (miss \/ (Takeover /\ ~LostAtClaim))
    /\ UNCHANGED <<origin, badRec>>

HB(w) ==
    /\ pc[w] # "idle" /\ Fence(w)
    /\ clk' = clk + 1 /\ rnw' = clk + 1 /\ live' = TRUE
    /\ UNCHANGED <<st, owner, tok, origin, att, fa, nclaim, ev, pc, wtok, wtake, wfail, truth, chain, unc, miss, badRec>>

Crash(w) ==
    /\ pc[w] # "idle"
    /\ ToIdle(w)
    /\ UNCHANGED <<st, owner, tok, live, rnw, origin, att, fa, nclaim, clk, ev, truth, chain, unc, miss, badRec>>

Abort(w) ==
    /\ pc[w] # "idle" /\ ~Fence(w)
    /\ ToIdle(w)
    /\ UNCHANGED <<st, owner, tok, live, rnw, origin, att, fa, nclaim, clk, ev, truth, chain, unc, miss, badRec>>

ExpireLease ==
    /\ Takeover /\ live
    /\ live' = FALSE
    /\ UNCHANGED <<st, owner, tok, rnw, origin, att, fa, nclaim, clk, ev, pc, wtok, wtake, wfail, truth, chain, unc, miss, badRec>>

-----------------------------------------------------------------------------
(* The worker. A worker program counter is idle, claimed (before            *)
(* run.started), started, failed (attempt.failed is written, the yield     *)
(* is not).                                                                 *)

(* terminals.finish: the run ends. Used by the worker for COMPLETED,       *)
(* STOPPED and FAILED.                                                     *)
Finish(w, to, o) ==
    /\ pc[w] \in {"claimed", "started"} /\ Fence(w) /\ st = "RUNNING"
    /\ st' = to /\ owner' = NoOwner /\ live' = FALSE
    /\ ev' = Append(ev, Ev("T", "RUNNING", to, "finish"))
    /\ ToIdle(w)
    /\ GClose(o)
    /\ UNCHANGED <<tok, rnw, origin, att, fa, nclaim, clk, miss, badRec>>

FinishStop(w) == (pc[w] = "claimed" \/ Phase \in {"loop", "decide"}) /\ Finish(w, "STOPPED", "stopped")

FinishFail(w) == Finish(w, "FAILED", "failed")

FinishDone(w) == pc[w] = "started" /\ Phase = "decide" /\ Finish(w, "COMPLETED", "recovered")

(* terminals.cancel after the cancel recovery *)
CancelRun(w) ==
    /\ pc[w] \in {"claimed", "started"} /\ Fence(w) /\ st = "CANCELLING"
    /\ st' = "CANCELLED" /\ owner' = NoOwner /\ live' = FALSE
    /\ ev' = Append(ev, Ev("T", "CANCELLING", "CANCELLED", "cancel"))
    /\ ToIdle(w)
    /\ GClose("stopped")
    /\ UNCHANGED <<tok, rnw, origin, att, fa, nclaim, clk, miss, badRec>>

(* The append of run.started in drive. The recovery field is computed only *)
(* when the fold reads it.                                                 *)
StartRun(w) ==
    /\ pc[w] = "claimed" /\ Fence(w) /\ st = "RUNNING"
    /\ LET rec == IF FoldOpensOn = "started" THEN RecOf(w) ELSE [x |-> "none", y |-> 0]
           expected == IF ~unc.on THEN [x |-> "none", y |-> 0] ELSE [x |-> unc.cause, y |-> unc.at]
       IN /\ ev' = Append(ev, Ev("S", rec.x, rec.y, ""))
          /\ badRec' = (badRec \/ (FoldOpensOn = "started" /\ rec # expected))
    /\ unc' = NoUnc
    /\ pc' = [pc EXCEPT ![w] = "started"]
    /\ UNCHANGED <<st, owner, tok, live, rnw, origin, att, fa, nclaim, clk, wtok, wtake, wfail, truth, chain, miss>>

AppendQ(w) ==
    /\ pc[w] = "started" /\ Fence(w) /\ st = "RUNNING" /\ Phase = "loop"
    /\ ev' = Append(ev, Ev("Q", 0, 0, ""))
    /\ UNCHANGED <<st, owner, tok, live, rnw, origin, att, fa, nclaim, clk, pc, wtok, wtake, wfail, truth, chain, unc, miss, badRec>>

AppendR(w) ==
    /\ pc[w] = "started" /\ Fence(w) /\ st = "RUNNING" /\ Phase = "stream"
    /\ ev' = Append(ev, Ev("R", 0, 0, ""))
    /\ GClose("recovered")
    /\ UNCHANGED <<st, owner, tok, live, rnw, origin, att, fa, nclaim, clk, pc, wtok, wtake, wfail, miss, badRec>>

AppendO(w) ==
    /\ pc[w] = "started" /\ Fence(w) /\ st = "RUNNING" /\ Phase = "decide"
    /\ ev' = Append(ev, Ev("O", 0, 0, ""))
    /\ UNCHANGED <<st, owner, tok, live, rnw, origin, att, fa, nclaim, clk, pc, wtok, wtake, wfail, truth, chain, unc, miss, badRec>>

AppendC(w, o) ==
    /\ pc[w] = "started" /\ Fence(w) /\ st = "RUNNING" /\ Phase = "settle"
    /\ o = "ok" \/ (o = "unknown" /\ CallPredatesStart)
    /\ ev' = Append(ev, Ev("C", o, 0, ""))
    /\ GClose(IF o = "ok" THEN "recovered" ELSE "unknown_effect")
    /\ UNCHANGED <<st, owner, tok, live, rnw, origin, att, fa, nclaim, clk, pc, wtok, wtake, wfail, miss, badRec>>

(* requeueOrStop, the requeue branches: attempt.failed first, then the     *)
(* yield. Two steps; a crash or a takeover can fall between them.         *)
Fail(w) ==
    /\ pc[w] \in {"claimed", "started"} /\ Fence(w) /\ st = "RUNNING"
    /\ \E refund \in IF Refunds THEN BOOLEAN ELSE {FALSE} :
          /\ wfail' = [wfail EXCEPT ![w] = refund]
          /\ ev' = IF FailedBeforeYield THEN Append(ev, Ev("F", clk + 1, 0, "")) ELSE ev
    /\ clk' = clk + 1
    /\ GFail(clk + 1, "worker_failure")
    /\ miss' = (miss \/ ~FailedBeforeYield)
    /\ pc' = [pc EXCEPT ![w] = "failed"]
    /\ UNCHANGED <<st, owner, tok, live, rnw, origin, att, fa, nclaim, wtok, wtake, badRec>>

(* terminals.yieldTo('QUEUED') after a failure. A CANCELLING run is not    *)
(* moved: yieldLease releases its lease (terminals.ts settle).             *)
YieldFail(w) ==
    /\ pc[w] = "failed" /\ Fence(w)
    /\ IF st = "RUNNING"
       THEN /\ st' = "QUEUED"
            /\ ev' = Append(ev, Ev("T", "RUNNING", "QUEUED", "fail"))
       ELSE /\ UNCHANGED st
            /\ UNCHANGED ev
    /\ owner' = NoOwner /\ live' = FALSE
    /\ fa' = 0
    /\ att' = IF wfail[w] THEN att - 1 ELSE att
    /\ ToIdle(w)
    /\ UNCHANGED <<tok, rnw, origin, nclaim, clk, truth, chain, unc, miss, badRec>>

(* yieldLease, and every yieldTo('QUEUED') that is not a failure: graceful *)
(* shutdown, the mode change, the context step. The attempt is refunded.   *)
Drain(w) ==
    /\ pc[w] \in {"claimed", "started"} /\ Fence(w)
    /\ IF st = "RUNNING"
       THEN /\ st' = "QUEUED"
            /\ ev' = Append(ev, Ev("T", "RUNNING", "QUEUED", "drain"))
       ELSE /\ UNCHANGED st
            /\ UNCHANGED ev
    /\ owner' = NoOwner /\ live' = FALSE
    /\ fa' = 0 /\ att' = att - 1
    /\ ToIdle(w)
    /\ UNCHANGED <<tok, rnw, origin, nclaim, clk, truth, chain, unc, miss, badRec>>

(* yieldTo('WAITING_HUMAN') or ('WAITING_TOOL') *)
WaitYield(w) ==
    /\ pc[w] = "started" /\ Fence(w) /\ st = "RUNNING"
    /\ st' = "WAITING"
    /\ ev' = Append(ev, Ev("T", "RUNNING", "WAITING", "wait"))
    /\ owner' = NoOwner /\ live' = FALSE
    /\ fa' = 0
    /\ ToIdle(w)
    /\ UNCHANGED <<tok, rnw, origin, att, nclaim, clk, truth, chain, unc, miss, badRec>>

Step(w) ==
    \/ StartRun(w) \/ AppendQ(w) \/ AppendR(w) \/ AppendO(w)
    \/ AppendC(w, "ok") \/ AppendC(w, "unknown")
    \/ FinishStop(w) \/ FinishFail(w) \/ FinishDone(w) \/ CancelRun(w)
    \/ Fail(w) \/ YieldFail(w) \/ Drain(w) \/ WaitYield(w)

-----------------------------------------------------------------------------
(* Environment: the service and the sweepers *)

EnvStop(from, o) ==
    /\ st = from
    /\ st' = "STOPPED"
    /\ ev' = Append(ev, Ev("T", from, "STOPPED", "sweep"))
    /\ GClose(o)
    /\ UNCHANGED <<owner, tok, live, rnw, origin, att, fa, nclaim, clk, pc, wtok, wtake, wfail, miss, badRec>>

(* sweepQueued and expireApprovals (the deadline, the approval timeout)    *)
SweepQueued == EnvStop("QUEUED", "stopped")

SweepWaiting == EnvStop("WAITING", "stopped")

(* resolveApproval, resolveElicitation, wakeRun, the expiry of a wait     *)
ResolveWake ==
    /\ st = "WAITING"
    /\ st' = "QUEUED"
    /\ ev' = Append(ev, Ev("T", "WAITING", "QUEUED", "wake"))
    /\ UNCHANGED <<owner, tok, live, rnw, origin, att, fa, nclaim, clk, pc, wtok, wtake, wfail, truth, chain, unc, miss, badRec>>

(* requestCancel, and the cancel cascade from a parent *)
RequestCancel ==
    /\ st \in {"QUEUED", "RUNNING", "WAITING"}
    /\ st' = "CANCELLING" /\ origin' = st
    /\ ev' = Append(ev, Ev("T", st, "CANCELLING", "cancel"))
    /\ UNCHANGED <<owner, tok, live, rnw, att, fa, nclaim, clk, pc, wtok, wtake, wfail, truth, chain, unc, miss, badRec>>

(* finishCancelled in terminal-sweeper.ts *)
FinishCancelled ==
    /\ SweeperOwned /\ (owner = NoOwner \/ ~live)
    /\ st' = "CANCELLED" /\ owner' = NoOwner /\ live' = FALSE
    /\ ev' = Append(ev, Ev("T", "CANCELLING", "CANCELLED", "sweep"))
    /\ GClose("stopped")
    /\ UNCHANGED <<tok, rnw, origin, att, fa, nclaim, clk, pc, wtok, wtake, wfail, miss, badRec>>

(* deadLetterExhausted in terminal-sweeper.ts, and the dead-letter pass at  *)
(* the head of claim                                                        *)
DeadLetter ==
    /\ Claimable /\ Exhausted
    /\ LET to == IF st = "CANCELLING" THEN "CANCELLED" ELSE "FAILED"
       IN /\ st' = to
          /\ ev' = Append(ev, Ev("T", st, to, "dead"))
          /\ GClose(IF to = "FAILED" THEN "failed" ELSE "stopped")
    /\ owner' = NoOwner /\ live' = FALSE
    /\ UNCHANGED <<tok, rnw, origin, att, fa, nclaim, clk, pc, wtok, wtake, wfail, miss, badRec>>

Next ==
    \/ \E w \in Workers : Claim(w) \/ HB(w) \/ Crash(w) \/ Abort(w) \/ Step(w)
    \/ ExpireLease \/ SweepQueued \/ SweepWaiting \/ ResolveWake
    \/ RequestCancel \/ FinishCancelled \/ DeadLetter

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
    /\ st \in Terminal \cup {"QUEUED", "RUNNING", "WAITING", "CANCELLING"}
    /\ owner = NoOwner \/ owner \in Workers
    /\ \A i \in DOMAIN ev : ev[i].k \in {"S", "F", "L", "T", "Q", "R", "O", "C"}
    /\ \A w \in Workers : pc[w] \in {"idle", "claimed", "started", "failed"}
    /\ att \in Int /\ fa \in Nat

(* Every status event is an edge of the store *)
OnlyDeclaredEdges ==
    \A i \in DOMAIN ev : ev[i].k = "T" => <<ev[i].x, ev[i].y>> \in DeclaredEdges

(* Every failure that happened has a record in the journal at the instant   *)
(* it happened: the claim that takes over a lease appends L, a failing      *)
(* worker appends F before it yields.                                       *)
NoMissingRecord == ~miss

(* A status event RUNNING -> QUEUED names a failure exactly when the event *)
(* before it is attempt.failed (a graceful yield writes none).             *)
FailedBeforeRequeue ==
    \A i \in DOMAIN ev :
        (ev[i].k = "T" /\ ev[i].x = "RUNNING" /\ ev[i].y = "QUEUED")
            => ((ev[i].why = "fail") <=> (i > 1 /\ ev[i - 1].k = "F"))

(* When the fold reads the recovery field of run.started, the field names  *)
(* the earliest failure that no earlier run.started carried, with its      *)
(* cause and instant, and a run.started carries none otherwise.            *)
RecoveryFieldExact == ~badRec

(* The episodes the fold closes are the failure chains that really ended,  *)
(* in order, with their start and their outcome.                           *)
FoldMatchesTruth == Folded.out = truth

(* The fold never leaves an open episode on a terminal run: fold-facts.ts  *)
(* throws then, and the sweeper would stop on that run.                    *)
TerminalFoldTotal == st \in Terminal => ~Folded.open.on

(* design-reliability-report.md 2.3 item 1: at most maxTotalAttempts       *)
(* attempt.failed per run                                                  *)
FailedEventsAtMostTotalAttempts == Count("F") <= MaxTotalAttempts

Bound == Len(ev) <= MaxEvents /\ clk <= MaxClk

WorkerSymmetry == Permutations(Workers)

=============================================================================
