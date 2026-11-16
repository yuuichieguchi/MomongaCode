--------------------------- MODULE ManagedServer ---------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS
    Targets,
    Gens,
    MaxRestarts,
    MaxChildCrashes,
    MaxGwCrashes,
    MaxKeyChanges,
    MaxRefusals,
    MaxCancels,
    MaxCloses,
    MaxCalls,
    GwFlights,
    SingleFlight,
    InstanceWait,
    ReapOnStart,
    BoundedRetries,
    Retries,
    CacheRefusal,
    ResetOnReady,
    ClaimBounded,
    SharedKey,
    ReapOther,
    RetiringRestart,
    CliEvents,
    ClaimLock

ASSUME /\ Gens \subseteq Nat \ {0} /\ Gens # {}
       /\ MaxRestarts \in Nat \ {0}
       /\ MaxChildCrashes \in Nat
       /\ MaxGwCrashes \in Nat
       /\ MaxKeyChanges \in Nat
       /\ MaxRefusals \in Nat
       /\ MaxCancels \in Nat
       /\ MaxCloses \in Nat
       /\ MaxCalls \in Nat
       /\ GwFlights \in {1, 2}
       /\ SingleFlight \in {"key", "none"}
       /\ InstanceWait \in BOOLEAN
       /\ ReapOnStart \in BOOLEAN
       /\ BoundedRetries \in BOOLEAN
       /\ Retries \in Nat \ {0}
       /\ CacheRefusal \in BOOLEAN
       /\ ResetOnReady \in BOOLEAN
       /\ ClaimBounded \in BOOLEAN
       /\ SharedKey \in BOOLEAN
       /\ ReapOther \in BOOLEAN
       /\ RetiringRestart \in BOOLEAN
       /\ CliEvents \in BOOLEAN
       /\ ClaimLock \in BOOLEAN

Scopes == {0} \cup Gens
MinGen == CHOOSE g \in Gens : \A h \in Gens : g <= h
Flights == {"s", "p1", "p2", "p3"}
Probes == {"p1", "p2", "p3"}
GwOwned == {"s", "p1", "p3"}
Insts == {"s", "g", "c"}
GwInsts == {"s", "g"}
InstOf(f) == CASE f = "s" -> "s" [] f = "p2" -> "c" [] OTHER -> "g"
States == {"idle", "wait", "pre", "claim", "spawn", "ready", "running", "measure", "backoff", "stopping", "failed"}
Waiting == {"wait", "pre", "claim", "spawn", "ready", "measure", "backoff", "stopping"}
Gone == {"idle", "failed"}
Free == {"idle", "wait"}
GwStates == {"none", "up", "down"}

KeyS(s) == IF s = 0 \/ ~SharedKey THEN s ELSE MinGen
ReapKeys(s) == IF ReapOther /\ s # 0 THEN {KeyS(g) : g \in Gens} ELSE {KeyS(s)}
Locked(s, r) == s = r
Partner(f) == IF f = "p1" THEN "p3" ELSE "p1"

VARIABLES
    gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls,
    st, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped,
    foreignReap, restartRetiring, siblingCut

vars == <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, st, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

Held == {"claim", "spawn", "ready"}
ClaimFree(s, t, f) == ~ClaimLock \/ \A r \in Scopes, p \in Flights : (KeyS(r) = KeyS(s) /\ InstOf(p) = InstOf(f) /\ ~(r = s /\ p = f)) => st[r][t][p] \notin Held
CutsSibling(s, t, f) == \E r \in Scopes, p \in Flights : KeyS(r) \in ReapKeys(s) /\ InstOf(p) = InstOf(f) /\ ~(r = s /\ p = f) /\ alive[r][t][p] = 1

