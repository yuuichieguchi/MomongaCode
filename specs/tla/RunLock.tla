---------------------------- MODULE RunLock ----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Lights, Heavies, Waiters, MaxAttempts, Nested, Variant

ASSUME Variant \in {"correct", "noLightCheck", "noHeavyScan", "checkFirst", "staleIsLive", "crashKeeps", "orphan", "heavyUnderLight", "unboundedWait"}
ASSUME Waiters \subseteq (Lights \union Heavies)
ASSUME MaxAttempts \in Nat
ASSUME Nested \in BOOLEAN
ASSUME Lights \cap Heavies = {}

Procs == Lights \union Heavies
None == "none"
Alive == {"idle", "claimed", "checked", "ready", "running", "refusing"}
Phases == Alive \union {"refused", "gaveUp", "done", "dead"}
Needs == {"light", "heavy"}

VARIABLES pc, heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, kpc, kneed

vars == <<pc, heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, kpc, kneed>>

TypeOK ==
    /\ pc \in [Procs -> Phases]
    /\ heavyHeld \in Heavies \union {None}
    /\ lightHeld \in [Lights -> BOOLEAN]
    /\ lightFile \in [Lights -> BOOLEAN]
    /\ todo \in [Procs -> SUBSET Lights]
    /\ blocked \in [Procs -> BOOLEAN]
    /\ blame \in [Procs -> SUBSET Procs]
    /\ attempts \in [Procs -> 0..MaxAttempts]
    /\ ran \in [Procs -> BOOLEAN]
    /\ kpc \in [Procs -> {"none", "running", "refused", "done", "dead"}]
    /\ kneed \in [Procs -> Needs \union {None}]

Init ==
    /\ pc = [p \in Procs |-> "idle"]
    /\ heavyHeld = None
    /\ lightHeld = [l \in Lights |-> FALSE]
    /\ lightFile = [l \in Lights |-> FALSE]
    /\ todo = [p \in Procs |-> {}]
    /\ blocked = [p \in Procs |-> FALSE]
    /\ blame = [p \in Procs |-> {}]
    /\ attempts = [p \in Procs |-> 0]
    /\ ran = [p \in Procs |-> FALSE]
    /\ kpc = [p \in Procs |-> "none"]
    /\ kneed = [p \in Procs |-> None]

LCheckFirst(l) ==
    /\ Variant = "checkFirst"
    /\ pc[l] = "idle"
    /\ IF heavyHeld # None
          THEN /\ pc' = [pc EXCEPT ![l] = "refused"]
               /\ blame' = [blame EXCEPT ![l] = {heavyHeld}]
          ELSE /\ pc' = [pc EXCEPT ![l] = "checked"]
               /\ UNCHANGED blame
    /\ UNCHANGED <<heavyHeld, lightHeld, lightFile, todo, blocked, attempts, ran, kpc, kneed>>

LClaimOwn(l) ==
    /\ pc[l] = (IF Variant = "checkFirst" THEN "checked" ELSE "idle")
    /\ lightHeld' = [lightHeld EXCEPT ![l] = TRUE]
    /\ lightFile' = [lightFile EXCEPT ![l] = TRUE]
    /\ pc' = [pc EXCEPT ![l] = IF Variant \in {"checkFirst", "noLightCheck"} THEN "ready" ELSE "claimed"]
    /\ UNCHANGED <<heavyHeld, todo, blocked, blame, attempts, ran, kpc, kneed>>

LCheckHeavy(l) ==
    /\ pc[l] = "claimed"
    /\ IF heavyHeld # None
          THEN /\ pc' = [pc EXCEPT ![l] = "refusing"]
               /\ blame' = [blame EXCEPT ![l] = {heavyHeld}]
          ELSE /\ pc' = [pc EXCEPT ![l] = "ready"]
               /\ UNCHANGED blame
    /\ UNCHANGED <<heavyHeld, lightHeld, lightFile, todo, blocked, attempts, ran, kpc, kneed>>

LRefuse(l) ==
    /\ pc[l] = "refusing"
    /\ lightHeld' = [lightHeld EXCEPT ![l] = FALSE]
    /\ lightFile' = [lightFile EXCEPT ![l] = FALSE]
    /\ pc' = [pc EXCEPT ![l] = "refused"]
    /\ UNCHANGED <<heavyHeld, todo, blocked, blame, attempts, ran, kpc, kneed>>

