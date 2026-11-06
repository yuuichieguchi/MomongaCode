--------------------------- MODULE BashExpiry ---------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Calls, Cap, Policy, Promote, Order, Handoff, Wiring, Ending, CapEnforced

ASSUME Policy \in {"background", "kill"}
ASSUME Promote \in {"callTimeout", "anyExpiry"}
ASSUME Order \in {"adoptFirst", "ledgerFirst"}
ASSUME Handoff \in {"released", "twoOwners"}
ASSUME Wiring \in {"rebound", "kept"}
ASSUME Ending \in {"unknown", "completed"}
ASSUME CapEnforced \in BOOLEAN
ASSUME Cap \in Nat \ {0}

None == "none"

VARIABLES phase, down, call, proc, callHolds, jobHolds, wired, adopting, ledger, store, killed, cause

vars == <<phase, down, call, proc, callHolds, jobHolds, wired, adopting, ledger, store, killed, cause>>

TypeOK ==
    /\ phase \in {"run", "crashed", "recovered"}
    /\ down \in BOOLEAN
    /\ call \in [Calls -> {"idle", "running", "finished"}]
    /\ proc \in [Calls -> {"none", "live", "done", "dead"}]
    /\ callHolds \in [Calls -> BOOLEAN]
    /\ jobHolds \in [Calls -> BOOLEAN]
    /\ wired \in [Calls -> BOOLEAN]
    /\ adopting \in [Calls -> BOOLEAN]
    /\ ledger \in [Calls -> {"none", "pending", "completed", "detached", "unknown"}]
    /\ store \in [Calls -> {"none", "running", "ended"}]
    /\ killed \in [Calls -> BOOLEAN]
    /\ cause \in [Calls -> {"none", "callTimeout", "runDeadline", "cancel"}]

Init ==
    /\ phase = "run"
    /\ down = FALSE
    /\ call = [c \in Calls |-> "idle"]
    /\ proc = [c \in Calls |-> "none"]
    /\ callHolds = [c \in Calls |-> FALSE]
    /\ jobHolds = [c \in Calls |-> FALSE]
    /\ wired = [c \in Calls |-> FALSE]
    /\ adopting = [c \in Calls |-> FALSE]
    /\ ledger = [c \in Calls |-> "none"]
    /\ store = [c \in Calls |-> "none"]
    /\ killed = [c \in Calls |-> FALSE]
    /\ cause = [c \in Calls |-> None]

RunningJobs == {c \in Calls : store[c] = "running"}

Start(c) ==
    /\ phase = "run"
    /\ ~down
    /\ call[c] = "idle"
    /\ call' = [call EXCEPT ![c] = "running"]
    /\ proc' = [proc EXCEPT ![c] = "live"]
    /\ callHolds' = [callHolds EXCEPT ![c] = TRUE]
    /\ wired' = [wired EXCEPT ![c] = TRUE]
    /\ ledger' = [ledger EXCEPT ![c] = "pending"]
    /\ UNCHANGED <<phase, down, jobHolds, adopting, store, killed, cause>>

ExitInCall(c) ==
    /\ phase = "run"
    /\ call[c] = "running"
    /\ callHolds[c]
    /\ proc[c] = "live"
    /\ proc' = [proc EXCEPT ![c] = "done"]
    /\ call' = [call EXCEPT ![c] = "finished"]
    /\ ledger' = [ledger EXCEPT ![c] = "completed"]
    /\ callHolds' = [callHolds EXCEPT ![c] = FALSE]
    /\ wired' = [wired EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<phase, down, jobHolds, adopting, store, killed, cause>>

ExitInJob(c) ==
    /\ phase = "run"
    /\ jobHolds[c]
    /\ proc[c] = "live"
    /\ proc' = [proc EXCEPT ![c] = "done"]
    /\ store' = [store EXCEPT ![c] = "ended"]
    /\ jobHolds' = [jobHolds EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<phase, down, call, callHolds, wired, adopting, ledger, killed, cause>>

