---------------------------- MODULE RunLock ----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Lights, Heavies, Waiters, MaxAttempts, Nested, Variant

ASSUME Variant \in {"correct", "noLightCheck", "noHeavyScan", "checkFirst", "staleIsLive", "crashKeeps", "orphan", "heavyUnderLight", "unboundedWait", "noWaiterCheck", "staleWaiterIsLive"}
ASSUME Waiters \subseteq (Lights \union Heavies)
ASSUME MaxAttempts \in Nat
ASSUME Nested \in BOOLEAN
ASSUME Lights \cap Heavies = {}

Procs == Lights \union Heavies
None == "none"
Alive == {"idle", "claimed", "checked", "ready", "running", "refusing"}
Phases == Alive \union {"refused", "gaveUp", "done", "dead"}
Needs == {"light", "heavy"}

VARIABLES pc, heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, kpc, kneed,
          waitHeld, waitFile, heldAtWait, deadBlamed

WaitVars == <<waitHeld, waitFile, heldAtWait, deadBlamed>>

vars == <<pc, heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, kpc, kneed, WaitVars>>

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
    /\ waitHeld \in [Heavies -> BOOLEAN]
    /\ waitFile \in [Heavies -> BOOLEAN]
    /\ heldAtWait \in [Heavies -> SUBSET Lights]
    /\ deadBlamed \in [Lights -> BOOLEAN]

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
    /\ waitHeld = [h \in Heavies |-> FALSE]
    /\ waitFile = [h \in Heavies |-> FALSE]
    /\ heldAtWait = [h \in Heavies |-> {}]
    /\ deadBlamed = [l \in Lights |-> FALSE]

LCheckFirst(l) ==
    /\ Variant = "checkFirst"
    /\ pc[l] = "idle"
    /\ IF heavyHeld # None
          THEN /\ pc' = [pc EXCEPT ![l] = "refused"]
               /\ blame' = [blame EXCEPT ![l] = {heavyHeld}]
          ELSE /\ pc' = [pc EXCEPT ![l] = "checked"]
               /\ UNCHANGED blame
    /\ UNCHANGED <<heavyHeld, lightHeld, lightFile, todo, blocked, attempts, ran, kpc, kneed, WaitVars>>

LClaimOwn(l) ==
    /\ pc[l] = (IF Variant = "checkFirst" THEN "checked" ELSE "idle")
    /\ lightHeld' = [lightHeld EXCEPT ![l] = TRUE]
    /\ lightFile' = [lightFile EXCEPT ![l] = TRUE]
    /\ pc' = [pc EXCEPT ![l] = IF Variant \in {"checkFirst", "noLightCheck"} THEN "ready" ELSE "claimed"]
    /\ UNCHANGED <<heavyHeld, todo, blocked, blame, attempts, ran, kpc, kneed, WaitVars>>

LiveWaiters ==
    IF Variant = "noWaiterCheck" THEN {}
    ELSE IF Variant = "staleWaiterIsLive" THEN {h \in Heavies : waitFile[h]}
    ELSE {h \in Heavies : waitHeld[h]}

LCheckHeavy(l) ==
    /\ pc[l] = "claimed"
    /\ IF heavyHeld # None
          THEN /\ pc' = [pc EXCEPT ![l] = "refusing"]
               /\ blame' = [blame EXCEPT ![l] = {heavyHeld}]
               /\ UNCHANGED <<waitFile, deadBlamed>>
          ELSE IF LiveWaiters # {}
          THEN /\ pc' = [pc EXCEPT ![l] = "refusing"]
               /\ blame' = [blame EXCEPT ![l] = LiveWaiters]
               /\ deadBlamed' = [deadBlamed EXCEPT ![l] = \E h \in LiveWaiters : pc[h] = "dead"]
               /\ waitFile' = [h \in Heavies |-> waitFile[h] /\ (waitHeld[h] \/ h \in LiveWaiters)]
          ELSE /\ pc' = [pc EXCEPT ![l] = "ready"]
               /\ waitFile' = [h \in Heavies |-> waitFile[h] /\ waitHeld[h]]
               /\ UNCHANGED <<blame, deadBlamed>>
    /\ UNCHANGED <<heavyHeld, lightHeld, lightFile, todo, blocked, attempts, ran, kpc, kneed, waitHeld, heldAtWait>>

