---------------------------- MODULE RunRecord -----------------------------
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
    Refunds,
    MaxCalls,
    OwedAtFirstRecord,
    CloseRule,
    CallsAsFlag

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
       /\ MaxCalls \in Nat
       /\ OwedAtFirstRecord \in BOOLEAN
       /\ CloseRule \in {"settled", "nonOwed", "first"}
       /\ CallsAsFlag \in BOOLEAN

Calls == 1..MaxCalls

NoOpen == [on |-> FALSE, at |-> 0, ow |-> {}, unk |-> FALSE]
NoChain == [on |-> FALSE, at |-> 0, ow |-> {}, unk |-> FALSE]
NoUnc == [on |-> FALSE, at |-> 0, cause |-> ""]

Terminal == {"COMPLETED", "STOPPED", "FAILED", "CANCELLED"}
ClaimSt == {"RUNNING", "CANCELLING"}

DeclaredEdges ==
    {<<"RUNNING", "QUEUED">>, <<"RUNNING", "WAITING">>, <<"RUNNING", "COMPLETED">>,
     <<"RUNNING", "STOPPED">>, <<"RUNNING", "FAILED">>, <<"RUNNING", "CANCELLING">>,
     <<"QUEUED", "CANCELLING">>, <<"WAITING", "CANCELLING">>, <<"CANCELLING", "CANCELLED">>,
     <<"QUEUED", "STOPPED">>, <<"WAITING", "STOPPED">>, <<"WAITING", "QUEUED">>,
     <<"QUEUED", "FAILED">>}

ProtocolEvent ==
    [S |-> {"run.started"}, F |-> {"attempt.failed"}, L |-> {"attempt.lost"}, T |-> {"run.status"},
     Q |-> {"model.requested"}, R |-> {"model.responded"}, O |-> {"tool.started"},
     C |-> {"tool.completed", "tool.reconciled"}]

KindsTheFoldNeverReads == {"Q"}

FoldReadsOutsideModel ==
    {"tool.call", "verification.completed", "tool.held", "tool.held.resolved", "run.quiescent",
     "tool.permission.requested", "tool.permission.resolved", "tool.unknown.requested",
     "tool.elicitation.requested", "mcp.authorization.required"}

VARIABLES st, owner, tok, live, rnw, origin, att, fa, nclaim, clk, ev,
          pc, wtok, wtake, wfail,
          truth, chain, unc, miss, badRec

vars == <<st, owner, tok, live, rnw, origin, att, fa, nclaim, clk, ev,
          pc, wtok, wtake, wfail, truth, chain, unc, miss, badRec>>

Ev(k, x, y, why) == [k |-> k, x |-> x, y |-> y, why |-> why]

Max(S) == CHOOSE x \in S : \A y \in S : y <= x
Min(S) == CHOOSE x \in S : \A y \in S : x <= y

-----------------------------------------------------------------------------

IdxOf(k) == {i \in DOMAIN ev : ev[i].k = k}
LastIdx(k) == IF IdxOf(k) = {} THEN 0 ELSE Max(IdxOf(k))
Count(k) == Cardinality(IdxOf(k))

StartedCalls ==
    {ev[i].y : i \in IdxOf("O")}
DoneCalls ==
    {ev[i].y : i \in IdxOf("C")}
RequestedCalls == UNION {ev[i].y : i \in IdxOf("R")}
OpenCalls == StartedCalls \ DoneCalls

Phase ==
    LET qr == {i \in DOMAIN ev : ev[i].k \in {"Q", "R"}}
        last == ev[Max(qr)]
    IN IF qr = {} THEN "loop"
       ELSE IF last.k = "Q" THEN "stream"
       ELSE IF last.y = {} THEN "final"
       ELSE IF RequestedCalls \ DoneCalls = {} THEN "loop"
       ELSE "calls"

CallPredatesStart(c) == LastIdx("S") > Max({i \in IdxOf("O") : ev[i].y = c})

FailureRecordsSinceStart ==
    {i \in DOMAIN ev : i > LastIdx("S") /\ ev[i].k \in {"F", "L"}}

