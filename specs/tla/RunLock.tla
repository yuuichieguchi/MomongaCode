---------------------------- MODULE RunLock ----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Lights, Heavies, Waiters, MaxAttempts, Nested, Patient, Variant

ASSUME Variant \in {"correct", "noLightCheck", "noHeavyScan", "checkFirst", "staleIsLive", "crashKeeps", "orphan", "heavyUnderLight", "unboundedWait",
                    "claimBeforeQueue", "lightIgnoresQueue", "clockArrival", "heavyBlocksAllLights", "staleWaiterIsLive", "asBuilt"}
ASSUME Waiters \subseteq (Lights \union Heavies)
ASSUME MaxAttempts \in Nat
ASSUME Nested \in BOOLEAN
ASSUME Patient \in BOOLEAN
ASSUME Lights \cap Heavies = {}

Procs == Lights \union Heavies
None == "none"
Alive == {"idle", "claimed", "checked", "ready", "running", "refusing", "queued", "claimedFirst", "lightQueued"}
Phases == Alive \union {"refused", "gaveUp", "done", "dead"}
Needs == {"light", "heavy"}
Inf == Cardinality(Procs) + 2

VARIABLES pc, heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, kpc, kneed,
          next, arr, waiting, waitFile, snap, overtakeH, overtakeL, deadBlamed

WaitVars == <<next, arr, waiting, waitFile, snap, overtakeH, overtakeL, deadBlamed>>

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
    /\ next \in 1..Inf
    /\ arr \in [Procs -> 0..Inf]
    /\ waiting \in [Procs -> BOOLEAN]
    /\ waitFile \in [Procs -> BOOLEAN]
    /\ snap \in [Procs -> SUBSET Procs]
    /\ overtakeH \in BOOLEAN
    /\ overtakeL \in BOOLEAN
    /\ deadBlamed \in [Procs -> BOOLEAN]

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
    /\ next = 1
    /\ arr = [p \in Procs |-> 0]
    /\ waiting = [p \in Procs |-> FALSE]
    /\ waitFile = [p \in Procs |-> FALSE]
    /\ snap = [p \in Procs |-> {}]
    /\ overtakeH = FALSE
    /\ overtakeL = FALSE
    /\ deadBlamed = [p \in Procs |-> FALSE]

ArrOf(p) == IF arr[p] = 0 THEN Inf ELSE arr[p]

Seen(q) == IF Variant = "staleWaiterIsLive" THEN waitFile[q] ELSE waiting[q]

Earlier(p, classes) == {q \in classes \ {p} : Seen(q) /\ ArrOf(q) < ArrOf(p)}

Queued(q) == arr[q] # 0 /\ pc[q] \in (Alive \union {"refused"}) \ {"running"}

Before(p, classes) == {q \in classes \ {p} : Queued(q) /\ ArrOf(q) < ArrOf(p)}

Met == [q \in Procs |-> waitFile[q] /\ (waiting[q] \/ Variant = "staleWaiterIsLive")]

LightAhead(l) ==
    IF Variant = "lightIgnoresQueue" THEN {}
    ELSE IF Variant = "heavyBlocksAllLights" THEN {h \in Heavies : Seen(h)}
    ELSE Earlier(l, Heavies)

Released(p) == /\ waiting' = [waiting EXCEPT ![p] = FALSE]
               /\ waitFile' = [waitFile EXCEPT ![p] = FALSE]

LCheckFirst(l) ==
    /\ Variant = "checkFirst"
    /\ pc[l] = "idle"
    /\ IF heavyHeld # None
          THEN /\ pc' = [pc EXCEPT ![l] = "refused"]
               /\ blame' = [blame EXCEPT ![l] = {heavyHeld}]
          ELSE /\ pc' = [pc EXCEPT ![l] = "checked"]
               /\ UNCHANGED blame
    /\ UNCHANGED <<heavyHeld, lightHeld, lightFile, todo, blocked, attempts, ran, kpc, kneed, WaitVars>>