AliveOn(k, t, n) == Cardinality({sf \in Scopes \X Flights : KeyS(sf[1]) = k /\ InstOf(sf[2]) = n /\ alive[sf[1]][t][sf[2]] = 1})
OnInst(s, t, n) == orphan[KeyS(s)][t][n] + AliveOn(KeyS(s), t, n)
InstanceBusy(s, t, f) == InstOf(f) = "g" /\ st[s][t][Partner(f)] \notin Free
Told(k, t, n) == BoundedRetries /\ tries[k][t][n] = Retries
MayReap(s, t, n) == ReapOnStart /\ ~Told(KeyS(s), t, n)
Spend(k, t, n) == IF BoundedRetries THEN tries[k][t][n] + 1 ELSE tries[k][t][n]
ForeignFootprint(s, t, n) == \E k \in ReapKeys(s) \ {KeyS(s)} : orphan[k][t][n] > 0 \/ AliveOn(k, t, n) > 0
FailTarget(s, t) == IF cc[s][t] >= MaxRestarts THEN "failed" ELSE "backoff"
EndOf(s, t, f) == IF f = "s" THEN FailTarget(s, t) ELSE "idle"
ClearedPre(s, t, f) == [pre EXCEPT ![s][t] = IF f = "s" THEN "unknown" ELSE pre[s][t]]
ProbeGate(s, f) == IF f = "p2" THEN s = 0 /\ CliEvents ELSE s \in Gens /\ gw[s] = "up" /\ ~ret[s]

TypeOK ==
    /\ gw \in [Gens -> GwStates]
    /\ ret \in [Gens -> BOOLEAN]
    /\ reaped \in [Gens -> BOOLEAN]
    /\ gwCrashes \in 0..MaxGwCrashes
    /\ childCrashes \in 0..MaxChildCrashes
    /\ keyChanges \in 0..MaxKeyChanges
    /\ refusals \in 0..MaxRefusals
    /\ cancels \in 0..MaxCancels
    /\ closes \in 0..MaxCloses
    /\ calls \in [Scopes -> [Targets -> 0..MaxCalls]]
    /\ st \in [Scopes -> [Targets -> [Flights -> States]]]
    /\ alive \in [Scopes -> [Targets -> [Flights -> 0..1]]]
    /\ orphan \in [Scopes -> [Targets -> [Insts -> 0..3]]]
    /\ tries \in [Scopes -> [Targets -> [Insts -> 0..Retries]]]
    /\ taint \in [Scopes -> [Targets -> [Flights -> BOOLEAN]]]
    /\ hung \in [Scopes -> [Targets -> [Flights -> BOOLEAN]]]
    /\ cond \in {"ok", "bad"}
    /\ pre \in [Scopes -> [Targets -> {"unknown", "met", "refused"}]]
    /\ cc \in [Scopes -> [Targets -> 0..MaxRestarts]]
    /\ gt \in [Scopes -> [Targets -> 0..MaxRestarts]]
    /\ foreignReap \in BOOLEAN
    /\ restartRetiring \in BOOLEAN
    /\ siblingCut \in BOOLEAN

Init ==
    /\ gw = [g \in Gens |-> IF g = MinGen THEN "up" ELSE "none"]
    /\ ret = [g \in Gens |-> FALSE]
    /\ reaped = [g \in Gens |-> TRUE]
    /\ gwCrashes = 0 /\ childCrashes = 0 /\ keyChanges = 0 /\ refusals = 0 /\ cancels = 0 /\ closes = 0
    /\ calls = [s \in Scopes |-> [t \in Targets |-> 0]]
    /\ st = [s \in Scopes |-> [t \in Targets |-> [f \in Flights |-> "idle"]]]
    /\ alive = [s \in Scopes |-> [t \in Targets |-> [f \in Flights |-> 0]]]
    /\ orphan = [s \in Scopes |-> [t \in Targets |-> [n \in Insts |-> 0]]]
    /\ tries = [s \in Scopes |-> [t \in Targets |-> [n \in Insts |-> 0]]]
    /\ taint = [s \in Scopes |-> [t \in Targets |-> [f \in Flights |-> FALSE]]]
    /\ hung = [s \in Scopes |-> [t \in Targets |-> [f \in Flights |-> FALSE]]]
    /\ cond = "ok"
    /\ pre = [s \in Scopes |-> [t \in Targets |-> "unknown"]]
    /\ cc = [s \in Scopes |-> [t \in Targets |-> 0]]
    /\ gt = [s \in Scopes |-> [t \in Targets |-> 0]]
    /\ foreignReap = FALSE
    /\ restartRetiring = FALSE
    /\ siblingCut = FALSE

