--------------------------- MODULE ProcessStop ---------------------------
\* Limits the code inherits from the platforms, checked by test/process-stop-conformance.test.ts:
\* - darwin reads a start time with ps -o lstart, whose resolution is one second, so a pid reused within the same second reads the same start time.
\* - Begin and TermWaitEnds prove a target and signal it in one step. The code reads a start time only after holdersOf has listed the pid, so the window between holdersOf and the first startTimeOf cannot be closed where the listing carries no start time.
EXTENDS Naturals, FiniteSets

CONSTANTS Members, Events, MaxAttempts, Variant

ASSUME Variant \in {"decided", "noIdentityCheck", "termToReused", "signalUnlistedGroup", "throwOnSurvivor", "dropMarkerOnUnconfirmed", "signalUnprovedHolder", "killWithoutReproof", "retryReusesProof", "retryAnyEvent", "rowlessIsOutside", "groupProofWithoutStartTime", "exitingCountsAlive", "forkFromExiting", "settleCandidate", "settleCurrent", "guardCurrent", "jobCurrent", "reconcileCurrent"}
ASSUME MaxAttempts \in Nat \ {0}
ASSUME Events # {}

MemberStates == {"live", "stuck", "exiting", "zombie", "gone"}

Settle == Variant \in {"settleCandidate", "settleCurrent", "guardCurrent", "jobCurrent", "reconcileCurrent"}
SettleCurrent == Variant = "settleCurrent"
GuardCurrent == Variant = "guardCurrent"
JobCurrent == Variant = "jobCurrent"
ReconcileCurrent == Variant = "reconcileCurrent"

VARIABLES inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed

vars == <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed>>

TypeOK ==
    /\ inGroup \in [Members -> BOOLEAN]
    /\ listed \in [Members -> BOOLEAN]
    /\ swapped \in [Members -> BOOLEAN]
    /\ provedOnce \in [Members -> BOOLEAN]
    /\ hstage \in [Members -> {"idle", "term", "kill"}]
    /\ attempts \in 0..MaxAttempts
    /\ retried \in [Events -> 0..MaxAttempts]
    /\ state \in [Members -> MemberStates]
    /\ other \in BOOLEAN
    /\ mode \in {"live", "recorded"}
    /\ phase \in {"idle", "termWait", "killWait", "done", "settle", "listing", "groupProbe"}
    /\ termSent \in BOOLEAN
    /\ killSent \in BOOLEAN
    /\ outcome \in {"none", "gone", "terminated", "killed", "unconfirmed", "throw", "free", "silent", "job", "unchecked"}
    /\ marker \in {"kept", "none"}
    /\ unprovedSignalled \in BOOLEAN
    /\ begunUnproved \in BOOLEAN
    /\ shown \in {"none", "running", "final", "guard", "unchecked", "gone"}
    /\ basis \in BOOLEAN
    /\ listFailed \in BOOLEAN

