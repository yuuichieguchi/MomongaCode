------------------------- MODULE GroupFollowers -------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Members, Variant

ASSUME Variant \in {"decided", "noReproof"}

VARIABLES world, listed, sent, phase, hitStranger

vars == <<world, listed, sent, phase, hitStranger>>

Slots == {"member", "gone", "stranger"}

TypeOK ==
    /\ world \in [Members -> Slots]
    /\ listed \subseteq Members
    /\ sent \subseteq Members
    /\ phase \in {"start", "send", "done"}
    /\ hitStranger \in BOOLEAN

Init ==
    /\ world \in [Members -> {"member", "gone"}]
    /\ listed = {}
    /\ sent = {}
    /\ phase = "start"
    /\ hitStranger = FALSE

List ==
    /\ phase = "start"
    /\ listed' = {m \in Members : world[m] = "member"}
    /\ phase' = "send"
    /\ UNCHANGED <<world, sent, hitStranger>>

Exit(m) ==
    /\ world[m] = "member"
    /\ world' = [world EXCEPT ![m] = "gone"]
    /\ UNCHANGED <<listed, sent, phase, hitStranger>>

ReusePid(m) ==
    /\ world[m] = "gone"
    /\ world' = [world EXCEPT ![m] = "stranger"]
    /\ UNCHANGED <<listed, sent, phase, hitStranger>>

Reproved(m) == world[m] = "member"

Send(m) ==
    /\ phase = "send"
    /\ m \in listed
    /\ m \notin sent
    /\ (Variant = "noReproof" \/ Reproved(m))
    /\ sent' = sent \cup {m}
    /\ hitStranger' = (hitStranger \/ world[m] = "stranger")
    /\ UNCHANGED <<world, listed, phase>>

Skip(m) ==
    /\ phase = "send"
    /\ m \in listed
    /\ m \notin sent
    /\ Variant = "decided"
    /\ ~Reproved(m)
    /\ sent' = sent \cup {m}
    /\ UNCHANGED <<world, listed, phase, hitStranger>>

Finish ==
    /\ phase = "send"
    /\ sent = listed
    /\ phase' = "done"
    /\ UNCHANGED <<world, listed, sent, hitStranger>>

Settled ==
    /\ phase = "done"
    /\ UNCHANGED vars

Next ==
    \/ Settled
    \/ List
    \/ Finish
    \/ \E m \in Members : Exit(m) \/ ReusePid(m) \/ Send(m) \/ Skip(m)

Spec == Init /\ [][Next]_vars

NoStrangerSignalled == ~hitStranger

=============================================================================