StartServe(s, t) ==
    /\ s \in Gens /\ gw[s] = "up" /\ ~ret[s]
    /\ st[s][t]["s"] \in Gone /\ pre[s][t] # "refused"
    /\ (pre[s][t] = "met" => ClaimFree(s, t, "s"))
    /\ st' = [st EXCEPT ![s][t]["s"] = IF pre[s][t] = "met" THEN "claim" ELSE "pre"]
    /\ pre' = [pre EXCEPT ![s][t] = "unknown"]
    /\ cc' = [cc EXCEPT ![s][t] = 0]
    /\ gt' = [gt EXCEPT ![s][t] = 0]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, reaped, foreignReap, restartRetiring, siblingCut>>

Health(s, t) ==
    /\ s \in Gens /\ gw[s] = "up" /\ pre[s][t] = "unknown"
    /\ pre' = [pre EXCEPT ![s][t] = IF cond = "ok" THEN "met" ELSE IF CacheRefusal THEN "refused" ELSE "unknown"]
    /\ pre' # pre
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, st, alive, orphan, tries, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

PreOk(s, t, f) ==
    /\ st[s][t][f] = "pre" /\ cond = "ok" /\ ClaimFree(s, t, f)
    /\ st' = [st EXCEPT ![s][t][f] = "claim"]
    /\ pre' = [pre EXCEPT ![s][t] = IF f = "s" THEN "met" ELSE pre[s][t]]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

PreBad(s, t, f) ==
    /\ st[s][t][f] = "pre" /\ cond = "bad"
    /\ st' = [st EXCEPT ![s][t][f] = "idle"]
    /\ pre' = [pre EXCEPT ![s][t] = IF f = "s" /\ CacheRefusal THEN "refused" ELSE pre[s][t]]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

ClaimOk(s, t, f) ==
    LET n == InstOf(f)
        k == KeyS(s)
    IN
    /\ st[s][t][f] = "claim" /\ ~hung[s][t][f] /\ (OnInst(s, t, n) = 0 \/ MayReap(s, t, n))
    /\ st' = [st EXCEPT ![s][t][f] = "spawn"]
    /\ foreignReap' = (foreignReap \/ ForeignFootprint(s, t, n))
    /\ siblingCut' = (siblingCut \/ CutsSibling(s, t, f))
    /\ orphan' = [s2 \in Scopes |-> [t2 \in Targets |-> [n2 \in Insts |->
            IF t2 = t /\ n2 = n /\ s2 \in ReapKeys(s) THEN 0 ELSE orphan[s2][t2][n2]]]]
    /\ tries' = [tries EXCEPT ![k][t][n] = 0]
    /\ alive' = [s2 \in Scopes |-> [t2 \in Targets |-> [p \in Flights |->
            IF t2 = t /\ InstOf(p) = n /\ KeyS(s2) \in ReapKeys(s) THEN 0 ELSE alive[s2][t2][p]]]]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, taint, hung, cond, pre, cc, gt, reaped, restartRetiring>>

ClaimKept(s, t, f) ==
    LET n == InstOf(f)
        k == KeyS(s)
    IN
    /\ st[s][t][f] = "claim" /\ ~hung[s][t][f] /\ OnInst(s, t, n) > 0 /\ MayReap(s, t, n)
    /\ st' = [st EXCEPT ![s][t][f] = EndOf(s, t, f)]
    /\ pre' = ClearedPre(s, t, f)
    /\ tries' = [tries EXCEPT ![k][t][n] = Spend(k, t, n)]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

ClaimBusy(s, t, f) ==
    LET n == InstOf(f)
    IN
    /\ st[s][t][f] = "claim" /\ ~hung[s][t][f] /\ OnInst(s, t, n) > 0 /\ ~MayReap(s, t, n)
    /\ st' = [st EXCEPT ![s][t][f] = EndOf(s, t, f)]
    /\ pre' = ClearedPre(s, t, f)
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

