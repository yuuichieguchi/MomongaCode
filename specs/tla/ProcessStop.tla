--------------------------- MODULE ProcessStop ---------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Members, Events, MaxAttempts, Variant, StopScope, Gen2Members, CrossGen

ASSUME Variant \in {"decided", "retireSignalsOther", "proofWithoutGen", "noIdentityCheck", "termToReused", "signalUnlistedGroup", "throwOnSurvivor", "dropMarkerOnUnconfirmed", "signalUnprovedHolder", "killWithoutReproof", "retryReusesProof", "retryAnyEvent", "rowlessIsOutside", "groupProofWithoutStartTime", "exitingCountsAlive", "forkFromExiting", "settleCandidate", "settleCurrent", "guardCurrent", "jobCurrent", "reconcileCurrent", "guardUnknownCurrent", "guardHeldCurrent", "sameSecondWithoutHold"}
ASSUME MaxAttempts \in Nat \ {0}
ASSUME StopScope \in {"userStop", "retire"}
ASSUME Gen2Members \subseteq Members
ASSUME CrossGen \in BOOLEAN
ASSUME Events # {}

MemberStates == {"live", "stuck", "exiting", "zombie", "gone"}

Settle == Variant \in {"settleCandidate", "settleCurrent", "guardCurrent", "guardUnknownCurrent", "guardHeldCurrent", "jobCurrent", "reconcileCurrent"}
SettleCurrent == Variant = "settleCurrent"
GuardCurrent == Variant = "guardCurrent"
GuardUnknownCurrent == Variant = "guardUnknownCurrent"
GuardHeldCurrent == Variant = "guardHeldCurrent"
JobCurrent == Variant = "jobCurrent"
ReconcileCurrent == Variant = "reconcileCurrent"

VARIABLES inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown, crossGen, held

vars == <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown, crossGen, held>>

GenOfMember(m) == IF m \in Gen2Members THEN 2 ELSE 1
OtherGen(m) == GenOfMember(m) # 1 \/ crossGen[m]
InScope(m) == StopScope = "userStop" \/ GenOfMember(m) = 1

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
    /\ groupKnown \in BOOLEAN
    /\ crossGen \in [Members -> BOOLEAN]
    /\ held \in [Members -> BOOLEAN]

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

