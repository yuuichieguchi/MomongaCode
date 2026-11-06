--------------------------- MODULE ProcessStop ---------------------------
EXTENDS Naturals

CONSTANTS Members, Variant

ASSUME Variant \in {"decided", "noIdentityCheck", "termToReused", "signalLeaderGoneGroup", "throwOnSurvivor", "dropMarkerOnUnconfirmed", "signalUnprovedHolder"}

MemberStates == {"live", "stuck", "zombie", "gone"}

VARIABLES listed, swapped, state, other, mode, leader, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved

vars == <<listed, swapped, state, other, mode, leader, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved>>

TypeOK ==
    /\ listed \in [Members -> BOOLEAN]
    /\ swapped \in [Members -> BOOLEAN]
    /\ state \in [Members -> MemberStates]
    /\ other \in BOOLEAN
    /\ mode \in {"live", "recorded"}
    /\ leader \in {"alive", "gone"}
    /\ phase \in {"idle", "termWait", "killWait", "done"}
    /\ termSent \in BOOLEAN
    /\ killSent \in BOOLEAN
    /\ outcome \in {"none", "gone", "terminated", "killed", "unconfirmed", "throw"}
    /\ marker \in {"kept", "none"}
    /\ unprovedSignalled \in BOOLEAN
    /\ begunUnproved \in BOOLEAN

