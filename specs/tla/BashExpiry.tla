--------------------------- MODULE BashExpiry ---------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Calls, Cap, Policy, Promote, Order, Handoff, Wiring, Ending, CapEnforced, SuspendCheck, HandoffCancel

ASSUME Policy \in {"background", "kill"}
ASSUME Promote \in {"callTimeout", "anyExpiry"}
ASSUME Order \in {"adoptFirst", "ledgerFirst"}
ASSUME Handoff \in {"released", "twoOwners"}
ASSUME Wiring \in {"rebound", "kept"}
ASSUME Ending \in {"unknown", "completed"}
ASSUME CapEnforced \in BOOLEAN
ASSUME SuspendCheck \in BOOLEAN
ASSUME HandoffCancel \in {"stops", "ignored"}
ASSUME Cap \in Nat \ {0}

None == "none"

VARIABLES phase, down, wallPast, call, proc, callHolds, jobHolds, wired, adopting, ledger, store, killed, cause, handoffCut, cancelSeen

vars == <<phase, down, wallPast, call, proc, callHolds, jobHolds, wired, adopting, ledger, store, killed, cause, handoffCut, cancelSeen>>

TypeOK ==
    /\ phase \in {"run", "crashed", "recovered"}
    /\ down \in BOOLEAN
    /\ wallPast \in BOOLEAN
    /\ call \in [Calls -> {"idle", "running", "handoff", "finished"}]
    /\ proc \in [Calls -> {"none", "live", "done", "dead"}]
    /\ callHolds \in [Calls -> BOOLEAN]
    /\ jobHolds \in [Calls -> BOOLEAN]
    /\ wired \in [Calls -> BOOLEAN]
    /\ adopting \in [Calls -> BOOLEAN]
    /\ ledger \in [Calls -> {"none", "pending", "completed", "detached", "unknown"}]
    /\ store \in [Calls -> {"none", "running", "ended"}]
    /\ killed \in [Calls -> BOOLEAN]
    /\ cause \in [Calls -> {"none", "callTimeout", "runDeadline", "cancel"}]
    /\ handoffCut \in [Calls -> BOOLEAN]
    /\ cancelSeen \in [Calls -> BOOLEAN]

Init ==
    /\ phase = "run"
    /\ down = FALSE
    /\ wallPast = FALSE
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
    /\ handoffCut = [c \in Calls |-> FALSE]
    /\ cancelSeen = [c \in Calls |-> FALSE]

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
    /\ UNCHANGED <<phase, down, wallPast, jobHolds, adopting, store, killed, cause, handoffCut, cancelSeen>>

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
    /\ UNCHANGED <<phase, down, wallPast, jobHolds, adopting, store, killed, cause, handoffCut, cancelSeen>>

ExitInJob(c) ==
    /\ phase = "run"
    /\ jobHolds[c]
    /\ proc[c] = "live"
    /\ proc' = [proc EXCEPT ![c] = "done"]
    /\ store' = [store EXCEPT ![c] = "ended"]
    /\ jobHolds' = [jobHolds EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<phase, down, wallPast, call, callHolds, wired, adopting, ledger, killed, cause, handoffCut, cancelSeen>>

Promotes(why) ==
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

Expire(c, trueCause, decidedCause) ==
    /\ phase = "run"
    /\ call[c] = "running"
    /\ callHolds[c]
    /\ proc[c] = "live"
    /\ IF Promotes(decidedCause)
       THEN IF Order = "adoptFirst"
            THEN /\ call' = [call EXCEPT ![c] = "handoff"]
                 /\ cause' = [cause EXCEPT ![c] = trueCause]
                 /\ wired' = [wired EXCEPT ![c] = Wiring = "kept"]
                 /\ store' = [store EXCEPT ![c] = "running"]
                 /\ jobHolds' = [jobHolds EXCEPT ![c] = TRUE]
                 /\ callHolds' = [callHolds EXCEPT ![c] = Handoff = "twoOwners"]
                 /\ UNCHANGED <<proc, killed, ledger, adopting>>
            ELSE /\ call' = [call EXCEPT ![c] = "finished"]
                 /\ ledger' = [ledger EXCEPT ![c] = "detached"]
                 /\ cause' = [cause EXCEPT ![c] = trueCause]
                 /\ wired' = [wired EXCEPT ![c] = Wiring = "kept"]
                 /\ adopting' = [adopting EXCEPT ![c] = TRUE]
                 /\ callHolds' = [callHolds EXCEPT ![c] = FALSE]
                 /\ UNCHANGED <<proc, killed, store, jobHolds>>
       ELSE /\ KillCall(c)
            /\ UNCHANGED <<store, jobHolds, adopting, cause>>
    /\ UNCHANGED <<phase, down, wallPast, handoffCut, cancelSeen>>