LRun(l) ==
    /\ pc[l] = "ready"
    /\ pc' = [pc EXCEPT ![l] = "running"]
    /\ ran' = [ran EXCEPT ![l] = TRUE]
    /\ UNCHANGED <<heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, kpc, kneed>>

LEnd(l) ==
    /\ pc[l] = "running"
    /\ kpc[l] # "running"
    /\ lightHeld' = [lightHeld EXCEPT ![l] = FALSE]
    /\ lightFile' = [lightFile EXCEPT ![l] = FALSE]
    /\ pc' = [pc EXCEPT ![l] = "done"]
    /\ UNCHANGED <<heavyHeld, todo, blocked, blame, attempts, ran, kpc, kneed>>

HClaimHeavy(h) ==
    /\ pc[h] = "idle"
    /\ IF heavyHeld = None
          THEN /\ heavyHeld' = h
               /\ pc' = [pc EXCEPT ![h] = "claimed"]
               /\ todo' = [todo EXCEPT ![h] = IF Variant = "noHeavyScan" THEN {} ELSE {l \in Lights : lightFile[l]}]
               /\ UNCHANGED blame
          ELSE /\ pc' = [pc EXCEPT ![h] = "refused"]
               /\ blame' = [blame EXCEPT ![h] = {heavyHeld}]
               /\ UNCHANGED <<heavyHeld, todo>>
    /\ UNCHANGED <<lightHeld, lightFile, blocked, attempts, ran, kpc, kneed>>

HScanOne(h, l) ==
    /\ pc[h] = "claimed"
    /\ l \in todo[h]
    /\ todo' = [todo EXCEPT ![h] = @ \ {l}]
    /\ IF lightHeld[l] \/ (Variant = "staleIsLive" /\ lightFile[l])
          THEN /\ blocked' = [blocked EXCEPT ![h] = TRUE]
               /\ blame' = [blame EXCEPT ![h] = IF lightHeld[l] THEN @ \union {l} ELSE @]
               /\ UNCHANGED lightFile
          ELSE /\ lightFile' = [lightFile EXCEPT ![l] = FALSE]
               /\ UNCHANGED <<blocked, blame>>
    /\ UNCHANGED <<pc, heavyHeld, lightHeld, attempts, ran, kpc, kneed>>

HDecide(h) ==
    /\ pc[h] = "claimed"
    /\ todo[h] = {}
    /\ IF blocked[h]
          THEN /\ heavyHeld' = None
               /\ pc' = [pc EXCEPT ![h] = "refused"]
               /\ UNCHANGED ran
          ELSE /\ pc' = [pc EXCEPT ![h] = "running"]
               /\ ran' = [ran EXCEPT ![h] = TRUE]
               /\ UNCHANGED heavyHeld
    /\ UNCHANGED <<lightHeld, lightFile, todo, blocked, blame, attempts, kpc, kneed>>

HEnd(h) ==
    /\ pc[h] = "running"
    /\ kpc[h] # "running"
    /\ heavyHeld' = None
    /\ pc' = [pc EXCEPT ![h] = "done"]
    /\ UNCHANGED <<lightHeld, lightFile, todo, blocked, blame, attempts, ran, kpc, kneed>>

KSpawn(p, c) ==
    /\ Nested
    /\ pc[p] = "running"
    /\ kpc[p] = "none"
    /\ kneed' = [kneed EXCEPT ![p] = c]
    /\ kpc' = [kpc EXCEPT ![p] = IF p \in Heavies \/ c = "light" \/ Variant = "heavyUnderLight" THEN "running" ELSE "refused"]
    /\ UNCHANGED <<pc, heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran>>

KEnd(p) ==
    /\ kpc[p] = "running"
    /\ kpc' = [kpc EXCEPT ![p] = "done"]
    /\ UNCHANGED <<pc, heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, kneed>>

KCrash(p) ==
    /\ kpc[p] = "running"
    /\ kpc' = [kpc EXCEPT ![p] = "dead"]
    /\ UNCHANGED <<pc, heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, kneed>>

