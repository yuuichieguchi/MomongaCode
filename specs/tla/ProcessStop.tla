--------------------------- MODULE ProcessStop ---------------------------
\* Limits the code inherits from the platforms, checked by test/process-stop-conformance.test.ts:
\* - darwin reads a start time with ps -o lstart, whose resolution is one second, so a pid reused within the same second reads the same start time.
\* - Begin and TermWaitEnds prove a target and signal it in one step. The code reads a start time only after holdersOf has listed the pid, so the window between holdersOf and the first startTimeOf cannot be closed where the listing carries no start time.
EXTENDS Naturals, FiniteSets

CONSTANTS Members, Events, MaxAttempts, Variant

ASSUME Variant \in {"decided", "noIdentityCheck", "termToReused", "signalUnlistedGroup", "throwOnSurvivor", "dropMarkerOnUnconfirmed", "signalUnprovedHolder", "killWithoutReproof", "retryReusesProof", "retryAnyEvent", "rowlessIsOutside", "groupProofWithoutStartTime", "exitingCountsAlive"}
ASSUME MaxAttempts \in Nat \ {0}
ASSUME Events # {}

MemberStates == {"live", "stuck", "exiting", "zombie", "gone"}

VARIABLES inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved

vars == <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved>>

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
    /\ phase \in {"idle", "termWait", "killWait", "done"}
    /\ termSent \in BOOLEAN
    /\ killSent \in BOOLEAN
    /\ outcome \in {"none", "gone", "terminated", "killed", "unconfirmed", "throw"}
    /\ marker \in {"kept", "none"}
    /\ unprovedSignalled \in BOOLEAN
    /\ begunUnproved \in BOOLEAN