TrueCauseOfTimer == IF wallPast THEN "runDeadline" ELSE "callTimeout"

CallTimeout(c) == Expire(c, TrueCauseOfTimer, IF SuspendCheck THEN TrueCauseOfTimer ELSE "callTimeout")

RunDeadline(c) == Expire(c, "runDeadline", "runDeadline")

Cancel(c) == Expire(c, "cancel", "cancel")

LedgerWrite(c) ==
    /\ phase = "run"
    /\ call[c] = "handoff"
    /\ call' = [call EXCEPT ![c] = "finished"]
    /\ ledger' = [ledger EXCEPT ![c] = "detached"]
    /\ UNCHANGED <<phase, down, wallPast, proc, callHolds, jobHolds, wired, adopting, store, killed, cause, handoffCut, cancelSeen>>

HandoffStop(c) ==
    /\ phase = "run"
    /\ call[c] = "handoff"
    /\ jobHolds[c]
    /\ proc[c] = "live"
    /\ cancelSeen' = [cancelSeen EXCEPT ![c] = TRUE]
    /\ IF HandoffCancel = "stops"
       THEN /\ proc' = [proc EXCEPT ![c] = "dead"]
            /\ killed' = [killed EXCEPT ![c] = TRUE]
            /\ store' = [store EXCEPT ![c] = "ended"]
            /\ jobHolds' = [jobHolds EXCEPT ![c] = FALSE]
            /\ call' = [call EXCEPT ![c] = "finished"]
            /\ ledger' = [ledger EXCEPT ![c] = "unknown"]
            /\ handoffCut' = [handoffCut EXCEPT ![c] = TRUE]
       ELSE UNCHANGED <<proc, killed, store, jobHolds, call, ledger, handoffCut>>
    /\ UNCHANGED <<phase, down, wallPast, callHolds, wired, adopting, cause>>

AdoptLate(c) ==
    /\ phase = "run"
    /\ adopting[c]
    /\ adopting' = [adopting EXCEPT ![c] = FALSE]
    /\ store' = [store EXCEPT ![c] = "running"]
    /\ jobHolds' = [jobHolds EXCEPT ![c] = TRUE]
    /\ UNCHANGED <<phase, down, wallPast, call, proc, callHolds, wired, ledger, killed, cause, handoffCut, cancelSeen>>

KillJob(c) ==
    /\ phase = "run"
    /\ jobHolds[c]
    /\ call[c] # "handoff"
    /\ proc[c] = "live"
    /\ proc' = [proc EXCEPT ![c] = "dead"]
    /\ killed' = [killed EXCEPT ![c] = TRUE]
    /\ store' = [store EXCEPT ![c] = "ended"]
    /\ jobHolds' = [jobHolds EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<phase, down, wallPast, call, callHolds, wired, adopting, ledger, cause, handoffCut, cancelSeen>>

LateCallSignal(c) ==
    /\ phase = "run"
    /\ call[c] = "finished"
    /\ wired[c]
    /\ proc[c] = "live"
    /\ proc' = [proc EXCEPT ![c] = "dead"]
    /\ killed' = [killed EXCEPT ![c] = TRUE]
    /\ wired' = [wired EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<phase, down, wallPast, call, callHolds, jobHolds, adopting, ledger, store, cause, handoffCut, cancelSeen>>

Suspend ==
    /\ phase = "run"
    /\ ~wallPast
    /\ \E c \in Calls : call[c] = "running"
    /\ wallPast' = TRUE
    /\ UNCHANGED <<phase, down, call, proc, callHolds, jobHolds, wired, adopting, ledger, store, killed, cause, handoffCut, cancelSeen>>