RecOf(w) ==
    IF FailureRecordsSinceStart # {}
    THEN LET p == IF EarliestFailure THEN Min(FailureRecordsSinceStart) ELSE Max(FailureRecordsSinceStart)
         IN [x |-> IF ev[p].k = "F" THEN "worker_failure" ELSE "process_lost", y |-> ev[p].x]
    ELSE IF wtake[w].t THEN [x |-> "process_lost", y |-> wtake[w].at]
    ELSE [x |-> "none", y |-> 0]

-----------------------------------------------------------------------------

Opens(e) == IF FoldOpensOn = "records" THEN e.k \in {"F", "L"}
            ELSE e.k = "S" /\ e.x # "none"

OpenAt(e) == IF e.k = "S" THEN e.y ELSE e.x

IsProgress(e) ==
    \/ e.k = "R"
    \/ RequestIsProgress /\ e.k \in {"Q", "O"}
    \/ e.k = "T" /\ e.y = "COMPLETED"
    \/ StopAsProgress /\ e.k = "T" /\ e.y \in {"STOPPED", "CANCELLED"}

Verdict(unk, ow) == IF unk \/ ow # {} THEN "unknown_effect" ELSE "recovered"

Settle(fs, e) ==
    LET c == e.y
        oc == IF CallsAsFlag THEN {} ELSE fs.oc \ {c}
        ow == IF CallsAsFlag THEN {} ELSE fs.open.ow \ {c}
        unk == fs.open.unk \/ e.x = "unknown"
        stays == [fs EXCEPT !.oc = oc, !.open = [fs.open EXCEPT !.ow = ow, !.unk = unk]]
        ends == CASE CloseRule = "settled" -> ow = {}
                  [] CloseRule = "nonOwed" -> ow = {} \/ c \notin fs.open.ow
                  [] OTHER -> TRUE
        closed == [stays EXCEPT !.out = Append(@, [at |-> fs.open.at, out |-> Verdict(unk, ow)]), !.open = NoOpen, !.oc = oc]
    IN IF ~fs.open.on THEN [fs EXCEPT !.oc = oc]
       ELSE IF ends THEN closed
       ELSE stays

FoldStep(fs, e) ==
    LET s1 == IF e.k = "O" THEN [fs EXCEPT !.oc = @ \cup {e.y}] ELSE fs
        fresh == [on |-> TRUE, at |-> OpenAt(e), ow |-> s1.oc, unk |-> FALSE]
        grown == IF OwedAtFirstRecord THEN s1 ELSE [s1 EXCEPT !.open.ow = @ \cup s1.oc]
        closed(o) == [s1 EXCEPT !.out = Append(@, [at |-> s1.open.at, out |-> o]), !.open = NoOpen]
    IN IF e.k = "C" THEN Settle(s1, e)
       ELSE IF Opens(e)
       THEN IF ~s1.open.on THEN [s1 EXCEPT !.open = fresh]
            ELSE IF MergeChain THEN grown
            ELSE LET c == closed("failed") IN [c EXCEPT !.open = fresh]
       ELSE IF ~s1.open.on THEN s1
       ELSE IF e.k = "T" /\ e.y = "FAILED" THEN closed("failed")
       ELSE IF IsProgress(e) THEN closed(Verdict(s1.open.unk, s1.open.ow))
       ELSE IF e.k = "T" /\ e.y \in {"STOPPED", "CANCELLED"} THEN closed("stopped")
       ELSE s1

RECURSIVE FoldFrom(_, _)
FoldFrom(fs, i) == IF i > Len(ev) THEN fs ELSE FoldFrom(FoldStep(fs, ev[i]), i + 1)

Folded == FoldFrom([open |-> NoOpen, oc |-> {}, out |-> <<>>], 1)

-----------------------------------------------------------------------------

GFail(at, cause) ==
    /\ chain' = IF ~chain.on THEN [on |-> TRUE, at |-> at, ow |-> OpenCalls, unk |-> FALSE]
               ELSE [chain EXCEPT !.ow = @ \cup OpenCalls]
    /\ unc' = IF ~unc.on THEN [on |-> TRUE, at |-> at, cause |-> cause] ELSE unc
    /\ UNCHANGED truth

