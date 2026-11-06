--------------------------- MODULE ProcessStop ---------------------------
EXTENDS Naturals

CONSTANTS Members, Variant

ASSUME Variant \in {"decided", "noIdentityCheck", "throwOnSurvivor", "dropMarkerOnUnconfirmed"}

MemberStates == {"live", "stuck", "zombie", "gone"}

VARIABLES state, other, phase, termSent, killSent, outcome, marker, otherKilled

vars == <<state, other, phase, termSent, killSent, outcome, marker, otherKilled>>

TypeOK ==
    /\ state \in [Members -> MemberStates]
    /\ other \in BOOLEAN
    /\ phase \in {"idle", "termWait", "killWait", "done"}
    /\ termSent \in BOOLEAN
    /\ killSent \in BOOLEAN
    /\ outcome \in {"none", "gone", "terminated", "killed", "unconfirmed", "throw"}
    /\ marker \in {"kept", "none"}
    /\ otherKilled \in BOOLEAN

Ours == {m \in Members : state[m] # "gone"}

OursVisible == Ours # {}

Init ==
    /\ state \in [Members -> MemberStates]
    /\ other \in BOOLEAN
    /\ ({m \in Members : state[m] # "gone"} = {} \/ ~other)
    /\ phase = "idle"
    /\ termSent = FALSE
    /\ killSent = FALSE
    /\ outcome = "none"
    /\ marker = "kept"
    /\ otherKilled = FALSE

Seen == IF Variant = "noIdentityCheck" THEN OursVisible \/ other ELSE OursVisible

Reuse ==
    /\ ~OursVisible
    /\ ~other
    /\ other' = TRUE
    /\ UNCHANGED <<state, phase, termSent, killSent, outcome, marker, otherKilled>>

MemberExits(m) ==
    /\ state[m] \in {"live", "stuck"}
    /\ state' = [state EXCEPT ![m] = "zombie"]
    /\ UNCHANGED <<other, phase, termSent, killSent, outcome, marker, otherKilled>>

InitReaps(m) ==
    /\ state[m] = "zombie"
    /\ state' = [state EXCEPT ![m] = "gone"]
    /\ UNCHANGED <<other, phase, termSent, killSent, outcome, marker, otherKilled>>

MemberDies(m) ==
    /\ state[m] = "live"
    /\ (termSent \/ killSent)
    /\ state' = [state EXCEPT ![m] = "zombie"]
    /\ UNCHANGED <<other, phase, termSent, killSent, outcome, marker, otherKilled>>

Finish(result, keep) ==
    /\ phase' = "done"
    /\ outcome' = result
    /\ marker' = IF keep THEN "kept" ELSE "none"

Begin ==
    /\ phase = "idle"
    /\ IF Seen
       THEN /\ phase' = "termWait"
            /\ termSent' = TRUE
            /\ UNCHANGED <<outcome, marker>>
       ELSE /\ Finish("gone", FALSE)
            /\ UNCHANGED termSent
    /\ UNCHANGED <<state, other, killSent, otherKilled>>

TermWaitEnds ==
    /\ phase = "termWait"
    /\ IF ~Seen
       THEN /\ Finish("terminated", FALSE)
            /\ UNCHANGED killSent
       ELSE /\ phase' = "killWait"
            /\ killSent' = TRUE
            /\ UNCHANGED <<outcome, marker>>
    /\ otherKilled' = (otherKilled \/ (Seen /\ other /\ ~OursVisible))
    /\ UNCHANGED <<state, other, termSent>>

KillWaitEnds ==
    /\ phase = "killWait"
    /\ IF ~Seen
       THEN Finish("killed", FALSE)
       ELSE Finish(IF Variant = "throwOnSurvivor" THEN "throw" ELSE "unconfirmed", Variant # "dropMarkerOnUnconfirmed")
    /\ UNCHANGED <<state, other, termSent, killSent, otherKilled>>

Sweep ==
    /\ phase = "done"
    /\ outcome = "unconfirmed"
    /\ ~OursVisible
    /\ marker = "kept"
    /\ marker' = "none"
    /\ UNCHANGED <<state, other, phase, termSent, killSent, outcome, otherKilled>>

Settled ==
    /\ phase = "done"
    /\ UNCHANGED vars

Next ==
    \/ Reuse
    \/ \E m \in Members :
        \/ MemberExits(m)
        \/ InitReaps(m)
        \/ MemberDies(m)
    \/ Begin
    \/ TermWaitEnds
    \/ KillWaitEnds
    \/ Sweep
    \/ Settled

Spec == Init /\ [][Next]_vars

NoThrow == outcome # "throw"

SigkillOnlyToMatchingGroup == ~otherKilled

OutcomeIsTruthful == (outcome \in {"gone", "terminated", "killed"}) => ~OursVisible

MarkerKeptWhileMembersRemain == marker = "none" => ~OursVisible

=============================================================================
