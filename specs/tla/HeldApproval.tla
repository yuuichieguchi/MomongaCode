----------------------------- MODULE HeldApproval -----------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
    Runs,
    Calls,
    MaxCrashes,
    LateFactsDropped,
    LateNoItem

ASSUME /\ Runs \in Nat /\ Runs >= 1
       /\ MaxCrashes \in Nat
       /\ LateFactsDropped \in BOOLEAN
       /\ LateNoItem \in BOOLEAN

RunIds == 1..Runs

NoCall == "-"

ItemEvents == {"user.message", "model.responded", "tool.completed", "tool.reconciled", "tool.held.resolved"}

ReaderItemEvents == IF LateNoItem THEN ItemEvents \ {"tool.held.resolved"} ELSE ItemEvents

HoldEndingEvents == {"tool.completed", "tool.reconciled", "tool.held.resolved"}

HeldOutcomes == {"executed", "rejected", "withdrawn"}

ReconciledOutcomes == {"already_applied", "not_applied", "unknown"}

MutatingReconciled == {"already_applied", "unknown"}

Verdicts == {"approved", "rejected", "withdrawn"}

VARIABLES j, st, landed, decided, crashes, inherited

vars == <<j, st, landed, decided, crashes, inherited>>

Ev(k, c, o, h) == [k |-> k, c |-> c, o |-> o, h |-> h]

-----------------------------------------------------------------------------

IsMutation(e) ==
    \/ e.k = "tool.completed" /\ e.o = "write"
    \/ e.k = "tool.reconciled" /\ e.o \in MutatingReconciled

MutationsOf(r, c) == {i \in DOMAIN j[r] : j[r][i].c = c /\ IsMutation(j[r][i])}

LastMutationSeq(r) == IF \E i \in DOMAIN j[r] : IsMutation(j[r][i])
                      THEN CHOOSE i \in DOMAIN j[r] : IsMutation(j[r][i]) /\ \A k \in DOMAIN j[r] : IsMutation(j[r][k]) => k <= i
                      ELSE 0

HeldAt(r, c) == CHOOSE i \in DOMAIN j[r] : j[r][i].k = "tool.held" /\ j[r][i].c = c

FoldItems(r) == Cardinality({i \in DOMAIN j[r] : j[r][i].k \in ItemEvents})

ReaderItems(r) == Cardinality({i \in DOMAIN j[r] : j[r][i].k \in ReaderItemEvents})

LateResults(r, c) == Cardinality({i \in DOMAIN j[r] : j[r][i].c = c /\ j[r][i].h /\ j[r][i].k \in ItemEvents})

Active(r) == st[r] = "running"

-----------------------------------------------------------------------------

Init ==
    /\ j = [r \in RunIds |-> <<Ev("user.message", NoCall, "-", FALSE)>>]
    /\ st = [r \in RunIds |-> IF r = 1 THEN "running" ELSE "queued"]
    /\ landed = [r \in RunIds |-> {}]
    /\ decided = [r \in RunIds |-> [c \in Calls |-> "none"]]
    /\ crashes = 0
    /\ inherited = [r \in RunIds |-> 0]

Hold(r, c) ==
    /\ Active(r)
    /\ decided[r][c] = "none"
    /\ j' = [j EXCEPT ![r] = @ \o <<Ev("model.responded", c, "-", FALSE), Ev("tool.held", c, "-", FALSE)>>]
    /\ decided' = [decided EXCEPT ![r][c] = "waiting"]
    /\ UNCHANGED <<st, landed, crashes, inherited>>

Resolve(r, c, v) ==
    /\ decided[r][c] = "waiting"
    /\ decided' = [decided EXCEPT ![r][c] = v]
    /\ UNCHANGED <<j, st, landed, crashes, inherited>>

LateStart(r, c) ==
    /\ Active(r)
    /\ decided[r][c] = "approved"
    /\ ~LateFactsDropped
    /\ j' = [j EXCEPT ![r] = Append(@, Ev("tool.started", c, "-", TRUE))]
    /\ decided' = [decided EXCEPT ![r][c] = "started"]
    /\ UNCHANGED <<st, landed, crashes, inherited>>

LateLand(r, c) ==
    /\ Active(r)
    /\ decided[r][c] = "started"
    /\ c \notin landed[r]
    /\ landed' = [landed EXCEPT ![r] = @ \cup {c}]
    /\ UNCHANGED <<j, st, decided, crashes, inherited>>

LateComplete(r, c) ==
    /\ Active(r)
    /\ decided[r][c] = "started"
    /\ c \in landed[r]
    /\ j' = [j EXCEPT ![r] = Append(@, Ev("tool.completed", c, "write", TRUE))]
    /\ decided' = [decided EXCEPT ![r][c] = "done"]
    /\ UNCHANGED <<st, landed, crashes, inherited>>