GClose(o) ==
    /\ truth' = IF ~chain.on THEN truth ELSE Append(truth, [at |-> chain.at, out |-> o])
    /\ chain' = NoChain
    /\ UNCHANGED unc

ProgressVerdict == IF chain.on /\ (chain.unk \/ chain.ow # {}) THEN "unknown_effect" ELSE "recovered"

GCloseProgress == GClose(ProgressVerdict)

GSettle(c, o) ==
    LET ow == chain.ow \ {c}
        unk == chain.unk \/ o = "unknown"
    IN /\ IF ~chain.on THEN UNCHANGED <<chain, truth>>
          ELSE IF ow = {}
               THEN /\ truth' = Append(truth, [at |-> chain.at, out |-> IF unk THEN "unknown_effect" ELSE "recovered"])
                    /\ chain' = NoChain
               ELSE /\ chain' = [chain EXCEPT !.ow = ow, !.unk = unk]
                    /\ UNCHANGED truth
       /\ UNCHANGED unc

GKeep == UNCHANGED <<chain, truth, unc>>

-----------------------------------------------------------------------------

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

Finish(w, to, o) ==
    /\ pc[w] \in {"claimed", "started"} /\ Fence(w) /\ st = "RUNNING"
    /\ st' = to /\ owner' = NoOwner /\ live' = FALSE
    /\ ev' = Append(ev, Ev("T", "RUNNING", to, "finish"))
    /\ ToIdle(w)
    /\ GClose(o)
    /\ UNCHANGED <<tok, rnw, origin, att, fa, nclaim, clk, miss, badRec>>

FinishStop(w) ==
    (pc[w] = "claimed" \/ Phase \in {"loop", "final"} \/ (Phase = "calls" /\ OpenCalls = {}))
        /\ Finish(w, "STOPPED", "stopped")

FinishFail(w) == Finish(w, "FAILED", "failed")

FinishDone(w) == pc[w] = "started" /\ Phase = "final" /\ Finish(w, "COMPLETED", ProgressVerdict)

CancelRun(w) ==
    /\ pc[w] \in {"claimed", "started"} /\ Fence(w) /\ st = "CANCELLING"
    /\ st' = "CANCELLED" /\ owner' = NoOwner /\ live' = FALSE
    /\ ev' = Append(ev, Ev("T", "CANCELLING", "CANCELLED", "cancel"))
    /\ ToIdle(w)
    /\ GClose("stopped")
    /\ UNCHANGED <<tok, rnw, origin, att, fa, nclaim, clk, miss, badRec>>

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
    /\ \E requested \in SUBSET (Calls \ RequestedCalls) :
          ev' = Append(ev, Ev("R", 0, requested, ""))
    /\ GCloseProgress
    /\ UNCHANGED <<st, owner, tok, live, rnw, origin, att, fa, nclaim, clk, pc, wtok, wtake, wfail, miss, badRec>>

AppendO(w, c) ==
    /\ pc[w] = "started" /\ Fence(w) /\ st = "RUNNING" /\ Phase = "calls"
    /\ c \in RequestedCalls \ StartedCalls
    /\ ev' = Append(ev, Ev("O", 0, c, ""))
    /\ UNCHANGED <<st, owner, tok, live, rnw, origin, att, fa, nclaim, clk, pc, wtok, wtake, wfail, truth, chain, unc, miss, badRec>>

AppendC(w, c, o) ==
    /\ pc[w] = "started" /\ Fence(w) /\ st = "RUNNING" /\ Phase = "calls"
    /\ c \in OpenCalls
    /\ o = "ok" \/ (o = "unknown" /\ CallPredatesStart(c))
    /\ ev' = Append(ev, Ev("C", o, c, ""))
    /\ GSettle(c, o)
    /\ UNCHANGED <<st, owner, tok, live, rnw, origin, att, fa, nclaim, clk, pc, wtok, wtake, wfail, miss, badRec>>

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

WaitYield(w) ==
    /\ pc[w] = "started" /\ Fence(w) /\ st = "RUNNING"
    /\ st' = "WAITING"
    /\ ev' = Append(ev, Ev("T", "RUNNING", "WAITING", "wait"))
    /\ owner' = NoOwner /\ live' = FALSE
    /\ fa' = 0
    /\ ToIdle(w)
    /\ UNCHANGED <<tok, rnw, origin, att, nclaim, clk, truth, chain, unc, miss, badRec>>

Step(w) ==
    \/ StartRun(w) \/ AppendQ(w) \/ AppendR(w)
    \/ (\E c \in Calls : AppendO(w, c) \/ AppendC(w, c, "ok") \/ AppendC(w, c, "unknown"))
    \/ FinishStop(w) \/ FinishFail(w) \/ FinishDone(w) \/ CancelRun(w)
    \/ Fail(w) \/ YieldFail(w) \/ Drain(w) \/ WaitYield(w)

-----------------------------------------------------------------------------

EnvStop(from, o) ==
    /\ st = from
    /\ st' = "STOPPED"
    /\ ev' = Append(ev, Ev("T", from, "STOPPED", "sweep"))
    /\ GClose(o)
    /\ UNCHANGED <<owner, tok, live, rnw, origin, att, fa, nclaim, clk, pc, wtok, wtake, wfail, miss, badRec>>

SweepQueued == EnvStop("QUEUED", "stopped")

SweepWaiting == EnvStop("WAITING", "stopped")

ResolveWake ==
    /\ st = "WAITING"
    /\ st' = "QUEUED"
    /\ ev' = Append(ev, Ev("T", "WAITING", "QUEUED", "wake"))
    /\ UNCHANGED <<owner, tok, live, rnw, origin, att, fa, nclaim, clk, pc, wtok, wtake, wfail, truth, chain, unc, miss, badRec>>

RequestCancel ==
    /\ st \in {"QUEUED", "RUNNING", "WAITING"}
    /\ st' = "CANCELLING" /\ origin' = st
    /\ ev' = Append(ev, Ev("T", st, "CANCELLING", "cancel"))
    /\ UNCHANGED <<owner, tok, live, rnw, att, fa, nclaim, clk, pc, wtok, wtake, wfail, truth, chain, unc, miss, badRec>>

FinishCancelled ==
    /\ SweeperOwned /\ (owner = NoOwner \/ ~live)
    /\ st' = "CANCELLED" /\ owner' = NoOwner /\ live' = FALSE
    /\ ev' = Append(ev, Ev("T", "CANCELLING", "CANCELLED", "sweep"))
    /\ GClose("stopped")
    /\ UNCHANGED <<tok, rnw, origin, att, fa, nclaim, clk, pc, wtok, wtake, wfail, miss, badRec>>

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

TypeOK ==
    /\ st \in Terminal \cup {"QUEUED", "RUNNING", "WAITING", "CANCELLING"}
    /\ owner = NoOwner \/ owner \in Workers
    /\ \A i \in DOMAIN ev : ev[i].k \in {"S", "F", "L", "T", "Q", "R", "O", "C"}
    /\ \A w \in Workers : pc[w] \in {"idle", "claimed", "started", "failed"}
    /\ att \in Int /\ fa \in Nat

OnlyDeclaredEdges ==
    \A i \in DOMAIN ev : ev[i].k = "T" => <<ev[i].x, ev[i].y>> \in DeclaredEdges

NoMissingRecord == ~miss

FailedBeforeRequeue ==
    \A i \in DOMAIN ev :
        (ev[i].k = "T" /\ ev[i].x = "RUNNING" /\ ev[i].y = "QUEUED")
            => ((ev[i].why = "fail") <=> (i > 1 /\ ev[i - 1].k = "F"))

RecoveryFieldExact == ~badRec

FoldMatchesTruth == Folded.out = truth

TerminalFoldTotal == st \in Terminal => ~Folded.open.on

FailedEventsAtMostTotalAttempts == Count("F") <= MaxTotalAttempts

Bound == Len(ev) <= MaxEvents /\ clk <= MaxClk

CallsFocus == st \notin {"WAITING", "CANCELLING", "CANCELLED"}

WorkerSymmetry == Permutations(Workers)

=============================================================================