Pos == (Named # {}) \/ (groupKnown /\ GroupRunnable # {})

RefusalDue == IF GuardCurrent THEN ObsHeld ELSE IF GuardHeldCurrent THEN (ObsHeld /\ AllEventsSpent) ELSE (Pos \/ (GuardUnknownCurrent /\ ObsHeld /\ ~groupKnown))

RefusedPossible == \E m \in Members : Holding(m) /\ ~listed[m]

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
    /\ groupKnown \in BOOLEAN
    /\ (~Settle => groupKnown)
    /\ crossGen = [m \in Members |-> FALSE]
    /\ held = listed

GroupSeen == IF mode = "live" THEN GroupAlive ELSE GroupAlive \/ other

Seen == GroupSeen \/ \E m \in Members : HolderVisible(m)

ListedHolderInGroup == \E m \in Members : listed[m] /\ inGroup[m] /\ state[m] # "gone" /\ held[m]

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
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

MemberExits(m) ==
    /\ state[m] \in {"live", "stuck"}
    /\ state' = [state EXCEPT ![m] = "exiting"]
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

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
    /\ held' = [held EXCEPT ![n] = held[m]]
    /\ UNCHANGED <<crossGen, inGroup, swapped, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

MemberFinishesExit(m) ==
    /\ state[m] = "exiting"
    /\ state' = [state EXCEPT ![m] = "zombie"]
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

InitReaps(m) ==
    /\ state[m] = "zombie"
    /\ state' = [state EXCEPT ![m] = "gone"]
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

MemberDies(m) ==
    /\ state[m] = "live"
    /\ inGroup[m]
    /\ (termSent \/ killSent)
    /\ state' = [state EXCEPT ![m] = "exiting"]
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

ReusePid(m) ==
    /\ mode = "recorded"
    /\ state[m] = "gone"
    /\ ~swapped[m]
    /\ swapped' = [swapped EXCEPT ![m] = TRUE]
    /\ held' = [held EXCEPT ![m] = FALSE]
    /\ UNCHANGED <<crossGen, inGroup, listed, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

HolderTargetProved(m) == state[m] # "gone" /\ ~swapped[m] /\ (held[m] \/ (Variant = "proofWithoutGen" /\ crossGen[m]) \/ Variant = "sameSecondWithoutHold")

SignalHits(m) == state[m] # "gone" \/ swapped[m]

TermAllowed(m) ==
    CASE Variant = "signalUnprovedHolder" -> listed[m] /\ SignalHits(m)
      [] Variant = "retryReusesProof" -> listed[m] /\ SignalHits(m) /\ (HolderTargetProved(m) \/ (provedOnce[m] /\ attempts > 0))
      [] Variant = "rowlessIsOutside" -> listed[m] /\ (HolderTargetProved(m) \/ Rowless(m))
      [] OTHER -> listed[m] /\ HolderTargetProved(m)

KillAllowed(m) ==
    IF Variant = "killWithoutReproof" THEN listed[m] /\ SignalHits(m) ELSE TermAllowed(m)

SigT(m) == m \in Outside /\ TermAllowed(m) /\ (Variant = "retireSignalsOther" \/ InScope(m))

SigK(m) == m \in Outside /\ hstage[m] = "term" /\ KillAllowed(m) /\ (Variant = "retireSignalsOther" \/ InScope(m))

Finish(result, keep) ==
    /\ phase' = "done"
    /\ outcome' = result
    /\ marker' = IF Settle \/ keep THEN "kept" ELSE "none"

GroupScopeOK == StopScope = "userStop" \/ Variant = "retireSignalsOther" \/ ~(\E m \in Members : inGroup[m] /\ state[m] # "gone" /\ GenOfMember(m) # 1)

GroupTermGo == groupKnown /\ GroupSeen /\ GateTerm /\ GroupScopeOK

GroupKillGo == groupKnown /\ GroupSeen /\ GateKill /\ GroupScopeOK

Begin ==
    /\ phase = "idle"
    /\ IF ~Seen
       THEN /\ Finish("gone", FALSE)
            /\ UNCHANGED <<crossGen, held, termSent, unprovedSignalled, begunUnproved, state, hstage, provedOnce, listFailed, groupKnown>>
       ELSE IF ~(GroupTermGo \/ \E m \in Members : SigT(m))
            THEN /\ Finish("unconfirmed", KeepOnUnconfirmed)
                 /\ begunUnproved' = (GroupSeen /\ ~Proved)
                 /\ UNCHANGED <<crossGen, held, termSent, unprovedSignalled, state, hstage, provedOnce, listFailed, groupKnown>>
            ELSE /\ phase' = "termWait"
                 /\ termSent' = GroupTermGo
                 /\ unprovedSignalled' = (unprovedSignalled \/ (GroupTermGo /\ ~Proved) \/ \E m \in Members : SigT(m) /\ ~HolderTargetProved(m))
                 /\ begunUnproved' = (GroupSeen /\ ~Proved)
                 /\ hstage' = [m \in Members |-> IF SigT(m) THEN "term" ELSE "idle"]
                 /\ provedOnce' = [m \in Members |-> provedOnce[m] \/ (SigT(m) /\ HolderTargetProved(m))]
                 /\ \E dies \in SUBSET Members : state' = [m \in Members |-> IF SigT(m) /\ state[m] = "live" /\ m \in dies THEN "exiting" ELSE state[m]]
                 /\ UNCHANGED <<crossGen, held, outcome, marker, listFailed, groupKnown>>
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, attempts, retried, other, mode, killSent, shown, basis, listFailed, groupKnown>>

TermWaitEnds ==
    /\ phase = "termWait"
    /\ IF ~Seen
       THEN /\ Finish("terminated", FALSE)
            /\ UNCHANGED <<crossGen, held, killSent, unprovedSignalled, state, hstage, listFailed, groupKnown>>
       ELSE IF ~(GroupKillGo \/ \E m \in Members : SigK(m))
            THEN /\ Finish("unconfirmed", KeepOnUnconfirmed)
                 /\ UNCHANGED <<crossGen, held, killSent, unprovedSignalled, state, hstage, listFailed, groupKnown>>
            ELSE /\ phase' = "killWait"
                 /\ killSent' = GroupKillGo
                 /\ unprovedSignalled' = (unprovedSignalled \/ (GroupKillGo /\ ~Proved) \/ \E m \in Members : SigK(m) /\ ~HolderTargetProved(m))
                 /\ hstage' = [m \in Members |-> IF SigK(m) THEN "kill" ELSE hstage[m]]
                 /\ state' = [m \in Members |-> IF SigK(m) /\ state[m] = "live" THEN "exiting" ELSE state[m]]
                 /\ UNCHANGED <<crossGen, held, outcome, marker, listFailed, groupKnown>>
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, attempts, retried, other, mode, termSent, begunUnproved, shown, basis, listFailed, groupKnown>>

KillWaitEnds ==
    /\ phase = "killWait"
    /\ IF ~Seen
       THEN Finish("killed", FALSE)
       ELSE Finish(IF Variant = "throwOnSurvivor" THEN "throw" ELSE "unconfirmed", KeepOnUnconfirmed)
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

CallerAborts ==
    /\ phase \in {"termWait", "killWait"}
    /\ \/ /\ ~Seen
          /\ Finish(IF phase = "termWait" THEN "terminated" ELSE "killed", FALSE)
       \/ Finish("unconfirmed", KeepOnUnconfirmed)
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

Sweep ==
    /\ ~Settle
    /\ phase = "done"
    /\ outcome = "unconfirmed"
    /\ ~OursVisible
    /\ marker = "kept"
    /\ marker' = "none"
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

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
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, state, other, mode, marker, unprovedSignalled, shown, basis, listFailed, groupKnown>>

ReuseSameSecond(m) ==
    /\ CrossGen
    /\ phase \in {"idle", "termWait", "killWait"}
    /\ state[m] = "gone"
    /\ ~swapped[m]
    /\ ~crossGen[m]
    /\ GenOfMember(m) = 1
    /\ crossGen' = [crossGen EXCEPT ![m] = TRUE]
    /\ state' = [state EXCEPT ![m] = "live"]
    /\ inGroup' = [inGroup EXCEPT ![m] = FALSE]
    /\ held' = [held EXCEPT ![m] = FALSE]
    /\ UNCHANGED <<listed, swapped, provedOnce, hstage, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

Unhold(m) ==
    /\ state[m] \in {"live", "stuck"}
    /\ held[m]
    /\ held' = [held EXCEPT ![m] = FALSE]
    /\ UNCHANGED <<crossGen, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

ReuseSameSecondOwn(m) ==
    /\ CrossGen
    /\ phase \in {"idle", "termWait", "killWait"}
    /\ state[m] = "gone"
    /\ ~swapped[m]
    /\ state' = [state EXCEPT ![m] = "live"]
    /\ inGroup' = [inGroup EXCEPT ![m] = FALSE]
    /\ held' = [held EXCEPT ![m] = FALSE]
    /\ UNCHANGED <<crossGen, listed, swapped, provedOnce, hstage, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

Settled ==
    /\ phase = "done"
    /\ UNCHANGED vars

Claimed ==
    /\ shown' = "running"
    /\ basis' = Pos
    /\ phase' = "done"
    /\ outcome' = "unconfirmed"

SettleObserve ==
    /\ phase = "settle"
    /\ IF ObsHeld
       THEN /\ phase' = "listing"
            /\ UNCHANGED outcome
       ELSE /\ phase' = "done"
            /\ outcome' = "free"
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, marker, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

SettleListed ==
    /\ phase = "listing"
    /\ IF Named # {}
       THEN /\ phase' = "idle"
            /\ UNCHANGED <<crossGen, held, shown, basis, outcome, listFailed, groupKnown>>
       ELSE IF SettleCurrent
            THEN Claimed
            ELSE /\ phase' = "groupProbe"
                 /\ UNCHANGED <<crossGen, held, shown, basis, outcome, listFailed, groupKnown>>
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, marker, unprovedSignalled, begunUnproved, listFailed, groupKnown>>

SettleListFails ==
    /\ phase = "listing"
    /\ listFailed' = TRUE
    /\ IF SettleCurrent
       THEN Claimed
       ELSE /\ phase' = "done"
            /\ outcome' = "unchecked"
            /\ shown' = "unchecked"
            /\ UNCHANGED basis
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, marker, unprovedSignalled, begunUnproved, groupKnown>>

SettleGroup ==
    /\ phase = "groupProbe"
    /\ IF groupKnown /\ GroupRunnable # {}
       THEN Claimed
       ELSE /\ phase' = "done"
            /\ outcome' = IF groupKnown THEN "silent" ELSE "unchecked"
            /\ shown' = IF groupKnown THEN shown ELSE "unchecked"
            /\ UNCHANGED basis
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, marker, unprovedSignalled, begunUnproved, groupKnown, listFailed>>

JobFinish ==
    /\ phase = "settle"
    /\ IF Named # {}
       THEN /\ phase' = "idle"
            /\ UNCHANGED <<crossGen, held, outcome, marker, listFailed, groupKnown>>
       ELSE /\ phase' = "done"
            /\ outcome' = "job"
            /\ marker' = IF JobCurrent THEN "none" ELSE marker
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

Recheck ==
    /\ Settle
    /\ phase = "done"
    /\ marker = "kept"
    /\ ~ObsHeld
    /\ marker' = "none"
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, unprovedSignalled, begunUnproved, shown, basis, listFailed, groupKnown>>

SettleUnreadable ==
    /\ phase = "settle"
    /\ phase' = "done"
    /\ outcome' = "unchecked"
    /\ shown' = "unchecked"
    /\ UNCHANGED <<crossGen, held, basis, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, marker, unprovedSignalled, begunUnproved, groupKnown, listFailed>>

SettleListRefused ==
    /\ phase = "listing"
    /\ \E m \in Members : Holding(m) /\ ~listed[m]
    /\ IF Named # {}
       THEN /\ phase' = "idle"
            /\ UNCHANGED <<crossGen, held, shown, basis, outcome, groupKnown>>
       ELSE IF SettleCurrent \/ (groupKnown /\ GroupRunnable # {})
            THEN Claimed
            ELSE /\ phase' = "done"
                 /\ outcome' = "unchecked"
                 /\ shown' = "unchecked"
                 /\ UNCHANGED basis
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, marker, unprovedSignalled, begunUnproved, groupKnown, listFailed>>

GuardRefuse ==
    /\ Settle
    /\ phase = "done"
    /\ marker = "kept"
    /\ retried["guard"] >= 1
    /\ RefusalDue
    /\ shown' = "guard"
    /\ basis' = Pos
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, groupKnown, listFailed>>

GuardUnreadable ==
    /\ Settle
    /\ phase = "done"
    /\ marker = "kept"
    /\ retried["guard"] >= 1
    /\ IF GuardCurrent \/ GuardUnknownCurrent
       THEN /\ shown' = "guard"
            /\ basis' = Pos
       ELSE /\ shown' = "unchecked"
            /\ UNCHANGED basis
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, groupKnown, listFailed>>

GuardUnchecked ==
    /\ Settle
    /\ phase = "done"
    /\ marker = "kept"
    /\ retried["guard"] >= 1
    /\ ObsHeld
    /\ ~RefusalDue
    /\ (~groupKnown \/ RefusedPossible)
    /\ shown' = "unchecked"
    /\ UNCHANGED <<crossGen, held, basis, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, groupKnown, listFailed>>

FinalNotice ==
    /\ Settle
    /\ phase = "done"
    /\ marker = "kept"
    /\ AllEventsSpent
    /\ (Pos \/ ObsHeld)
    /\ shown # "final"
    /\ shown' = "final"
    /\ basis' = (Pos \/ ObsHeld)
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, groupKnown, listFailed>>

ReconcileCall ==
    /\ Settle
    /\ phase = "done"
    /\ Named = {}
    /\ GroupRunnable = {}
    /\ IF ReconcileCurrent
       THEN /\ shown' = "gone"
            /\ basis' = (~ObsHeld /\ ~SomeoneRuns)
       ELSE IF groupKnown /\ ~ObsHeld
            THEN /\ shown' = "gone"
                 /\ basis' = TRUE
            ELSE /\ shown' = "unchecked"
                 /\ UNCHANGED basis
    /\ UNCHANGED <<crossGen, held, inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved, groupKnown, listFailed>>

Next ==
    \/ Reuse
    \/ \E m \in Members :
        \/ MemberExits(m)
        \/ MemberFinishesExit(m)
        \/ \E n \in Members : Fork(m, n)
        \/ InitReaps(m)
        \/ MemberDies(m)
        \/ ReusePid(m)
        \/ ReuseSameSecond(m)
        \/ ReuseSameSecondOwn(m)
        \/ Unhold(m)
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
    \/ SettleUnreadable
    \/ SettleListRefused
    \/ GuardRefuse
    \/ GuardUnreadable
    \/ GuardUnchecked
    \/ FinalNotice
    \/ ReconcileCall

Spec == Init /\ [][Next]_vars

StopNeverSignalsOtherGen == [][~(StopScope = "retire" /\ \E m \in Members : hstage'[m] # hstage[m] /\ hstage'[m] # "idle" /\ OtherGen(m))]_vars

NoSignalToNonHolder == [][~(\E m \in Members : hstage'[m] # hstage[m] /\ hstage'[m] # "idle" /\ ~held[m])]_vars

FairSpec ==
    /\ Spec
    /\ WF_vars(SettleObserve)
    /\ WF_vars(SettleListed \/ SettleListFails \/ SettleListRefused)
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

RefuseOnlyOnPositiveEvidence == shown \in {"running", "guard"} => basis

FinalNoticeOnlyWhenHeldOrPositive == shown = "final" => basis

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