ClaimEnd(s, t, f) == ClaimOk(s, t, f) \/ ClaimKept(s, t, f) \/ ClaimBusy(s, t, f)

Hang(s, t, f) ==
    /\ ~ClaimBounded /\ st[s][t][f] = "claim" /\ ~hung[s][t][f]
    /\ hung' = [hung EXCEPT ![s][t][f] = TRUE]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, st, alive, orphan, tries, taint, cond, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

Spawn(s, t, f) ==
    /\ st[s][t][f] = "spawn"
    /\ st' = [st EXCEPT ![s][t][f] = "ready"]
    /\ alive' = [alive EXCEPT ![s][t][f] = 1]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

Ready(s, t, f) ==
    /\ st[s][t][f] = "ready" /\ alive[s][t][f] = 1
    /\ st' = [st EXCEPT ![s][t][f] = IF f = "s" THEN "running" ELSE "measure"]
    /\ cc' = [cc EXCEPT ![s][t] = IF f = "s" /\ ResetOnReady THEN 0 ELSE cc[s][t]]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, pre, gt, reaped, foreignReap, restartRetiring, siblingCut>>

ChildCrash(s, t, f) ==
    /\ childCrashes < MaxChildCrashes /\ alive[s][t][f] = 1 /\ st[s][t][f] \in {"ready", "running", "measure"}
    /\ childCrashes' = childCrashes + 1
    /\ alive' = [alive EXCEPT ![s][t][f] = 0]
    /\ st' = [st EXCEPT ![s][t][f] = EndOf(s, t, f)]
    /\ pre' = ClearedPre(s, t, f)
    /\ UNCHANGED <<gw, ret, gwCrashes, keyChanges, refusals, cancels, closes, calls, orphan, tries, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

ExpirePre(s, t, f) ==
    /\ st[s][t][f] = "pre"
    /\ st' = [st EXCEPT ![s][t][f] = "idle"]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

ExpireSpawn(s, t, f) ==
    /\ st[s][t][f] = "spawn"
    /\ st' = [st EXCEPT ![s][t][f] = EndOf(s, t, f)]
    /\ pre' = ClearedPre(s, t, f)
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

ExpireReady(s, t, f) ==
    /\ st[s][t][f] = "ready"
    /\ alive' = [alive EXCEPT ![s][t][f] = 0]
    /\ st' = [st EXCEPT ![s][t][f] = EndOf(s, t, f)]
    /\ pre' = ClearedPre(s, t, f)
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, orphan, tries, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

ExpireMeasure(s, t, f) ==
    /\ f \in Probes /\ st[s][t][f] = "measure"
    /\ st' = [st EXCEPT ![s][t][f] = "stopping"]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

Expire(s, t, f) == ExpirePre(s, t, f) \/ ExpireSpawn(s, t, f) \/ ExpireReady(s, t, f) \/ ExpireMeasure(s, t, f)

TimerFires(s, t) ==
    /\ s \in Gens /\ st[s][t]["s"] = "backoff"
    /\ (~ret[s] \/ calls[s][t] > 0 \/ RetiringRestart)
    /\ st' = [st EXCEPT ![s][t]["s"] = "pre"]
    /\ pre' = [pre EXCEPT ![s][t] = "unknown"]
    /\ cc' = [cc EXCEPT ![s][t] = cc[s][t] + 1]
    /\ gt' = [gt EXCEPT ![s][t] = gt[s][t] + 1]
    /\ restartRetiring' = (restartRetiring \/ (ret[s] /\ calls[s][t] = 0))
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, reaped, foreignReap, siblingCut>>

WindowDone(s, t) ==
    /\ st[s][t]["s"] = "running" /\ (cc[s][t] > 0 \/ gt[s][t] > 0)
    /\ cc' = [cc EXCEPT ![s][t] = 0]
    /\ gt' = [gt EXCEPT ![s][t] = 0]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, st, alive, orphan, tries, taint, hung, cond, pre, reaped, foreignReap, restartRetiring, siblingCut>>