Promotes(c, why) ==
    /\ Policy = "background"
    /\ \/ why = "callTimeout"
       \/ Promote = "anyExpiry"
    /\ \/ ~CapEnforced
       \/ Cardinality(RunningJobs) < Cap

KillCall(c) ==
    /\ proc' = [proc EXCEPT ![c] = "dead"]
    /\ killed' = [killed EXCEPT ![c] = TRUE]
    /\ call' = [call EXCEPT ![c] = "finished"]
    /\ ledger' = [ledger EXCEPT ![c] = Ending]
    /\ callHolds' = [callHolds EXCEPT ![c] = FALSE]
    /\ wired' = [wired EXCEPT ![c] = FALSE]

Expire(c, why) ==
    /\ phase = "run"
    /\ call[c] = "running"
    /\ callHolds[c]
    /\ proc[c] = "live"
    /\ IF Promotes(c, why)
       THEN /\ call' = [call EXCEPT ![c] = "finished"]
            /\ ledger' = [ledger EXCEPT ![c] = "detached"]
            /\ cause' = [cause EXCEPT ![c] = why]
            /\ wired' = [wired EXCEPT ![c] = Wiring = "kept"]
            /\ IF Order = "adoptFirst"
               THEN /\ store' = [store EXCEPT ![c] = "running"]
                    /\ jobHolds' = [jobHolds EXCEPT ![c] = TRUE]
                    /\ callHolds' = [callHolds EXCEPT ![c] = Handoff = "twoOwners"]
                    /\ adopting' = adopting
               ELSE /\ adopting' = [adopting EXCEPT ![c] = TRUE]
                    /\ callHolds' = [callHolds EXCEPT ![c] = FALSE]
                    /\ UNCHANGED <<store, jobHolds>>
            /\ UNCHANGED <<proc, killed>>
       ELSE /\ KillCall(c)
            /\ UNCHANGED <<store, jobHolds, adopting, cause>>
    /\ UNCHANGED <<phase, down>>

CallTimeout(c) == Expire(c, "callTimeout")

RunDeadline(c) == Expire(c, "runDeadline")

Cancel(c) == Expire(c, "cancel")

AdoptLate(c) ==
    /\ phase = "run"
    /\ adopting[c]
    /\ adopting' = [adopting EXCEPT ![c] = FALSE]
    /\ store' = [store EXCEPT ![c] = "running"]
    /\ jobHolds' = [jobHolds EXCEPT ![c] = TRUE]
    /\ UNCHANGED <<phase, down, call, proc, callHolds, wired, ledger, killed, cause>>

KillJob(c) ==
    /\ phase = "run"
    /\ jobHolds[c]
    /\ proc[c] = "live"
    /\ proc' = [proc EXCEPT ![c] = "dead"]
    /\ killed' = [killed EXCEPT ![c] = TRUE]
    /\ store' = [store EXCEPT ![c] = "ended"]
    /\ jobHolds' = [jobHolds EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<phase, down, call, callHolds, wired, adopting, ledger, cause>>

LateCallSignal(c) ==
    /\ phase = "run"
    /\ call[c] = "finished"
    /\ wired[c]
    /\ proc[c] = "live"
    /\ proc' = [proc EXCEPT ![c] = "dead"]
    /\ killed' = [killed EXCEPT ![c] = TRUE]
    /\ wired' = [wired EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<phase, down, call, callHolds, jobHolds, adopting, ledger, store, cause>>