LRefuse(l) ==
    /\ pc[l] = "refusing"
    /\ lightHeld' = [lightHeld EXCEPT ![l] = FALSE]
    /\ lightFile' = [lightFile EXCEPT ![l] = FALSE]
    /\ pc' = [pc EXCEPT ![l] = "refused"]
    /\ UNCHANGED <<heavyHeld, todo, blocked, blame, attempts, ran, kpc, kneed, WaitVars>>

LRun(l) ==
    /\ pc[l] = "ready"
    /\ pc' = [pc EXCEPT ![l] = "running"]
    /\ ran' = [ran EXCEPT ![l] = TRUE]
    /\ UNCHANGED <<heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, kpc, kneed, WaitVars>>

LEnd(l) ==
    /\ pc[l] = "running"
    /\ kpc[l] # "running"
    /\ lightHeld' = [lightHeld EXCEPT ![l] = FALSE]
    /\ lightFile' = [lightFile EXCEPT ![l] = FALSE]
    /\ pc' = [pc EXCEPT ![l] = "done"]
    /\ UNCHANGED <<heavyHeld, todo, blocked, blame, attempts, ran, kpc, kneed, WaitVars>>

HClaimHeavy(h) ==
    /\ pc[h] = "idle"
    /\ IF heavyHeld = None
          THEN /\ heavyHeld' = h
               /\ pc' = [pc EXCEPT ![h] = "claimed"]
               /\ todo' = [todo EXCEPT ![h] = IF Variant = "noHeavyScan" THEN {} ELSE {l \in Lights : lightFile[l]}]
               /\ UNCHANGED blame
          ELSE /\ pc' = [pc EXCEPT ![h] = "refused"]
               /\ blame' = [blame EXCEPT ![h] = {heavyHeld}]
               /\ UNCHANGED <<heavyHeld, todo, WaitVars>>
    /\ UNCHANGED <<lightHeld, lightFile, blocked, attempts, ran, kpc, kneed, WaitVars>>

HScanOne(h, l) ==
    /\ pc[h] = "claimed"
    /\ l \in todo[h]
    /\ todo' = [todo EXCEPT ![h] = @ \ {l}]
    /\ IF lightHeld[l] \/ (Variant = "staleIsLive" /\ lightFile[l])
          THEN /\ blocked' = [blocked EXCEPT ![h] = TRUE]
               /\ blame' = [blame EXCEPT ![h] = IF lightHeld[l] THEN @ \union {l} ELSE @]
               /\ UNCHANGED lightFile
          ELSE /\ lightFile' = [lightFile EXCEPT ![l] = FALSE]
               /\ UNCHANGED <<blocked, blame, WaitVars>>
    /\ UNCHANGED <<pc, heavyHeld, lightHeld, attempts, ran, kpc, kneed, WaitVars>>

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
    /\ waitHeld' = [waitHeld EXCEPT ![h] = IF blocked[h] THEN waitHeld[h] ELSE FALSE]
    /\ waitFile' = [waitFile EXCEPT ![h] = IF blocked[h] THEN waitFile[h] ELSE FALSE]
    /\ UNCHANGED <<lightHeld, lightFile, todo, blocked, blame, attempts, kpc, kneed, heldAtWait, deadBlamed>>

HEnd(h) ==
    /\ pc[h] = "running"
    /\ kpc[h] # "running"
    /\ heavyHeld' = None
    /\ pc' = [pc EXCEPT ![h] = "done"]
    /\ UNCHANGED <<lightHeld, lightFile, todo, blocked, blame, attempts, ran, kpc, kneed, WaitVars>>

KSpawn(p, c) ==
    /\ Nested
    /\ pc[p] = "running"
    /\ kpc[p] = "none"
    /\ kneed' = [kneed EXCEPT ![p] = c]
    /\ kpc' = [kpc EXCEPT ![p] = IF p \in Heavies \/ c = "light" \/ Variant = "heavyUnderLight" THEN "running" ELSE "refused"]
    /\ UNCHANGED <<pc, heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, WaitVars>>

KEnd(p) ==
    /\ kpc[p] = "running"
    /\ kpc' = [kpc EXCEPT ![p] = "done"]
    /\ UNCHANGED <<pc, heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, kneed, WaitVars>>