Crash(p) ==
    /\ pc[p] \in Alive
    /\ (Variant = "orphan" \/ kpc[p] # "running")
    /\ pc' = [pc EXCEPT ![p] = "dead"]
    /\ heavyHeld' = IF heavyHeld = p /\ Variant # "crashKeeps" THEN None ELSE heavyHeld
    /\ lightHeld' = IF p \in Lights /\ Variant # "crashKeeps" THEN [lightHeld EXCEPT ![p] = FALSE] ELSE lightHeld
    /\ UNCHANGED <<lightFile, todo, blocked, blame, attempts, ran, kpc, kneed>>

Retry(p) ==
    /\ pc[p] = "refused"
    /\ p \in Waiters
    /\ (Variant = "unboundedWait" \/ attempts[p] < MaxAttempts)
    /\ pc' = [pc EXCEPT ![p] = "idle"]
    /\ attempts' = [attempts EXCEPT ![p] = IF Variant = "unboundedWait" THEN @ ELSE @ + 1]
    /\ blocked' = [blocked EXCEPT ![p] = FALSE]
    /\ blame' = [blame EXCEPT ![p] = {}]
    /\ todo' = [todo EXCEPT ![p] = {}]
    /\ UNCHANGED <<heavyHeld, lightHeld, lightFile, ran, kpc, kneed>>

GiveUp(p) ==
    /\ pc[p] = "refused"
    /\ p \in Waiters
    /\ Variant # "unboundedWait"
    /\ attempts[p] = MaxAttempts
    /\ pc' = [pc EXCEPT ![p] = "gaveUp"]
    /\ UNCHANGED <<heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, kpc, kneed>>

Next ==
    \/ \E l \in Lights : LCheckFirst(l) \/ LClaimOwn(l) \/ LCheckHeavy(l) \/ LRefuse(l) \/ LRun(l) \/ LEnd(l)
    \/ \E h \in Heavies : HClaimHeavy(h) \/ HDecide(h) \/ HEnd(h) \/ (\E l \in Lights : HScanOne(h, l))
    \/ \E p \in Procs : Crash(p) \/ Retry(p) \/ GiveUp(p) \/ KEnd(p) \/ KCrash(p) \/ (\E c \in Needs : KSpawn(p, c))

Spec == Init /\ [][Next]_vars

FairSpec == Spec /\ WF_vars(Next)

HeavyAlone ==
    \A h \in Heavies : pc[h] = "running" => \A q \in Procs \ {h} : pc[q] # "running"

Active == {p \in Procs : pc[p] = "running" \/ kpc[p] = "running"}

HeavyActive == {p \in Procs : (p \in Heavies /\ pc[p] = "running") \/ (kpc[p] = "running" /\ kneed[p] = "heavy")}

HeavyAloneIncludingChildren == \A p \in HeavyActive : Active = {p}

LightsExclusive == \A l1, l2 \in Lights : (pc[l1] = "running" /\ pc[l2] = "running") => l1 = l2

RefusedHasCause == \A p \in Procs : pc[p] \in {"refused", "gaveUp"} => blame[p] # {}

RefusedStartedNothing == \A p \in Procs : pc[p] \in {"refused", "gaveUp"} => ~ran[p]

DeadHoldsNothing ==
    \A p \in Procs : pc[p] = "dead" => /\ heavyHeld # p
                                       /\ (p \in Lights => ~lightHeld[p])

WaitBounded == \A p \in Procs : attempts[p] <= (IF p \in Waiters THEN MaxAttempts ELSE 0)

ChildRunsUnderHolder == \A p \in Procs : kpc[p] = "running" => pc[p] = "running"

ChildRefusedOnlyUnderLight == \A p \in Procs : kpc[p] = "refused" => (p \in Lights /\ kneed[p] = "heavy")

BothRefusedOnlyByMutualClaim ==
    \A l \in Lights, h \in Heavies :
        (pc[l] = "refused" /\ pc[h] = "refused") => (h \in blame[l] /\ l \in blame[h])

NotBothRefused ==
    \A l \in Lights, h \in Heavies : ~(pc[l] = "refused" /\ pc[h] = "refused")

NoChildRefused == \A p \in Procs : kpc[p] # "refused"

RetryNeverRuns == \A p \in Procs : attempts[p] > 0 => pc[p] # "running"

Final(p) == pc[p] \in {"done", "dead", "gaveUp"} \/ (pc[p] = "refused" /\ p \notin Waiters)

Termination == <>(\A p \in Procs : Final(p))
=============================================================================