Accept(s, t) ==
    /\ s \in Gens /\ gw[s] = "up" /\ ~ret[s] /\ calls[s][t] < MaxCalls
    /\ calls' = [calls EXCEPT ![s][t] = calls[s][t] + 1]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, st, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

CallEnd(s, t) ==
    /\ calls[s][t] > 0
    /\ calls' = [calls EXCEPT ![s][t] = calls[s][t] - 1]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, st, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

ProbeStart(s, t, f) ==
    /\ f \in Probes /\ st[s][t][f] = "idle" /\ ProbeGate(s, f)
    /\ (f = "p3" => GwFlights = 2 /\ st[s][t]["p1"] # "idle")
    /\ (SingleFlight = "none" \/ \A r \in Scopes : Locked(s, r) => \A j \in Probes : ((r = s /\ j = f) \/ st[r][t][j] = "idle" \/ taint[r][t][j]))
    /\ st' = [st EXCEPT ![s][t][f] = IF InstanceWait /\ InstanceBusy(s, t, f) THEN "wait" ELSE "pre"]
    /\ taint' = [taint EXCEPT ![s][t][f] = FALSE]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

Enter(s, t, f) ==
    /\ st[s][t][f] = "wait" /\ ~InstanceBusy(s, t, f)
    /\ st' = [st EXCEPT ![s][t][f] = "pre"]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

StopEnd(s, t, f) ==
    LET n == InstOf(f)
        k == KeyS(s)
    IN
    /\ st[s][t][f] = "stopping"
    /\ \E confirmed \in BOOLEAN :
         orphan' = [orphan EXCEPT ![k][t][n] = IF confirmed THEN @ ELSE @ + alive[s][t][f]]
    /\ alive' = [alive EXCEPT ![s][t][f] = 0]
    /\ st' = [st EXCEPT ![s][t][f] = "idle"]
    /\ pre' = ClearedPre(s, t, f)
    /\ taint' = [taint EXCEPT ![s][t][f] = FALSE]
    /\ hung' = [hung EXCEPT ![s][t][f] = FALSE]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, tries, cond, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

Cancel(t) ==
    /\ cancels < MaxCancels /\ st[0][t]["p2"] \in {"pre", "claim", "spawn", "ready", "measure"}
    /\ st' = [st EXCEPT ![0][t]["p2"] = "stopping"]
    /\ cancels' = cancels + 1
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, closes, calls, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

CliCrash(t) ==
    /\ cancels < MaxCancels /\ st[0][t]["p2"] # "idle"
    /\ st' = [st EXCEPT ![0][t]["p2"] = "idle"]
    /\ orphan' = [orphan EXCEPT ![0][t]["c"] = @ + alive[0][t]["p2"]]
    /\ alive' = [alive EXCEPT ![0][t]["p2"] = 0]
    /\ taint' = [taint EXCEPT ![0][t]["p2"] = FALSE]
    /\ hung' = [hung EXCEPT ![0][t]["p2"] = FALSE]
    /\ cancels' = cancels + 1
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, closes, calls, tries, cond, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

Close(g) ==
    /\ gw[g] = "up" /\ closes < MaxCloses
    /\ gw' = [gw EXCEPT ![g] = "down"]
    /\ closes' = closes + 1
    /\ st' = [st EXCEPT ![g] = [t \in Targets |->
            [f \in Flights |->
                IF f \in GwOwned /\ st[g][t][f] \in {"backoff", "wait"} THEN "idle"
                ELSE IF f \in GwOwned /\ st[g][t][f] \in {"pre", "claim", "spawn", "ready", "running", "measure"} THEN "stopping"
                ELSE st[g][t][f]]]]
    /\ pre' = [pre EXCEPT ![g] = [t \in Targets |-> "unknown"]]
    /\ reaped' = [reaped EXCEPT ![g] = FALSE]
    /\ UNCHANGED <<ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, calls, alive, orphan, tries, taint, hung, cond, cc, gt, foreignReap, restartRetiring, siblingCut>>