LCheckQueue(l) ==
    /\ Variant \notin {"asBuilt", "checkFirst"}
    /\ pc[l] = "idle"
    /\ waitFile' = Met
    /\ IF LightAhead(l) # {}
          THEN /\ pc' = [pc EXCEPT ![l] = "refused"]
               /\ blame' = [blame EXCEPT ![l] = LightAhead(l)]
               /\ deadBlamed' = [deadBlamed EXCEPT ![l] = \E h \in LightAhead(l) : pc[h] = "dead"]
          ELSE /\ pc' = [pc EXCEPT ![l] = "lightQueued"]
               /\ UNCHANGED <<blame, deadBlamed>>
    /\ UNCHANGED <<heavyHeld, lightHeld, lightFile, todo, blocked, attempts, ran, kpc, kneed, next, arr, waiting, snap, overtakeH, overtakeL>>

LClaimOwn(l) ==
    /\ pc[l] = (IF Variant = "checkFirst" THEN "checked" ELSE IF Variant = "asBuilt" THEN "idle" ELSE "lightQueued")
    /\ lightHeld' = [lightHeld EXCEPT ![l] = TRUE]
    /\ lightFile' = [lightFile EXCEPT ![l] = TRUE]
    /\ pc' = [pc EXCEPT ![l] = IF Variant \in {"checkFirst", "noLightCheck"} THEN "ready" ELSE "claimed"]
    /\ UNCHANGED <<heavyHeld, todo, blocked, blame, attempts, ran, kpc, kneed, WaitVars>>

LCheckHeavy(l) ==
    /\ pc[l] = "claimed"
    /\ IF heavyHeld # None
          THEN /\ pc' = [pc EXCEPT ![l] = "refusing"]
               /\ blame' = [blame EXCEPT ![l] = {heavyHeld}]
               /\ UNCHANGED <<waiting, waitFile, overtakeL, deadBlamed>>
          ELSE IF LightAhead(l) # {}
          THEN /\ pc' = [pc EXCEPT ![l] = "refusing"]
               /\ blame' = [blame EXCEPT ![l] = LightAhead(l)]
               /\ deadBlamed' = [deadBlamed EXCEPT ![l] = \E h \in LightAhead(l) : pc[h] = "dead"]
               /\ waitFile' = Met
               /\ UNCHANGED <<waiting, overtakeL>>
          ELSE /\ pc' = [pc EXCEPT ![l] = "ready"]
               /\ overtakeL' = (overtakeL \/ Before(l, Heavies) # {})
               /\ waiting' = [waiting EXCEPT ![l] = FALSE]
               /\ waitFile' = [q \in Procs |-> IF q = l THEN FALSE ELSE Met[q]]
               /\ UNCHANGED <<blame, deadBlamed>>
    /\ UNCHANGED <<heavyHeld, lightHeld, lightFile, todo, blocked, attempts, ran, kpc, kneed, next, arr, snap, overtakeH>>

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

HCheckQueue(h) ==
    /\ pc[h] = (IF Variant = "claimBeforeQueue" THEN "claimedFirst" ELSE "idle")
    /\ waitFile' = Met
    /\ IF Earlier(h, Procs) # {}
          THEN /\ pc' = [pc EXCEPT ![h] = "refused"]
               /\ blame' = [blame EXCEPT ![h] = Earlier(h, Procs)]
               /\ deadBlamed' = [deadBlamed EXCEPT ![h] = \E q \in Earlier(h, Procs) : pc[q] = "dead"]
               /\ heavyHeld' = IF Variant = "claimBeforeQueue" THEN None ELSE heavyHeld
               /\ UNCHANGED <<snap, todo>>
          ELSE /\ pc' = [pc EXCEPT ![h] = IF Variant = "claimBeforeQueue" THEN "claimed" ELSE "queued"]
               /\ snap' = [snap EXCEPT ![h] = Before(h, Procs)]
               /\ todo' = [todo EXCEPT ![h] = IF Variant = "claimBeforeQueue" THEN {l \in Lights : lightFile[l]} ELSE todo[h]]
               /\ UNCHANGED <<blame, deadBlamed, heavyHeld>>
    /\ UNCHANGED <<lightHeld, lightFile, blocked, attempts, ran, kpc, kneed, next, arr, waiting, overtakeH, overtakeL>>