Ours == {m \in Members : state[m] # "gone"}

OursVisible == Ours # {}

Init ==
    /\ listed \in [Members -> BOOLEAN]
    /\ swapped = [m \in Members |-> FALSE]
    /\ state \in [Members -> MemberStates]
    /\ mode \in {"live", "recorded"}
    /\ leader \in {"alive", "gone"}
    /\ other \in BOOLEAN
    /\ (other => (mode = "recorded" /\ leader = "gone" /\ {m \in Members : state[m] # "gone"} = {}))
    /\ ((mode = "recorded" /\ leader = "alive") => {m \in Members : state[m] # "gone"} # {})
    /\ (mode = "live" => leader = "alive")
    /\ (mode = "live" => \A m \in Members : ~listed[m])
    /\ phase = "idle"
    /\ termSent = FALSE
    /\ killSent = FALSE
    /\ outcome = "none"
    /\ marker = "kept"
    /\ unprovedSignalled = FALSE
    /\ begunUnproved = FALSE

Seen == IF mode = "live" THEN OursVisible ELSE OursVisible \/ other

Proved == mode = "live" \/ leader = "alive"

GateTerm ==
    CASE Variant \in {"noIdentityCheck", "termToReused"} -> TRUE
      [] Variant = "signalLeaderGoneGroup" -> Proved \/ (OursVisible /\ ~other)
      [] OTHER -> Proved

GateKill ==
    CASE Variant = "noIdentityCheck" -> TRUE
      [] Variant = "signalLeaderGoneGroup" -> Proved \/ (OursVisible /\ ~other)
      [] OTHER -> Proved

KeepOnUnconfirmed == Variant # "dropMarkerOnUnconfirmed"

Reuse ==
    /\ mode = "recorded"
    /\ leader = "gone"
    /\ ~OursVisible
    /\ ~other
    /\ other' = TRUE
    /\ UNCHANGED <<listed, swapped, state, mode, leader, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved>>

LeaderExits ==
    /\ mode = "recorded"
    /\ leader = "alive"
    /\ leader' = "gone"
    /\ UNCHANGED <<listed, swapped, state, other, mode, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved>>

MemberExits(m) ==
    /\ state[m] \in {"live", "stuck"}
    /\ state' = [state EXCEPT ![m] = "zombie"]
    /\ UNCHANGED <<listed, swapped, other, mode, leader, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved>>

InitReaps(m) ==
    /\ state[m] = "zombie"
    /\ state' = [state EXCEPT ![m] = "gone"]
    /\ UNCHANGED <<listed, swapped, other, mode, leader, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved>>

MemberDies(m) ==
    /\ state[m] = "live"
    /\ (termSent \/ killSent)
    /\ state' = [state EXCEPT ![m] = "zombie"]
    /\ UNCHANGED <<listed, swapped, other, mode, leader, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved>>

ReusePid(m) ==
    /\ mode = "recorded"
    /\ state[m] = "gone"
    /\ ~swapped[m]
    /\ swapped' = [swapped EXCEPT ![m] = TRUE]
    /\ UNCHANGED <<listed, state, other, mode, leader, phase, termSent, killSent, outcome, marker, unprovedSignalled, begunUnproved>>

HolderTargetProved(m) == state[m] # "gone" /\ ~swapped[m]

HolderSignalled(m) ==
    IF Variant = "signalUnprovedHolder"
    THEN listed[m] /\ (state[m] # "gone" \/ swapped[m])
    ELSE listed[m] /\ HolderTargetProved(m)

SignalHolder(m) ==
    /\ phase = "done"
    /\ begunUnproved
    /\ HolderSignalled(m)
    /\ state' = [state EXCEPT ![m] = IF state[m] = "live" THEN "zombie" ELSE state[m]]
    /\ unprovedSignalled' = (unprovedSignalled \/ ~HolderTargetProved(m))
    /\ UNCHANGED <<listed, swapped, other, mode, leader, phase, termSent, killSent, outcome, marker, begunUnproved>>

Finish(result, keep) ==
    /\ phase' = "done"
    /\ outcome' = result
    /\ marker' = IF keep THEN "kept" ELSE "none"

Begin ==
    /\ phase = "idle"
    /\ IF ~Seen
       THEN /\ Finish("gone", FALSE)
            /\ UNCHANGED <<listed, swapped, termSent, unprovedSignalled, begunUnproved>>
       ELSE IF ~GateTerm
            THEN /\ Finish("unconfirmed", KeepOnUnconfirmed)
                 /\ begunUnproved' = ~Proved
                 /\ UNCHANGED <<listed, swapped, termSent, unprovedSignalled>>
            ELSE /\ phase' = "termWait"
                 /\ termSent' = TRUE
                 /\ unprovedSignalled' = (unprovedSignalled \/ ~Proved)
                 /\ begunUnproved' = ~Proved
                 /\ UNCHANGED <<listed, swapped, outcome, marker>>
    /\ UNCHANGED <<listed, swapped, state, other, mode, leader, killSent>>

TermWaitEnds ==
    /\ phase = "termWait"
    /\ IF ~Seen
       THEN /\ Finish("terminated", FALSE)
            /\ UNCHANGED <<listed, swapped, killSent, unprovedSignalled>>
       ELSE IF ~GateKill
            THEN /\ Finish("unconfirmed", KeepOnUnconfirmed)
                 /\ UNCHANGED <<listed, swapped, killSent, unprovedSignalled>>
            ELSE /\ phase' = "killWait"
                 /\ killSent' = TRUE
                 /\ unprovedSignalled' = (unprovedSignalled \/ ~Proved)
                 /\ UNCHANGED <<listed, swapped, outcome, marker>>
    /\ UNCHANGED <<listed, swapped, state, other, mode, leader, termSent, begunUnproved>>

KillWaitEnds ==
    /\ phase = "killWait"
    /\ IF ~Seen
       THEN Finish("killed", FALSE)
       ELSE Finish(IF Variant = "throwOnSurvivor" THEN "throw" ELSE "unconfirmed", KeepOnUnconfirmed)
    /\ UNCHANGED <<listed, swapped, state, other, mode, leader, termSent, killSent, unprovedSignalled, begunUnproved>>

CallerAborts ==
    /\ phase \in {"termWait", "killWait"}
    /\ IF ~Seen
       THEN Finish(IF phase = "termWait" THEN "terminated" ELSE "killed", FALSE)
       ELSE Finish("unconfirmed", KeepOnUnconfirmed)
    /\ UNCHANGED <<listed, swapped, state, other, mode, leader, termSent, killSent, unprovedSignalled, begunUnproved>>

Sweep ==
    /\ phase = "done"
    /\ outcome = "unconfirmed"
    /\ ~OursVisible
    /\ marker = "kept"
    /\ marker' = "none"
    /\ UNCHANGED <<listed, swapped, state, other, mode, leader, phase, termSent, killSent, outcome, unprovedSignalled, begunUnproved>>

Settled ==
    /\ phase = "done"
    /\ UNCHANGED vars

Next ==
    \/ Reuse
    \/ LeaderExits
    \/ \E m \in Members :
        \/ MemberExits(m)
        \/ InitReaps(m)
        \/ MemberDies(m)
        \/ ReusePid(m)
        \/ SignalHolder(m)
    \/ Begin
    \/ TermWaitEnds
    \/ KillWaitEnds
    \/ CallerAborts
    \/ Sweep
    \/ Settled

Spec == Init /\ [][Next]_vars

NoThrow == outcome # "throw"

NoSignalToUnprovedGroup == ~unprovedSignalled

OutcomeIsTruthful == (outcome \in {"gone", "terminated", "killed"}) => ~OursVisible

MarkerKeptWhileMembersRemain == marker = "none" => ~OursVisible

LeaderGoneEndsUnconfirmed == (phase = "done" /\ begunUnproved) => (outcome = "unconfirmed" /\ (marker = "kept" \/ ~OursVisible))

=============================================================================