Crash(g) ==
    /\ gw[g] = "up" /\ gwCrashes < MaxGwCrashes
    /\ gw' = [gw EXCEPT ![g] = "down"]
    /\ gwCrashes' = gwCrashes + 1
    /\ st' = [st EXCEPT ![g] = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN "idle" ELSE st[g][t][f]]]]
    /\ orphan' = [k \in Scopes |-> [t \in Targets |-> [n \in Insts |->
            orphan[k][t][n] + IF k = KeyS(g) /\ n \in GwInsts THEN Cardinality({p \in Flights : InstOf(p) = n /\ alive[g][t][p] = 1}) ELSE 0]]]
    /\ alive' = [alive EXCEPT ![g] = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN 0 ELSE alive[g][t][f]]]]
    /\ taint' = [taint EXCEPT ![g] = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN FALSE ELSE taint[g][t][f]]]]
    /\ hung' = [hung EXCEPT ![g] = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN FALSE ELSE hung[g][t][f]]]]
    /\ pre' = [pre EXCEPT ![g] = [t \in Targets |-> "unknown"]]
    /\ cc' = [cc EXCEPT ![g] = [t \in Targets |-> 0]]
    /\ gt' = [gt EXCEPT ![g] = [t \in Targets |-> 0]]
    /\ reaped' = [reaped EXCEPT ![g] = FALSE]
    /\ UNCHANGED <<ret, childCrashes, keyChanges, refusals, cancels, closes, calls, tries, cond, foreignReap, restartRetiring, siblingCut>>

ReapGone(g) ==
    /\ gw[g] = "down" /\ ~reaped[g]
    /\ \A t \in Targets, f \in GwOwned : st[g][t][f] \in Gone
    /\ reaped' = [reaped EXCEPT ![g] = TRUE]
    /\ \E kill \in [Targets -> [GwInsts -> BOOLEAN]] :
         LET k == KeyS(g)
             Signalled(t, n) == n \in GwInsts /\ orphan[k][t][n] > 0 /\ ~Told(k, t, n)
         IN
         /\ orphan' = [orphan EXCEPT ![k] = [t \in Targets |-> [n \in Insts |->
                IF Signalled(t, n) /\ kill[t][n] THEN 0 ELSE orphan[k][t][n]]]]
         /\ tries' = [tries EXCEPT ![k] = [t \in Targets |-> [n \in Insts |->
                IF ~Signalled(t, n) THEN tries[k][t][n]
                ELSE IF kill[t][n] THEN 0
                ELSE Spend(k, t, n)]]]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, st, alive, taint, hung, cond, pre, cc, gt, foreignReap, restartRetiring, siblingCut>>

SupervisorReap == \E g \in Gens : ReapGone(g)

GwUp(g) ==
    /\ gw[g] = "down" /\ reaped[g] /\ ~ret[g]
    /\ gw' = [gw EXCEPT ![g] = "up"]
    /\ st' = [st EXCEPT ![g] = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN "idle" ELSE st[g][t][f]]]]
    /\ hung' = [hung EXCEPT ![g] = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN FALSE ELSE hung[g][t][f]]]]
    /\ cc' = [cc EXCEPT ![g] = [t \in Targets |-> 0]]
    /\ gt' = [gt EXCEPT ![g] = [t \in Targets |-> 0]]
    /\ UNCHANGED <<ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, cond, pre, reaped, foreignReap, restartRetiring, siblingCut>>

GwStart(g) ==
    /\ gw[g] = "none"
    /\ gw' = [gw EXCEPT ![g] = "up"]
    /\ UNCHANGED <<ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, st, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