HClaimHeavy(h) ==
    /\ pc[h] = (IF Variant = "claimBeforeQueue" THEN "idle" ELSE "queued")
    /\ IF heavyHeld = None
          THEN /\ heavyHeld' = h
               /\ pc' = [pc EXCEPT ![h] = IF Variant = "claimBeforeQueue" THEN "claimedFirst" ELSE "claimed"]
               /\ todo' = [todo EXCEPT ![h] = IF Variant = "noHeavyScan" THEN {} ELSE {l \in Lights : lightFile[l]}]
               /\ UNCHANGED blame
          ELSE /\ pc' = [pc EXCEPT ![h] = "refused"]
               /\ blame' = [blame EXCEPT ![h] = {heavyHeld}]
               /\ UNCHANGED <<heavyHeld, todo>>
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
               /\ UNCHANGED <<blocked, blame>>
    /\ UNCHANGED <<pc, heavyHeld, lightHeld, attempts, ran, kpc, kneed, WaitVars>>

HDecide(h) ==
    /\ pc[h] = "claimed"
    /\ todo[h] = {}
    /\ IF blocked[h]
          THEN /\ heavyHeld' = None
               /\ pc' = [pc EXCEPT ![h] = "refused"]
               /\ UNCHANGED <<ran, waiting, waitFile, overtakeH>>
          ELSE /\ pc' = [pc EXCEPT ![h] = "running"]
               /\ ran' = [ran EXCEPT ![h] = TRUE]
               /\ overtakeH' = (overtakeH \/ \E q \in snap[h] : Queued(q))
               /\ Released(h)
               /\ UNCHANGED heavyHeld
    /\ UNCHANGED <<lightHeld, lightFile, todo, blocked, blame, attempts, kpc, kneed, next, arr, snap, overtakeL, deadBlamed>>

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
    /\ waiting' = IF Variant # "crashKeeps" THEN [waiting EXCEPT ![p] = FALSE] ELSE waiting
    /\ UNCHANGED <<lightFile, todo, blocked, blame, attempts, ran, kpc, kneed, next, arr, waitFile, snap, overtakeH, overtakeL, deadBlamed>>

EndStalledLight(l) ==
    /\ pc[l] = "running"
    /\ kpc[l] # "running"
    /\ \E q \in Procs : waiting[q]
    /\ pc' = [pc EXCEPT ![l] = "dead"]
    /\ lightHeld' = [lightHeld EXCEPT ![l] = FALSE]
    /\ UNCHANGED <<heavyHeld, lightFile, todo, blocked, blame, attempts, ran, kpc, kneed, WaitVars>>

Record(p) ==
    /\ pc[p] = "refused"
    /\ p \in Waiters
    /\ arr[p] = 0
    /\ (Patient \/ Variant = "unboundedWait" \/ MaxAttempts > 0)
    /\ \E n \in (IF Variant = "clockArrival" THEN {next - 1, next} \cap (1..Inf) ELSE {next}) :
          /\ arr' = [arr EXCEPT ![p] = n]
          /\ next' = IF next < Inf THEN next + 1 ELSE next
    /\ waiting' = [waiting EXCEPT ![p] = Variant # "asBuilt"]
    /\ waitFile' = [waitFile EXCEPT ![p] = Variant # "asBuilt"]
    /\ UNCHANGED <<pc, heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, kpc, kneed, snap, overtakeH, overtakeL, deadBlamed>>

ClaimUnit(p) ==
    /\ Variant = "asBuilt"
    /\ arr[p] # 0
    /\ pc[p] \in Alive \union {"refused"}
    /\ ~waitFile[p]
    /\ ~ran[p]
    /\ waiting' = [waiting EXCEPT ![p] = TRUE]
    /\ waitFile' = [waitFile EXCEPT ![p] = TRUE]
    /\ UNCHANGED <<pc, heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, kpc, kneed, next, arr, snap, overtakeH, overtakeL, deadBlamed>>

Retry(p) ==
    /\ pc[p] = "refused"
    /\ p \in Waiters
    /\ arr[p] # 0
    /\ (Patient \/ Variant = "unboundedWait" \/ attempts[p] < MaxAttempts)
    /\ pc' = [pc EXCEPT ![p] = "idle"]
    /\ attempts' = [attempts EXCEPT ![p] = IF Patient \/ Variant = "unboundedWait" THEN @ ELSE @ + 1]
    /\ blocked' = [blocked EXCEPT ![p] = FALSE]
    /\ blame' = [blame EXCEPT ![p] = {}]
    /\ todo' = [todo EXCEPT ![p] = {}]
    /\ UNCHANGED <<heavyHeld, lightHeld, lightFile, ran, kpc, kneed, WaitVars>>