KCrash(p) ==
    /\ kpc[p] = "running"
    /\ kpc' = [kpc EXCEPT ![p] = "dead"]
    /\ UNCHANGED <<pc, heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, kneed, WaitVars>>

Crash(p) ==
    /\ pc[p] \in Alive
    /\ (Variant = "orphan" \/ kpc[p] # "running")
    /\ pc' = [pc EXCEPT ![p] = "dead"]
    /\ heavyHeld' = IF heavyHeld = p /\ Variant # "crashKeeps" THEN None ELSE heavyHeld
    /\ lightHeld' = IF p \in Lights /\ Variant # "crashKeeps" THEN [lightHeld EXCEPT ![p] = FALSE] ELSE lightHeld
    /\ waitHeld' = IF p \in Heavies /\ Variant # "crashKeeps" THEN [waitHeld EXCEPT ![p] = FALSE] ELSE waitHeld
    /\ UNCHANGED <<lightFile, todo, blocked, blame, attempts, ran, kpc, kneed, waitFile, heldAtWait, deadBlamed>>

HRecordWait(h) ==
    /\ pc[h] = "refused"
    /\ h \in Waiters
    /\ attempts[h] = 0
    /\ (Variant = "unboundedWait" \/ MaxAttempts > 0)
    /\ ~waitFile[h]
    /\ waitHeld' = [waitHeld EXCEPT ![h] = TRUE]
    /\ waitFile' = [waitFile EXCEPT ![h] = TRUE]
    /\ heldAtWait' = [heldAtWait EXCEPT ![h] = {l \in Lights : lightHeld[l]}]
    /\ UNCHANGED <<pc, heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, kpc, kneed, deadBlamed>>

Retry(p) ==
    /\ pc[p] = "refused"
    /\ p \in Waiters
    /\ (p \in Heavies => waitHeld[p])
    /\ (Variant = "unboundedWait" \/ attempts[p] < MaxAttempts)
    /\ pc' = [pc EXCEPT ![p] = "idle"]
    /\ attempts' = [attempts EXCEPT ![p] = IF Variant = "unboundedWait" THEN @ ELSE @ + 1]
    /\ blocked' = [blocked EXCEPT ![p] = FALSE]
    /\ blame' = [blame EXCEPT ![p] = {}]
    /\ todo' = [todo EXCEPT ![p] = {}]
    /\ UNCHANGED <<heavyHeld, lightHeld, lightFile, ran, kpc, kneed, WaitVars>>

GiveUp(p) ==
    /\ pc[p] = "refused"
    /\ p \in Waiters
    /\ Variant # "unboundedWait"
    /\ attempts[p] = MaxAttempts
    /\ (p \in Heavies => (waitHeld[p] \/ MaxAttempts = 0))
    /\ pc' = [pc EXCEPT ![p] = "gaveUp"]
    /\ waitHeld' = IF p \in Heavies THEN [waitHeld EXCEPT ![p] = FALSE] ELSE waitHeld
    /\ waitFile' = IF p \in Heavies THEN [waitFile EXCEPT ![p] = FALSE] ELSE waitFile
    /\ UNCHANGED <<heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, kpc, kneed, heldAtWait, deadBlamed>>

Next ==
    \/ \E l \in Lights : LCheckFirst(l) \/ LClaimOwn(l) \/ LCheckHeavy(l) \/ LRefuse(l) \/ LRun(l) \/ LEnd(l)
    \/ \E h \in Heavies : HClaimHeavy(h) \/ HDecide(h) \/ HEnd(h) \/ HRecordWait(h) \/ (\E l \in Lights : HScanOne(h, l))
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
                                       /\ (p \in Heavies => ~waitHeld[p])

LightsOutWhileWaiting ==
    \A h \in Heavies, l \in Lights : (waitHeld[h] /\ pc[l] \in {"ready", "running"}) => l \in heldAtWait[h]

NoDeadWaiterBlocks == \A l \in Lights : ~deadBlamed[l]

WaiterReleased == \A h \in Heavies : pc[h] \in {"running", "done", "gaveUp"} => ~waitHeld[h] /\ ~waitFile[h]

WaiterFileOnlyOfDead == \A h \in Heavies : (waitFile[h] /\ ~waitHeld[h]) => pc[h] = "dead"

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