GroupOurs == {m \in Members : inGroup[m] /\ state[m] # "gone"}

CanStillRun(m) == state[m] \in {"live", "stuck"}

GroupRunnable == {m \in Members : inGroup[m] /\ CanStillRun(m)}

GroupAlive == IF Variant = "exitingCountsAlive" THEN GroupOurs # {} ELSE GroupRunnable # {}

Rowless(m) == state[m] = "gone" /\ ~swapped[m]

Outside == {m \in Members : listed[m] /\ (~inGroup[m] \/ (Variant = "rowlessIsOutside" /\ Rowless(m)))}

HolderVisible(m) == m \in Outside /\ state[m] # "gone"

OursVisible == GroupRunnable # {} \/ \E m \in Members : HolderVisible(m)

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
    /\ \A m \in Members : (~inGroup[m] => listed[m])
    /\ phase = "idle"
    /\ termSent = FALSE
    /\ killSent = FALSE
    /\ outcome = "none"
    /\ marker = "kept"
    /\ unprovedSignalled = FALSE
    /\ begunUnproved = FALSE

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
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved>>

MemberExits(m) ==
    /\ state[m] \in {"live", "stuck"}
    /\ state' = [state EXCEPT ![m] = "exiting"]
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved>>

MemberFinishesExit(m) ==
    /\ state[m] = "exiting"
    /\ state' = [state EXCEPT ![m] = "zombie"]
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved>>

InitReaps(m) ==
    /\ state[m] = "zombie"
    /\ state' = [state EXCEPT ![m] = "gone"]
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved>>

MemberDies(m) ==
    /\ state[m] = "live"
    /\ inGroup[m]
    /\ (termSent \/ killSent)
    /\ state' = [state EXCEPT ![m] = "exiting"]
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved>>

ReusePid(m) ==
    /\ mode = "recorded"
    /\ state[m] = "gone"
    /\ ~swapped[m]
    /\ swapped' = [swapped EXCEPT ![m] = TRUE]
    /\ UNCHANGED <<inGroup, listed, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved>>

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
    /\ marker' = IF keep THEN "kept" ELSE "none"

GroupTermGo == GroupSeen /\ GateTerm

GroupKillGo == GroupSeen /\ GateKill

Begin ==
    /\ phase = "idle"
    /\ IF ~Seen
       THEN /\ Finish("gone", FALSE)
            /\ UNCHANGED <<termSent, unprovedSignalled, begunUnproved, state, hstage, provedOnce>>
       ELSE IF ~(GroupTermGo \/ \E m \in Members : SigT(m))
            THEN /\ Finish("unconfirmed", KeepOnUnconfirmed)
                 /\ begunUnproved' = (GroupSeen /\ ~Proved)
                 /\ UNCHANGED <<termSent, unprovedSignalled, state, hstage, provedOnce>>
            ELSE /\ phase' = "termWait"
                 /\ termSent' = GroupTermGo
                 /\ unprovedSignalled' = (unprovedSignalled \/ (GroupTermGo /\ ~Proved) \/ \E m \in Members : SigT(m) /\ ~HolderTargetProved(m))
                 /\ begunUnproved' = (GroupSeen /\ ~Proved)
                 /\ hstage' = [m \in Members |-> IF SigT(m) THEN "term" ELSE "idle"]
                 /\ provedOnce' = [m \in Members |-> provedOnce[m] \/ (SigT(m) /\ HolderTargetProved(m))]
                 /\ \E dies \in SUBSET Members : state' = [m \in Members |-> IF SigT(m) /\ state[m] = "live" /\ m \in dies THEN "exiting" ELSE state[m]]
                 /\ UNCHANGED <<outcome, marker>>
    /\ UNCHANGED <<inGroup, listed, swapped, attempts, retried, other, mode, killSent>>

TermWaitEnds ==
    /\ phase = "termWait"
    /\ IF ~Seen
       THEN /\ Finish("terminated", FALSE)
            /\ UNCHANGED <<killSent, unprovedSignalled, state, hstage>>
       ELSE IF ~(GroupKillGo \/ \E m \in Members : SigK(m))
            THEN /\ Finish("unconfirmed", KeepOnUnconfirmed)
                 /\ UNCHANGED <<killSent, unprovedSignalled, state, hstage>>
            ELSE /\ phase' = "killWait"
                 /\ killSent' = GroupKillGo
                 /\ unprovedSignalled' = (unprovedSignalled \/ (GroupKillGo /\ ~Proved) \/ \E m \in Members : SigK(m) /\ ~HolderTargetProved(m))
                 /\ hstage' = [m \in Members |-> IF SigK(m) THEN "kill" ELSE hstage[m]]
                 /\ state' = [m \in Members |-> IF SigK(m) /\ state[m] = "live" THEN "exiting" ELSE state[m]]
                 /\ UNCHANGED <<outcome, marker>>
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, attempts, retried, other, mode, termSent, begunUnproved>>

KillWaitEnds ==
    /\ phase = "killWait"
    /\ IF ~Seen
       THEN Finish("killed", FALSE)
       ELSE Finish(IF Variant = "throwOnSurvivor" THEN "throw" ELSE "unconfirmed", KeepOnUnconfirmed)
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, unprovedSignalled, begunUnproved>>

CallerAborts ==
    /\ phase \in {"termWait", "killWait"}
    /\ \/ /\ ~Seen
          /\ Finish(IF phase = "termWait" THEN "terminated" ELSE "killed", FALSE)
       \/ Finish("unconfirmed", KeepOnUnconfirmed)
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, termSent, killSent, unprovedSignalled, begunUnproved>>

Sweep ==
    /\ phase = "done"
    /\ outcome = "unconfirmed"
    /\ ~OursVisible
    /\ marker = "kept"
    /\ marker' = "none"
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, hstage, attempts, retried, state, other, mode, phase, termSent, killSent, outcome, unprovedSignalled, begunUnproved>>

Retry ==
    /\ phase = "done"
    /\ outcome = "unconfirmed"
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
    /\ UNCHANGED <<inGroup, listed, swapped, provedOnce, state, other, mode, marker, unprovedSignalled>>

Settled ==
    /\ phase = "done"
    /\ UNCHANGED vars

Next ==
    \/ Reuse
    \/ \E m \in Members :
        \/ MemberExits(m)
        \/ MemberFinishesExit(m)
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

Spec == Init /\ [][Next]_vars

NoThrow == outcome # "throw"

NoSignalToUnprovedGroup == ~unprovedSignalled

OutcomeIsTruthful == (outcome \in {"gone", "terminated", "killed"}) => ~OursVisible

MarkerKeptWhileMembersRemain == marker = "none" => ~OursVisible

OneRetryPerEvent == \A e \in Events : retried[e] <= 1

AtMostFourRetries == attempts <= Cardinality(Events)

AllEventsSpent == \A e \in Events : retried[e] >= 1

ExhaustedIsFinal ==
    [][(AllEventsSpent /\ phase = "done") => (phase' = "done" /\ termSent' = termSent /\ killSent' = killSent /\ hstage' = hstage)]_vars

UnconfirmedOnlyWhileOneCanRun ==
    [][((Begin \/ TermWaitEnds \/ KillWaitEnds) /\ mode = "live" /\ outcome' = "unconfirmed") => GroupRunnable # {}]_vars

UnprovedEndsUnconfirmed == (phase = "done" /\ begunUnproved /\ GroupRunnable # {}) => (outcome = "unconfirmed" /\ marker = "kept")

=============================================================================