LateRunDropped(r, c) ==
    /\ Active(r)
    /\ decided[r][c] = "approved"
    /\ LateFactsDropped
    /\ landed' = [landed EXCEPT ![r] = @ \cup {c}]
    /\ j' = [j EXCEPT ![r] = Append(@, Ev("tool.held.resolved", c, "executed", FALSE))]
    /\ decided' = [decided EXCEPT ![r][c] = "done"]
    /\ UNCHANGED <<st, crashes, inherited>>

Close(r, c) ==
    /\ Active(r)
    /\ decided[r][c] \in {"rejected", "withdrawn"}
    /\ j' = [j EXCEPT ![r] = Append(@, Ev("tool.held.resolved", c, decided[r][c], FALSE))]
    /\ decided' = [decided EXCEPT ![r][c] = "done"]
    /\ UNCHANGED <<st, landed, crashes, inherited>>

Crash(r) ==
    /\ Active(r)
    /\ crashes < MaxCrashes
    /\ \E c \in Calls : decided[r][c] = "started"
    /\ crashes' = crashes + 1
    /\ decided' = [decided EXCEPT ![r] = [c \in Calls |-> IF @[c] = "started" THEN "interrupted" ELSE @[c]]]
    /\ UNCHANGED <<j, st, landed, inherited>>

Reconcile(r, c) ==
    /\ Active(r)
    /\ decided[r][c] = "interrupted"
    /\ \E o \in ReconciledOutcomes :
        /\ (o = "already_applied" => c \in landed[r])
        /\ (o = "not_applied" => c \notin landed[r])
        /\ j' = [j EXCEPT ![r] = Append(@, IF LateFactsDropped
                                              THEN Ev("tool.held.resolved", c, "executed", FALSE)
                                              ELSE Ev("tool.reconciled", c, o, TRUE))]
        /\ decided' = [decided EXCEPT ![r][c] = IF o = "unknown" THEN "unknown" ELSE "done"]
    /\ UNCHANGED <<st, landed, crashes, inherited>>

Ask(r, c) ==
    /\ decided[r][c] = "unknown"
    /\ \E i \in DOMAIN j[r] : j[r][i].k = "tool.reconciled" /\ j[r][i].c = c /\ j[r][i].o = "unknown"
    /\ j' = [j EXCEPT ![r] = Append(@, Ev("unknown_effect.asked", c, "-", FALSE))]
    /\ decided' = [decided EXCEPT ![r][c] = "done"]
    /\ UNCHANGED <<st, landed, crashes, inherited>>

Finish(r) ==
    /\ Active(r)
    /\ \A c \in Calls : decided[r][c] \in {"none", "done"}
    /\ st' = [st EXCEPT ![r] = "terminal"]
    /\ UNCHANGED <<j, landed, decided, crashes, inherited>>

Inherit(r) ==
    /\ st[r] = "queued"
    /\ st[r - 1] = "terminal"
    /\ inherited' = [inherited EXCEPT ![r] = inherited[r - 1] + ReaderItems(r - 1)]
    /\ st' = [st EXCEPT ![r] = "running"]
    /\ UNCHANGED <<j, landed, decided, crashes>>

Terminated == \A r \in RunIds : st[r] = "terminal" /\ UNCHANGED vars

Next ==
    \/ \E r \in RunIds, c \in Calls :
        \/ Hold(r, c)
        \/ \E v \in Verdicts : Resolve(r, c, v)
        \/ LateStart(r, c)
        \/ LateLand(r, c)
        \/ LateComplete(r, c)
        \/ LateRunDropped(r, c)
        \/ Close(r, c)
        \/ Reconcile(r, c)
        \/ Ask(r, c)
    \/ \E r \in RunIds : Crash(r) \/ Finish(r)
    \/ \E r \in RunIds \ {1} : Inherit(r)
    \/ Terminated

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------

TypeOK ==
    /\ st \in [RunIds -> {"queued", "running", "terminal"}]
    /\ crashes \in 0..MaxCrashes
    /\ \A r \in RunIds : landed[r] \subseteq Calls

LateResultOnce == \A r \in RunIds, c \in Calls : LateResults(r, c) <= 1

LateMutationCounted ==
    \A r \in RunIds : \A c \in landed[r] :
        decided[r][c] \in {"started", "interrupted"} \/ \E i \in MutationsOf(r, c) : i > HeldAt(r, c)

LateUnknownAsked ==
    \A r \in RunIds : st[r] = "terminal" =>
        \A i \in DOMAIN j[r] : (j[r][i].k = "tool.reconciled" /\ j[r][i].o = "unknown") =>
            \E k \in DOMAIN j[r] : j[r][k].k = "unknown_effect.asked" /\ j[r][k].c = j[r][i].c

HistoryReadsAgree ==
    /\ \A r \in RunIds : ReaderItems(r) = FoldItems(r)
    /\ \A r \in RunIds \ {1} : st[r] # "queued" => inherited[r] = inherited[r - 1] + FoldItems(r - 1)

=============================================================================