Retire(g) ==
    /\ ~ret[g] /\ (\E h \in Gens : h > g /\ gw[h] # "none")
    /\ ret' = [ret EXCEPT ![g] = TRUE]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, st, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

KeyChange ==
    /\ keyChanges < MaxKeyChanges
    /\ keyChanges' = keyChanges + 1
    /\ taint' = [s \in Scopes |-> [t \in Targets |-> [f \in Flights |-> taint[s][t][f] \/ (f \in Probes /\ st[s][t][f] # "idle")]]]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, refusals, cancels, closes, calls, st, alive, orphan, tries, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

Refuse ==
    /\ cond = "ok" /\ refusals < MaxRefusals
    /\ cond' = "bad" /\ refusals' = refusals + 1
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, cancels, closes, calls, st, alive, orphan, tries, taint, hung, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

Fix ==
    /\ cond = "bad" /\ refusals < MaxRefusals
    /\ cond' = "ok" /\ refusals' = refusals + 1
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, cancels, closes, calls, st, alive, orphan, tries, taint, hung, pre, cc, gt, reaped, foreignReap, restartRetiring, siblingCut>>

Next ==
    \/ \E t \in Targets : Cancel(t) \/ CliCrash(t)
    \/ \E s \in Scopes, t \in Targets :
        StartServe(s, t) \/ Health(s, t) \/ WindowDone(s, t) \/ TimerFires(s, t) \/ Accept(s, t) \/ CallEnd(s, t)
    \/ \E s \in Scopes, t \in Targets, f \in Flights :
        PreOk(s, t, f) \/ PreBad(s, t, f) \/ ClaimEnd(s, t, f) \/ Hang(s, t, f)
        \/ Spawn(s, t, f) \/ Ready(s, t, f) \/ ChildCrash(s, t, f) \/ Expire(s, t, f)
        \/ StopEnd(s, t, f) \/ ProbeStart(s, t, f) \/ Enter(s, t, f)
    \/ \E g \in Gens :
        Close(g) \/ Crash(g) \/ GwUp(g) \/ GwStart(g) \/ Retire(g) \/ ReapGone(g)
    \/ KeyChange \/ Refuse \/ Fix

Fairness ==
    /\ \A g \in Gens : WF_vars(ReapGone(g)) /\ WF_vars(Retire(g))
    /\ \A s \in Scopes, t \in Targets :
        /\ WF_vars(TimerFires(s, t))
        /\ WF_vars(CallEnd(s, t))
        /\ \A f \in Flights :
            /\ WF_vars(Expire(s, t, f))
            /\ WF_vars(StopEnd(s, t, f))
            /\ WF_vars(Enter(s, t, f))
            /\ WF_vars(ClaimEnd(s, t, f))

Spec == Init /\ [][Next]_vars /\ Fairness

OneLiveChild == \A k \in Scopes, t \in Targets, n \in Insts : orphan[k][t][n] + AliveOn(k, t, n) <= 1

OneFlight == \A t \in Targets : \A s, r \in Scopes : \A p, q \in Probes :
    (Locked(s, r) /\ ~(s = r /\ p = q) /\ st[s][t][p] # "idle" /\ st[r][t][q] # "idle") => (taint[s][t][p] \/ taint[r][t][q])

NoCachedRefusal == \A s \in Scopes, t \in Targets : pre[s][t] # "refused"

RestartBudget == \A s \in Scopes, t \in Targets : cc[s][t] <= MaxRestarts /\ (st[s][t]["s"] = "backoff" => gt[s][t] < MaxRestarts)

GenerationIsolation == \A g \in Gens, t \in Targets, p \in Flights : alive[g][t][p] = 1 => KeyS(g) = g

ReapOwnGenerationOnly == ~foreignReap

NoSiblingCut == ~siblingCut

GwNoRestartRetiring == ~restartRetiring

WaitsEnd == \A s \in Scopes, t \in Targets, f \in Flights : (st[s][t][f] \in Waiting) ~> (st[s][t][f] \notin Waiting)

GoneGatewayReaped == \A g \in Gens : (gw[g] = "down") ~> reaped[g]

StartAfterOrphanServes == \A s \in Scopes, t \in Targets, f \in Flights :
    []<>(st[s][t][f] = "claim") => []<>(st[s][t][f] = "spawn" \/ Told(KeyS(s), t, InstOf(f)))

=========================================================================