GiveUp(p) ==
    /\ pc[p] = "refused"
    /\ p \in Waiters
    /\ ~Patient
    /\ Variant # "unboundedWait"
    /\ attempts[p] = MaxAttempts
    /\ (arr[p] # 0 \/ MaxAttempts = 0)
    /\ pc' = [pc EXCEPT ![p] = "gaveUp"]
    /\ Released(p)
    /\ UNCHANGED <<heavyHeld, lightHeld, lightFile, todo, blocked, blame, attempts, ran, kpc, kneed, next, arr, snap, overtakeH, overtakeL, deadBlamed>>

LStep(l) == LCheckFirst(l) \/ LCheckQueue(l) \/ LClaimOwn(l) \/ LCheckHeavy(l) \/ LRefuse(l) \/ LRun(l) \/ LEnd(l)

HStep(h) == HCheckQueue(h) \/ HClaimHeavy(h) \/ HDecide(h) \/ HEnd(h) \/ (\E l \in Lights : HScanOne(h, l))

PStep(p) == Crash(p) \/ Record(p) \/ ClaimUnit(p) \/ Retry(p) \/ GiveUp(p) \/ KEnd(p) \/ KCrash(p) \/ (\E c \in Needs : KSpawn(p, c))

Next ==
    \/ \E l \in Lights : LStep(l) \/ EndStalledLight(l)
    \/ \E h \in Heavies : HStep(h)
    \/ \E p \in Procs : PStep(p)

Spec == Init /\ [][Next]_vars

FairSpec == Spec /\ WF_vars(Next)

ProgressStep(p) ==
    \/ (p \in Lights /\ (LCheckQueue(p) \/ LClaimOwn(p) \/ LCheckHeavy(p) \/ LRefuse(p) \/ LRun(p) \/ LEnd(p)))
    \/ (p \in Heavies /\ HStep(p))
    \/ Record(p) \/ ClaimUnit(p) \/ Retry(p) \/ KEnd(p)

QueueSpec == Spec /\ \A p \in Procs : WF_vars(ProgressStep(p))

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
                                       /\ ~waiting[p]

WaitBounded == \A p \in Procs : attempts[p] <= (IF p \in Waiters THEN MaxAttempts ELSE 0)

ChildRunsUnderHolder == \A p \in Procs : kpc[p] = "running" => pc[p] = "running"

ChildRefusedOnlyUnderLight == \A p \in Procs : kpc[p] = "refused" => (p \in Lights /\ kneed[p] = "heavy")

BothRefusedOnlyByMutualClaim ==
    \A l \in Lights, h \in Heavies :
        (pc[l] = "refused" /\ pc[h] = "refused") => (h \in blame[l] /\ l \in blame[h])

NotBothRefused ==
    \A l \in Lights, h \in Heavies : ~(pc[l] = "refused" /\ pc[h] = "refused")

NoChildRefused == \A p \in Procs : kpc[p] # "refused"

ArrivalUnique == \A p, q \in Procs : (p # q /\ arr[p] # 0 /\ arr[q] # 0) => arr[p] # arr[q]

HeavyInOrder == ~overtakeH

LightInOrder == ~overtakeL

NoOvertake == HeavyInOrder /\ LightInOrder

QueueNoLivelock == \A h \in Heavies : (heavyHeld = h /\ arr[h] # 0) => \A q \in Procs \ {h} : ~(waiting[q] /\ arr[q] < arr[h])

NoDeadWaiterBlocks == \A p \in Procs : ~deadBlamed[p]

WaiterReleased == \A p \in Procs : pc[p] \in {"running", "done", "gaveUp"} => ~waiting[p] /\ ~waitFile[p]

WaiterFileOnlyOfDead == \A p \in Procs : (waitFile[p] /\ ~waiting[p]) => pc[p] = "dead"

NoStarvation == \A p \in Waiters : (arr[p] # 0) ~> (pc[p] \in {"running", "done", "dead"})

RetryNeverRuns == \A p \in Procs : attempts[p] > 0 => pc[p] # "running"

Final(p) == pc[p] \in {"done", "dead", "gaveUp"} \/ (pc[p] = "refused" /\ p \notin Waiters)

Termination == <>(\A p \in Procs : Final(p))
=============================================================================