HeldLive(c) == proc[c] = "live" /\ (callHolds[c] \/ jobHolds[c])

Shutdown ==
    /\ phase = "run"
    /\ ~down
    /\ down' = TRUE
    /\ proc' = [c \in Calls |-> IF HeldLive(c) THEN "dead" ELSE proc[c]]
    /\ killed' = [c \in Calls |-> killed[c] \/ HeldLive(c)]
    /\ call' = [c \in Calls |-> IF HeldLive(c) /\ call[c] \in {"running", "handoff"} THEN "finished" ELSE call[c]]
    /\ ledger' = [c \in Calls |-> IF HeldLive(c) /\ call[c] = "running" THEN Ending ELSE IF HeldLive(c) /\ call[c] = "handoff" THEN "unknown" ELSE ledger[c]]
    /\ store' = [c \in Calls |-> IF HeldLive(c) /\ jobHolds[c] THEN "ended" ELSE store[c]]
    /\ handoffCut' = [c \in Calls |-> handoffCut[c] \/ (HeldLive(c) /\ call[c] = "handoff")]
    /\ callHolds' = [c \in Calls |-> FALSE]
    /\ jobHolds' = [c \in Calls |-> IF HeldLive(c) THEN FALSE ELSE jobHolds[c]]
    /\ wired' = [c \in Calls |-> IF HeldLive(c) THEN FALSE ELSE wired[c]]
    /\ UNCHANGED <<phase, wallPast, adopting, cause, cancelSeen>>

Crash ==
    /\ phase = "run"
    /\ phase' = "crashed"
    /\ callHolds' = [c \in Calls |-> FALSE]
    /\ jobHolds' = [c \in Calls |-> FALSE]
    /\ wired' = [c \in Calls |-> FALSE]
    /\ adopting' = [c \in Calls |-> FALSE]
    /\ call' = [c \in Calls |-> IF call[c] \in {"running", "handoff"} THEN "finished" ELSE call[c]]
    /\ handoffCut' = [c \in Calls |-> handoffCut[c] \/ call[c] = "handoff"]
    /\ UNCHANGED <<down, wallPast, proc, ledger, store, killed, cause, cancelSeen>>

ExitOrphan(c) ==
    /\ phase = "crashed"
    /\ proc[c] = "live"
    /\ proc' = [proc EXCEPT ![c] = "done"]
    /\ UNCHANGED <<phase, down, wallPast, call, callHolds, jobHolds, wired, adopting, ledger, store, killed, cause, handoffCut, cancelSeen>>

Reaped(c) == ledger[c] = "pending" \/ store[c] = "running"

Recover ==
    /\ phase = "crashed"
    /\ phase' = "recovered"
    /\ proc' = [c \in Calls |-> IF proc[c] = "live" /\ Reaped(c) THEN "dead" ELSE proc[c]]
    /\ killed' = [c \in Calls |-> killed[c] \/ (proc[c] = "live" /\ Reaped(c))]
    /\ ledger' = [c \in Calls |-> IF ledger[c] = "pending" THEN "unknown" ELSE ledger[c]]
    /\ store' = [c \in Calls |-> IF store[c] = "running" THEN "ended" ELSE store[c]]
    /\ UNCHANGED <<down, wallPast, call, callHolds, jobHolds, wired, adopting, cause, handoffCut, cancelSeen>>

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
        \/ LedgerWrite(c)
        \/ HandoffStop(c)
        \/ AdoptLate(c)
        \/ KillJob(c)
        \/ LateCallSignal(c)
        \/ ExitOrphan(c)
    \/ Suspend
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

LedgerDetachedIffJob ==
    \A c \in Calls : (call[c] = "finished" /\ ~adopting[c]) => ((ledger[c] = "detached") <=> (store[c] # "none" /\ ~handoffCut[c]))

CancelWinsInHandoff == \A c \in Calls : cancelSeen[c] => ledger[c] # "detached"

KilledExecIsUnknown == \A c \in Calls : (killed[c] /\ store[c] = "none" /\ ledger[c] # "none") => ledger[c] = "unknown"

JobCap == Cardinality(RunningJobs) <= Cap

=============================================================================
