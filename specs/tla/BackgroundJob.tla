----------------------------- MODULE BackgroundJob -----------------------------
EXTENDS Naturals

CONSTANTS Jobs, MaxCrash, RegisterLate

ASSUME RegisterLate \in BOOLEAN
ASSUME MaxCrash \in Nat

StarterPhases == {"idle", "rowed", "spawned", "attached", "live", "ended", "failed", "attachFailed"}
RowStates == {"none", "running", "exited", "unknown"}
ProcStates == {"none", "alive", "exited", "killed"}

VARIABLES st, row, owned, proc, marker, ownerUp, crashes

vars == <<st, row, owned, proc, marker, ownerUp, crashes>>

Init ==
    /\ st = [j \in Jobs |-> "idle"]
    /\ row = [j \in Jobs |-> "none"]
    /\ owned = [j \in Jobs |-> FALSE]
    /\ proc = [j \in Jobs |-> "none"]
    /\ marker = [j \in Jobs |-> FALSE]
    /\ ownerUp = TRUE
    /\ crashes = 0

Set(f, k, v) == [f EXCEPT ![k] = v]

WriteRow(j) ==
    /\ ownerUp /\ st[j] = "idle"
    /\ st' = Set(st, j, "rowed")
    /\ row' = Set(row, j, "running")
    /\ owned' = IF RegisterLate THEN owned ELSE Set(owned, j, TRUE)
    /\ UNCHANGED <<proc, marker, ownerUp, crashes>>

Spawn(j) ==
    /\ ownerUp /\ st[j] = "rowed"
    /\ st' = Set(st, j, "spawned")
    /\ marker' = Set(marker, j, TRUE)
    /\ proc' = Set(proc, j, "alive")
    /\ UNCHANGED <<row, owned, ownerUp, crashes>>

SpawnFails(j) ==
    /\ ownerUp /\ st[j] = "rowed"
    /\ st' = Set(st, j, "failed")
    /\ owned' = Set(owned, j, FALSE)
    /\ row' = IF row[j] = "running" THEN Set(row, j, "unknown") ELSE row
    /\ UNCHANGED <<proc, marker, ownerUp, crashes>>

Attach(j) ==
    /\ ownerUp /\ st[j] = "spawned"
    /\ st' = Set(st, j, IF row[j] = "running" THEN "attached" ELSE "attachFailed")
    /\ UNCHANGED <<row, owned, proc, marker, ownerUp, crashes>>

Register(j) ==
    /\ ownerUp /\ st[j] = "attached"
    /\ st' = Set(st, j, "live")
    /\ owned' = Set(owned, j, TRUE)
    /\ UNCHANGED <<row, proc, marker, ownerUp, crashes>>

Exit(j) ==
    /\ proc[j] = "alive"
    /\ proc' = Set(proc, j, "exited")
    /\ UNCHANGED <<st, row, owned, marker, ownerUp, crashes>>

Finalize(j) ==
    /\ ownerUp /\ st[j] = "live" /\ proc[j] # "alive"
    /\ st' = Set(st, j, "ended")
    /\ row' = IF row[j] = "running" THEN Set(row, j, "exited") ELSE row
    /\ owned' = Set(owned, j, FALSE)
    /\ marker' = Set(marker, j, FALSE)
    /\ UNCHANGED <<proc, ownerUp, crashes>>

OwnerKnownAlive(j) == IF ownerUp THEN owned[j] ELSE FALSE

Reconcile(j) ==
    /\ row[j] = "running" /\ ~OwnerKnownAlive(j)
    /\ row' = Set(row, j, "unknown")
    /\ proc' = IF marker[j] /\ proc[j] = "alive" THEN Set(proc, j, "killed") ELSE proc
    /\ marker' = Set(marker, j, FALSE)
    /\ UNCHANGED <<st, owned, ownerUp, crashes>>

MarkerSweep(j) ==
    /\ ~ownerUp /\ marker[j]
    /\ marker' = Set(marker, j, FALSE)
    /\ proc' = IF proc[j] = "alive" THEN Set(proc, j, "killed") ELSE proc
    /\ UNCHANGED <<st, row, owned, ownerUp, crashes>>

Crash ==
    /\ ownerUp /\ crashes < MaxCrash
    /\ ownerUp' = FALSE
    /\ crashes' = crashes + 1
    /\ owned' = [j \in Jobs |-> FALSE]
    /\ UNCHANGED <<st, row, proc, marker>>

Settled == \A j \in Jobs : row[j] # "running" /\ proc[j] # "alive" /\ ~marker[j]

Done == Settled /\ UNCHANGED vars

Next ==
    \/ \E j \in Jobs : WriteRow(j) \/ Spawn(j) \/ SpawnFails(j) \/ Attach(j) \/ Register(j) \/ Exit(j) \/ Finalize(j) \/ Reconcile(j) \/ MarkerSweep(j)
    \/ Crash
    \/ Done

Fairness ==
    \A j \in Jobs : WF_vars(Spawn(j)) /\ WF_vars(Attach(j)) /\ WF_vars(Register(j)) /\ WF_vars(Exit(j))
                    /\ WF_vars(Finalize(j)) /\ WF_vars(Reconcile(j)) /\ WF_vars(MarkerSweep(j))

Spec == Init /\ [][Next]_vars /\ Fairness

TypeOK ==
    /\ \A j \in Jobs : st[j] \in StarterPhases /\ row[j] \in RowStates /\ proc[j] \in ProcStates
    /\ \A j \in Jobs : owned[j] \in BOOLEAN /\ marker[j] \in BOOLEAN
    /\ ownerUp \in BOOLEAN /\ crashes \in 0..MaxCrash

Starting(j) == st[j] \in {"rowed", "spawned", "attached"}

NoOrphanWhileStarting == \A j \in Jobs : (ownerUp /\ Starting(j)) => row[j] = "running"

NoAttachFailure == \A j \in Jobs : st[j] # "attachFailed"

NoLostProcess == \A j \in Jobs : proc[j] = "alive" => (marker[j] \/ (ownerUp /\ st[j] = "live"))

StartedJobEnds == \A j \in Jobs : st[j] # "idle" ~> (row[j] \in {"exited", "unknown"} /\ proc[j] # "alive")
=============================================================================