Shutdown ==
    /\ phase = "run"
    /\ ~down
    /\ down' = TRUE
    /\ proc' = [c \in Calls |-> IF proc[c] = "live" /\ (callHolds[c] \/ jobHolds[c]) THEN "dead" ELSE proc[c]]
    /\ killed' = [c \in Calls |-> killed[c] \/ (proc[c] = "live" /\ (callHolds[c] \/ jobHolds[c]))]
    /\ call' = [c \in Calls |-> IF call[c] = "running" /\ proc[c] = "live" /\ callHolds[c] THEN "finished" ELSE call[c]]
    /\ ledger' = [c \in Calls |-> IF call[c] = "running" /\ proc[c] = "live" /\ callHolds[c] THEN Ending ELSE ledger[c]]
    /\ store' = [c \in Calls |-> IF jobHolds[c] /\ proc[c] = "live" THEN "ended" ELSE store[c]]
    /\ callHolds' = [c \in Calls |-> FALSE]
    /\ jobHolds' = [c \in Calls |-> IF proc[c] = "live" THEN FALSE ELSE jobHolds[c]]
    /\ wired' = [c \in Calls |-> IF proc[c] = "live" /\ callHolds[c] THEN FALSE ELSE wired[c]]
    /\ UNCHANGED <<phase, adopting, cause>>

Crash ==
    /\ phase = "run"
    /\ phase' = "crashed"
    /\ callHolds' = [c \in Calls |-> FALSE]
    /\ jobHolds' = [c \in Calls |-> FALSE]
    /\ wired' = [c \in Calls |-> FALSE]
    /\ adopting' = [c \in Calls |-> FALSE]
    /\ call' = [c \in Calls |-> IF call[c] = "running" THEN "finished" ELSE call[c]]
    /\ UNCHANGED <<down, proc, ledger, store, killed, cause>>

ExitOrphan(c) ==
    /\ phase = "crashed"
    /\ proc[c] = "live"
    /\ proc' = [proc EXCEPT ![c] = "done"]
    /\ UNCHANGED <<phase, down, call, callHolds, jobHolds, wired, adopting, ledger, store, killed, cause>>

Reaped(c) == ledger[c] = "pending" \/ store[c] = "running"

Recover ==
    /\ phase = "crashed"
    /\ phase' = "recovered"
    /\ proc' = [c \in Calls |-> IF proc[c] = "live" /\ Reaped(c) THEN "dead" ELSE proc[c]]
    /\ killed' = [c \in Calls |-> killed[c] \/ (proc[c] = "live" /\ Reaped(c))]
    /\ ledger' = [c \in Calls |-> IF ledger[c] = "pending" THEN "unknown" ELSE ledger[c]]
    /\ store' = [c \in Calls |-> IF store[c] = "running" THEN "ended" ELSE store[c]]
    /\ UNCHANGED <<down, call, callHolds, jobHolds, wired, adopting, cause>>

Settled ==
    /\ phase = "recovered"
    /\ UNCHANGED vars

Next ==
    \/ \E c \in Calls :
        \/ Start(c)
        \/ ExitInCall(c)
        \/ ExitInJob(c)
        \/ CallTimeout(c)
        \/ RunDeadline(c)
        \/ Cancel(c)
        \/ AdoptLate(c)
        \/ KillJob(c)
        \/ LateCallSignal(c)
        \/ ExitOrphan(c)
    \/ Shutdown
    \/ Crash
    \/ Recover
    \/ Settled

Spec == Init /\ [][Next]_vars

OneOwner == \A c \in Calls : ~(callHolds[c] /\ jobHolds[c])

OwnedWhileLive == phase = "run" => \A c \in Calls : proc[c] = "live" => (callHolds[c] \/ jobHolds[c] \/ adopting[c])

JobIsLive == phase = "run" => \A c \in Calls : store[c] = "running" => proc[c] = "live"

OnlyCallTimeoutPromotes == \A c \in Calls : (store[c] # "none" \/ ledger[c] = "detached") => cause[c] = "callTimeout"

RecoveryReapsAll == phase = "recovered" => \A c \in Calls : proc[c] # "live"

LedgerDetachedImpliesJob == \A c \in Calls : (ledger[c] = "detached" /\ ~adopting[c]) => store[c] # "none"

KilledExecIsUnknown == \A c \in Calls : (killed[c] /\ store[c] = "none" /\ ledger[c] # "none") => ledger[c] = "unknown"

JobCap == Cardinality(RunningJobs) <= Cap

=============================================================================