GroupOurs == {m \in Members : inGroup[m] /\ state[m] # "gone"}

CanStillRun(m) == state[m] \in {"live", "stuck"}

GroupRunnable == {m \in Members : inGroup[m] /\ CanStillRun(m)}

GroupAlive == IF Variant = "exitingCountsAlive" THEN GroupOurs # {} ELSE GroupRunnable # {}

Rowless(m) == state[m] = "gone" /\ ~swapped[m]

Outside == {m \in Members : listed[m] /\ (~inGroup[m] \/ (Variant = "rowlessIsOutside" /\ Rowless(m)))}

Holding(m) == state[m] \in {"live", "stuck", "exiting"}

SomeoneRuns == \E m \in Members : CanStillRun(m)

Named == {m \in Members : listed[m] /\ Holding(m)}

ObsHeld ==
    IF mode = "live"
    THEN \E m \in Members : Holding(m)
    ELSE \E m \in Members : Holding(m) /\ (state[m] # "exiting" \/ listed[m])

HolderVisible(m) == m \in Outside /\ (IF Settle THEN Holding(m) ELSE state[m] # "gone")

OursVisible == GroupRunnable # {} \/ \E m \in Members : HolderVisible(m)

AllEventsSpent == \A e \in Events : retried[e] >= 1

Init ==
    /\ inGroup \in [Members -> BOOLEAN]
    /\ listed \in [Members -> BOOLEAN]
    /\ swapped = [m \in Members |-> FALSE]
    /\ provedOnce = [m \in Members |-> FALSE]
    /\ hstage = [m \in Members |-> "idle"]
    /\ attempts = 0
    /\ retried = [e \in Events |-> 0]
    /\ state \in [Members -> MemberStates]
    /\ mode \in {"live", "recorded"}
    /\ other \in BOOLEAN
    /\ (other => (mode = "recorded" /\ {m \in Members : inGroup[m] /\ state[m] # "gone"} = {}))
    /\ (mode = "live" => \A m \in Members : ~listed[m] /\ inGroup[m])
    /\ \A m \in Members : (~Settle /\ ~inGroup[m]) => listed[m]
    /\ (Settle => (\A m \in Members : inGroup[m] => ~CanStillRun(m)))
    /\ phase = IF Settle THEN "settle" ELSE "idle"
    /\ termSent = FALSE
    /\ killSent = FALSE
    /\ outcome = "none"
    /\ marker = "kept"
    /\ unprovedSignalled = FALSE
    /\ begunUnproved = FALSE
    /\ shown = "none"
    /\ basis = FALSE
    /\ listFailed = FALSE

GroupSeen == IF mode = "live" THEN GroupAlive ELSE GroupAlive \/ other

Seen == GroupSeen \/ \E m \in Members : HolderVisible(m)

ListedHolderInGroup == \E m \in Members : listed[m] /\ inGroup[m] /\ state[m] # "gone"

Proved == mode = "live" \/ ListedHolderInGroup

ReusedHolderInGroup == \E m \in Members : listed[m] /\ inGroup[m] /\ swapped[m]

GateTerm ==
    CASE Variant \in {"noIdentityCheck", "termToReused"} -> TRUE
      [] Variant = "signalUnlistedGroup" -> Proved \/ (GroupOurs # {} /\ ~other)
      [] Variant = "groupProofWithoutStartTime" -> Proved \/ ReusedHolderInGroup
      [] OTHER -> Proved

GateKill ==
    CASE Variant = "noIdentityCheck" -> TRUE
      [] Variant = "signalUnlistedGroup" -> Proved \/ (GroupOurs # {} /\ ~other)
      [] Variant = "groupProofWithoutStartTime" -> Proved \/ ReusedHolderInGroup
      [] OTHER -> Proved

KeepOnUnconfirmed == Variant # "dropMarkerOnUnconfirmed"

Reuse ==
    /\ mode = "recorded"
    /\ GroupOurs = {}
    /\ ~other
    /\ other' = TRUE
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed>>

MemberExits(m) ==
    /\ state[m] \in {"live", "stuck"}
    /\ state' = [state EXCEPT ![m] = "exiting"]
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed>>

Fork(m, n) ==
    /\ inGroup[m]
    /\ (CanStillRun(m) \/ (Variant = "forkFromExiting" /\ state[m] = "exiting"))
    /\ inGroup[n]
    /\ state[n] = "gone"
    /\ ~swapped[n]
    /\ state' = [state EXCEPT ![n] = "live"]
    /\ listed' = [listed EXCEPT ![n] = listed[m]]
    /\ provedOnce' = [provedOnce EXCEPT ![n] = FALSE]
    /\ hstage' = [hstage EXCEPT ![n] = "idle"]
    /\ UNCHANGED <<inGroup, swapped, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed>>

MemberFinishesExit(m) ==
    /\ state[m] = "exiting"
    /\ state' = [state EXCEPT ![m] = "zombie"]
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed>>

InitReaps(m) ==
    /\ state[m] = "zombie"
    /\ state' = [state EXCEPT ![m] = "gone"]
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed>>

MemberDies(m) ==
    /\ state[m] = "live"
    /\ inGroup[m]
    /\ (termSent \/ killSent)
    /\ state' = [state EXCEPT ![m] = "exiting"]
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed>>

ReusePid(m) ==
    /\ mode = "recorded"
    /\ state[m] = "gone"
    /\ ~swapped[m]
    /\ swapped' = [swapped EXCEPT ![m] = TRUE]
    /\ UNCHANGED <<inGroup, listed, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed>>

HolderTargetProved(m) == state[m] # "gone" /\ ~swapped[m]

SignalHits(m) == state[m] # "gone" \/ swapped[m]

TermAllowed(m) ==
    CASE Variant = "signalUnprovedHolder" -> listed[m] /\ SignalHits(m)
      [] Variant = "retryReusesProof" -> listed[m] /\ SignalHits(m) /\ (HolderTargetProved(m) \/ (provedOnce[m] /\ attempts > 0))
      [] Variant = "rowlessIsOutside" -> listed[m] /\ (HolderTargetProved(m) \/ Rowless(m))
      [] OTHER -> listed[m] /\ HolderTargetProved(m)

KillAllowed(m) ==
    IF Variant = "killWithoutReproof" THEN listed[m] /\ SignalHits(m) ELSE TermAllowed(m)

SigT(m) == m \in Outside /\ TermAllowed(m)

SigK(m) == m \in Outside /\ hstage[m] = "term" /\ KillAllowed(m)

Finish(result, keep) ==
    /\ phase' = "done"
    /\ outcome' = result
    /\ marker' = IF Settle \/ keep THEN "kept" ELSE "none"

GroupTermGo == GroupSeen /\ GateTerm

GroupKillGo == GroupSeen /\ GateKill

Begin ==
    /\ phase = "idle"
    /\ IF ~Seen
       THEN /\ Finish("gone", FALSE)
            /\ UNCHANGED <<termSent, unprovedSignalled, begunUnproved, state, hstage, provedOnce, listFailed>>
       ELSE IF ~(GroupTermGo \/ \E m \in Members : SigT(m))
            THEN /\ Finish("unconfirmed", KeepOnUnconfirmed)
                 /\ begunUnproved' = (GroupSeen /\ ~Proved)
                 /\ UNCHANGED <<termSent, unprovedSignalled, state, hstage, provedOnce, listFailed>>
            ELSE /\ phase' = "termWait"
                 /\ termSent' = GroupTermGo
                 /\ unprovedSignalled' = (unprovedSignalled \/ (GroupTermGo /\ ~Proved) \/ \E m \in Members : SigT(m) /\ ~HolderTargetProved(m))
                 /\ begunUnproved' = (GroupSeen /\ ~Proved)
                 /\ hstage' = [m \in Members |-> IF SigT(m) THEN "term" ELSE "idle"]
                 /\ provedOnce' = [m \in Members |-> provedOnce[m] \/ (SigT(m) /\ HolderTargetProved(m))]
                 /\ \E dies \in SUBSET Members : state' = [m \in Members |-> IF SigT(m) /\ state[m] = "live" /\ m \in dies THEN "exiting" ELSE state[m]]
                 /\ UNCHANGED <<outcome, marker, listFailed>>
    /\ UNCHANGED <<inGroup, listed, swapped, attempts, retried, other, mode, killSent, shown, basis, listFailed>>

TermWaitEnds ==
    /\ phase = "termWait"
    /\ IF ~Seen
       THEN /\ Finish("terminated", FALSE)
            /\ UNCHANGED <<killSent, unprovedSignalled, state, hstage, listFailed>>
       ELSE IF ~(GroupKillGo \/ \E m \in Members : SigK(m))
            THEN /\ Finish("unconfirmed", KeepOnUnconfirmed)
                 /\ UNCHANGED <<killSent, unprovedSignalled, state, hstage, listFailed>>
            ELSE /\ phase' = "killWait"
                 /\ killSent' = GroupKillGo
                 /\ unprovedSignalled' = (unprovedSignalled \/ (GroupKillGo /\ ~Proved) \/ \E m \in Members : SigK(m) /\ ~HolderTargetProved(m))
                 /\ hstage' = [m \in Members |-> IF SigK(m) THEN "kill" ELSE hstage[m]]
                 /\ state' = [m \in Members |-> IF SigK(m) /\ state[m] = "live" THEN "exiting" ELSE state[m]]
                 /\ UNCHANGED <<outcome, marker, listFailed>>
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, attempts, retried, other, mode, termSent, begunUnproved, shown, basis, listFailed>>

KillWaitEnds ==
    /\ phase = "killWait"
    /\ IF ~Seen
       THEN Finish("killed", FALSE)
       ELSE Finish(IF Variant = "throwOnSurvivor" THEN "throw" ELSE "unconfirmed", KeepOnUnconfirmed)
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, unprovedSignalled, begunUnproved, shown, basis, listFailed>>

CallerAborts ==
    /\ phase \in {"termWait", "killWait"}
    /\ \/ /\ ~Seen
          /\ Finish(IF phase = "termWait" THEN "terminated" ELSE "killed", FALSE)
       \/ Finish("unconfirmed", KeepOnUnconfirmed)
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, unprovedSignalled, begunUnproved, shown, basis, listFailed>>

Sweep ==
    /\ ~Settle
    /\ phase = "done"
    /\ outcome = "unconfirmed"
    /\ ~OursVisible
    /\ marker = "kept"
    /\ marker' = "none"
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, unprovedSignalled, begunUnproved, shown, basis, listFailed>>

Retry ==
    /\ phase = "done"
    /\ (outcome = "unconfirmed" \/ (Settle /\ ObsHeld))
    /\ marker = "kept"
    /\ attempts < MaxAttempts
    /\ \E e \in Events :
        /\ (Variant = "retryAnyEvent" \/ retried[e] = 0)
        /\ retried' = [retried EXCEPT ![e] = @ + 1]
    /\ attempts' = attempts + 1
    /\ phase' = "idle"
    /\ termSent' = FALSE
    /\ killSent' = FALSE
    /\ outcome' = "none"
    /\ begunUnproved' = FALSE
    /\ hstage' = [m \in Members |-> "idle"]
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, state, other, mode, marker, unprovedSignalled, shown, basis, listFailed>>

Settled ==
    /\ phase = "done"
    /\ UNCHANGED vars

Claimed ==
    /\ shown' = "running"
    /\ basis' = SomeoneRuns
    /\ phase' = "done"
    /\ outcome' = "unconfirmed"

SettleObserve ==
    /\ phase = "settle"
    /\ IF ObsHeld
       THEN /\ phase' = "listing"
            /\ UNCHANGED outcome
       ELSE /\ phase' = "done"
            /\ outcome' = "free"
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed>>

SettleListed ==
    /\ phase = "listing"
    /\ IF Named # {}
       THEN /\ phase' = "idle"
            /\ UNCHANGED <<shown, basis, outcome, listFailed>>
       ELSE IF SettleCurrent
            THEN Claimed
            ELSE /\ phase' = "groupProbe"
                 /\ UNCHANGED <<shown, basis, outcome, listFailed>>
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, marker, unprovedSignalled, begunUnproved, listFailed>>

SettleListFails ==
    /\ phase = "listing"
    /\ listFailed' = TRUE
    /\ IF SettleCurrent
       THEN Claimed
       ELSE /\ phase' = "done"
            /\ outcome' = "unchecked"
            /\ shown' = "unchecked"
            /\ UNCHANGED basis
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, marker, unprovedSignalled, begunUnproved>>

SettleGroup ==
    /\ phase = "groupProbe"
    /\ IF GroupRunnable # {}
       THEN Claimed
       ELSE /\ phase' = "done"
            /\ outcome' = "silent"
            /\ UNCHANGED <<shown, basis, listFailed>>
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, marker, unprovedSignalled, begunUnproved, listFailed>>

JobFinish ==
    /\ phase = "settle"
    /\ IF Named # {}
       THEN /\ phase' = "idle"
            /\ UNCHANGED <<outcome, marker, listFailed>>
       ELSE /\ phase' = "done"
            /\ outcome' = "job"
            /\ marker' = IF JobCurrent THEN "none" ELSE marker
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, unprovedSignalled, begunUnproved, shown, basis, listFailed>>

Recheck ==
    /\ Settle
    /\ phase = "done"
    /\ marker = "kept"
    /\ ~ObsHeld
    /\ marker' = "none"
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, unprovedSignalled, begunUnproved, shown, basis, listFailed>>

GuardCheck ==
    /\ Settle
    /\ phase = "done"
    /\ marker = "kept"
    /\ ObsHeld
    /\ retried["guard"] >= 1
    /\ (GuardCurrent \/ SomeoneRuns)
    /\ shown' = "guard"
    /\ basis' = SomeoneRuns
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, listFailed>>

FinalNotice ==
    /\ Settle
    /\ phase = "done"
    /\ marker = "kept"
    /\ AllEventsSpent
    /\ SomeoneRuns
    /\ shown # "final"
    /\ shown' = "final"
    /\ basis' = SomeoneRuns
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, listFailed>>

ReconcileCall ==
    /\ Settle
    /\ phase = "done"
    /\ Named = {}
    /\ GroupRunnable = {}
    /\ IF ReconcileCurrent
       THEN /\ shown' = "gone"
            /\ basis' = (~ObsHeld /\ ~SomeoneRuns)
       ELSE IF ObsHeld
            THEN /\ shown' = "unchecked"
                 /\ UNCHANGED basis
            ELSE /\ shown' = "gone"
                 /\ basis' = TRUE
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, listFailed>>

Next ==
    \/ Reuse
    \/ \E m \in Members :
        \/ MemberExits(m)
        \/ MemberFinishesExit(m)
        \/ \E n \in Members : Fork(m, n)
        \/ InitReaps(m)
        \/ MemberDies(m)
        \/ ReusePid(m)
    \/ Begin
    \/ TermWaitEnds
    \/ KillWaitEnds
    \/ CallerAborts
    \/ Sweep
    \/ Retry
    \/ Settled
    \/ SettleObserve
    \/ SettleListed
    \/ SettleListFails
    \/ SettleGroup
    \/ JobFinish
    \/ Recheck
    \/ GuardCheck
    \/ FinalNotice
    \/ ReconcileCall

Spec == Init /\ [][Next]_vars

FairSpec ==
    /\ Spec
    /\ WF_vars(SettleObserve)
    /\ WF_vars(SettleListed \/ SettleListFails)
    /\ WF_vars(SettleGroup)
    /\ WF_vars(Begin)
    /\ WF_vars(TermWaitEnds)
    /\ WF_vars(KillWaitEnds)
    /\ WF_vars(Recheck)
    /\ WF_vars(Retry)
    /\ WF_vars(FinalNotice)
    /\ \A m \in Members : WF_vars(MemberFinishesExit(m))

NoThrow == outcome # "throw"

NoSignalToUnprovedGroup == ~unprovedSignalled

OutcomeIsTruthful == (outcome \in {"gone", "terminated", "killed"}) => ~OursVisible

MarkerKeptWhileMembersRemain == marker = "none" => ~OursVisible

RemovalSafe == marker = "none" => ~SomeoneRuns

NoteOnlyWhileRunning == shown \in {"running", "final", "guard"} => basis

NoLongerRunningOnlyWhenClear == shown = "gone" => basis

NoRunningClaimAfterListFailure == listFailed => shown # "running"

OneRetryPerEvent == \A e \in Events : retried[e] <= 1

AtMostFourRetries == attempts <= Cardinality(Events)

ExhaustedIsFinal ==
    [][(AllEventsSpent /\ phase = "done") => (phase' = "done" /\ termSent' = termSent /\ killSent' = killSent /\ hstage' = hstage)]_vars

UnconfirmedOnlyWhileOneCanRun ==
    [][((Begin \/ TermWaitEnds \/ KillWaitEnds) /\ mode = "live" /\ outcome' = "unconfirmed") => GroupRunnable # {}]_vars

UnprovedEndsUnconfirmed == (phase = "done" /\ begunUnproved /\ GroupRunnable # {}) => (outcome = "unconfirmed" /\ marker = "kept")

TeardownOnlyFreed == []((marker = "kept" /\ ~SomeoneRuns) => <>(marker = "none"))

SurvivorReachesNotice == [](SomeoneRuns => <>(shown = "final" \/ ~SomeoneRuns))

=============================================================================
