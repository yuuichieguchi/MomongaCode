------------------------- MODULE SettingsSwap -------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Ops, AdmitOps, Jobs, MaxV, MaxEdits, MaxCrashes, Underivable, Observer, AbortOps, Swapped, Variant

ASSUME Variant \in {"decided", "restartOnChange", "retireEager", "staleRead", "strictInRun", "sweepWithJob", "splitGate", "lockWait", "lateWake", "parallelDerive", "awaitOlder", "lazyLastGood", "recordFirst", "firstCallerSignal", "recordThrows", "carryByPosition"}
ASSUME AdmitOps \subseteq Ops
ASSUME Ops \cap Jobs = {}
ASSUME MaxV \in Nat \ {0}
ASSUME MaxEdits \in Nat
ASSUME MaxCrashes \in Nat
ASSUME Underivable \subseteq 2..MaxV
ASSUME Observer \in BOOLEAN
ASSUME AbortOps \subseteq Ops
ASSUME Swapped \subseteq 1..MaxV

DerivedObjects == {"D1", "D2", "D3", "D4", "D5"}
InputsD1 == {"models", "network", "pricing", "context.unboundedOutputReserve"}
InputsD2 == {"network", "telemetry"}
InputsD3 == {"sandbox"}
InputsD4 == {"network"}
InputsD5 == {"network", "credentials.plaintextTokenFiles"}

Tg == {"a", "b"}
Pos(t) == IF t = "a" THEN 1 ELSE 2
Order(s, t) == IF s \in Swapped THEN 3 - Pos(t) ELSE Pos(t)
IdAt(s, q) == CHOOSE u \in Tg : Order(s, u) = q

Def(s, t) ==
    IF t = "a"
    THEN (IF s <= 2 THEN 1 ELSE 2)
    ELSE (IF s = 4 THEN 0 ELSE IF s <= 3 THEN 1 ELSE 3)

Net(s) == IF s <= 1 THEN 1 ELSE 2

ObjBound == MaxV * (MaxCrashes + 1 + (IF Variant = "restartOnChange" THEN MaxV ELSE 0))
ObjIds == 1..ObjBound
SrvBound == 2 * ObjBound
SrvIds == 1..SrvBound

VARIABLES diskV, diskBroken, edits, rec, caught, recSeq, recBad, abortHarm, dOwner, lastGood, noted, cacheBroken, up, crashes,
          nObj, cur, oSt, oVer, oGate, oSrv, nGate, nSrv, sSt, sTgt, retiredN,
          deriving, opSt, opObj, opWait, opPin, opNeed, opUsed, opLast, opFloor, jobSt, jobObj,
          cut, gwRefused, badAdmits

fileVars == <<diskV, diskBroken, edits, rec, caught, recSeq, recBad, abortHarm>>
cacheVars == <<lastGood, noted, cacheBroken>>
objVars == <<nObj, cur, oSt, oVer, oGate, oSrv, nGate, nSrv, sTgt, retiredN>>
opVars == <<opSt, opObj, opWait, opPin, opNeed, opUsed, opLast, opFloor>>
jobVars == <<jobSt, jobObj>>
latchVars == <<cut, gwRefused, badAdmits>>
lifeVars == <<up, crashes>>

vars == <<diskV, diskBroken, edits, rec, caught, recSeq, recBad, abortHarm, dOwner, lastGood, noted, cacheBroken, up, crashes,
          nObj, cur, oSt, oVer, oGate, oSrv, nGate, nSrv, sSt, sTgt, retiredN,
          deriving, opSt, opObj, opWait, opPin, opNeed, opUsed, opLast, opFloor, jobSt, jobObj,
          cut, gwRefused, badAdmits>>

OpStates == {"idle", "waiting", "woken", "running", "waitLock", "done", "refused", "aborted"}

TypeOK ==
    /\ diskV \in 1..MaxV
    /\ diskBroken \in BOOLEAN
    /\ edits \in 0..MaxEdits
    /\ rec \in 1..MaxV
    /\ recSeq \in 1..(MaxEdits + 1)
    /\ recBad \in BOOLEAN
    /\ abortHarm \subseteq Ops
    /\ dOwner \in [1..MaxV -> Ops \cup {0}]
    /\ noted \in 1..(MaxEdits + 1)
    /\ opFloor \in [Ops -> 0..MaxV]
    /\ caught \in BOOLEAN
    /\ lastGood \in 1..MaxV
    /\ cacheBroken \in BOOLEAN
    /\ up \in BOOLEAN
    /\ crashes \in 0..MaxCrashes
    /\ nObj \in 1..ObjBound
    /\ cur \in 0..ObjBound
    /\ oSt \in [ObjIds -> {"free", "cur", "old", "retired", "gone"}]
    /\ oVer \in [ObjIds -> 0..MaxV]
    /\ sSt \in [SrvIds -> {"none", "idle", "running", "stopped"}]
    /\ deriving \subseteq 1..MaxV
    /\ opSt \in [Ops -> OpStates]
    /\ opLast \in [Ops -> 0..MaxV]
    /\ jobSt \in [Jobs -> {"none", "live", "exited"}]
    /\ cut \subseteq (Ops \cup Jobs)
    /\ gwRefused \subseteq Ops
    /\ badAdmits \subseteq Ops

Waiters(s) == {q \in Ops : opSt[q] = "waiting" /\ opWait[q] = s}
Holder(o) == {p \in Ops : opSt[p] \in {"running", "waitLock"} /\ opObj[p] = o}
JobHolder(o) == {j \in Jobs : jobSt[j] = "live" /\ jobObj[j] = o}
Holders(o) == Holder(o) \cup JobHolder(o)
Live(o) == oSt[o] \in {"cur", "old"}

SrcKey(s, t, o) == IF Variant = "carryByPosition" THEN IdAt(oVer[o], Order(s, t)) ELSE t
LiveSrc(s, t) == {o \in ObjIds : Live(o) /\ Def(s, t) # 0 /\ Def(oVer[o], SrcKey(s, t, o)) = Def(s, t)}
Src(s, t) == CHOOSE o \in LiveSrc(s, t) : TRUE
Carry(p, s, t) == LiveSrc(s, t) # {}
CarryGate(p, s, t) == Carry(p, s, t) /\ (Variant # "splitGate" \/ Net(s) = Net(oVer[Src(s, t)]))

FreshGates(p, s) == Cardinality({u \in Tg : Def(s, u) # 0 /\ ~CarryGate(p, s, u)})
FreshSrvs(p, s) == Cardinality({u \in Tg : Def(s, u) # 0 /\ ~Carry(p, s, u)})

GateOf(p, s, t) ==
    IF Def(s, t) = 0 THEN 0
    ELSE IF CarryGate(p, s, t) THEN oGate[Src(s, t)][SrcKey(s, t, Src(s, t))]
    ELSE nGate + Cardinality({u \in Tg : Order(s, u) <= Order(s, t) /\ Def(s, u) # 0 /\ ~CarryGate(p, s, u)})

SrvOf(p, s, t) ==
    IF Def(s, t) = 0 THEN 0
    ELSE IF Carry(p, s, t) THEN oSrv[Src(s, t)][SrcKey(s, t, Src(s, t))]
    ELSE nSrv + Cardinality({u \in Tg : Order(s, u) <= Order(s, t) /\ Def(s, u) # 0 /\ ~Carry(p, s, u)})

NewSrvState(p, s) == [x \in SrvIds |-> IF x > nSrv /\ x <= nSrv + FreshSrvs(p, s) THEN "idle" ELSE sSt[x]]
NewSrvTgt(p, s) == [x \in SrvIds |-> IF x > nSrv /\ x <= nSrv + FreshSrvs(p, s) THEN CHOOSE u \in Tg : SrvOf(p, s, u) = x ELSE sTgt[x]]

StopUnref(oStN, oSrvN, sStM, o) ==
    [x \in SrvIds |->
        IF sStM[x] \in {"idle", "running"}
           /\ (\E t \in Tg : oSrvN[o][t] = x)
           /\ ~(\E q \in ObjIds : oStN[q] \in {"cur", "old"} /\ \E t \in Tg : oSrvN[q][t] = x)
        THEN "stopped"
        ELSE sStM[x]]

Init ==
    /\ diskV = 1 /\ diskBroken = FALSE /\ edits = 0
    /\ rec = 1 /\ caught = Observer /\ recSeq = 1 /\ noted = 1 /\ recBad = FALSE /\ abortHarm = {} /\ dOwner = [v \in 1..MaxV |-> 0]
    /\ lastGood = 1 /\ cacheBroken = FALSE
    /\ up = TRUE /\ crashes = 0
    /\ nObj = 1 /\ cur = 1
    /\ oSt = [o \in ObjIds |-> IF o = 1 THEN "cur" ELSE "free"]
    /\ oVer = [o \in ObjIds |-> IF o = 1 THEN 1 ELSE 0]
    /\ oGate = [o \in ObjIds |-> [t \in Tg |-> IF o = 1 /\ Def(1, t) # 0 THEN Order(1, t) ELSE 0]]
    /\ oSrv = [o \in ObjIds |-> [t \in Tg |-> IF o = 1 /\ Def(1, t) # 0 THEN Order(1, t) ELSE 0]]
    /\ nGate = 2 /\ nSrv = 2
    /\ sSt = [x \in SrvIds |-> IF x <= 2 THEN "idle" ELSE "none"]
    /\ sTgt = [x \in SrvIds |-> IF x = 1 THEN "a" ELSE IF x = 2 THEN "b" ELSE "none"]
    /\ retiredN = [o \in ObjIds |-> 0]
    /\ deriving = {}
    /\ opSt = [p \in Ops |-> "idle"]
    /\ opObj = [p \in Ops |-> 0]
    /\ opWait = [p \in Ops |-> 0]
    /\ opPin = [p \in Ops |-> 0]
    /\ opNeed = [p \in Ops |-> 0]
    /\ opUsed = [p \in Ops |-> {}]
    /\ opLast = [p \in Ops |-> 0]
    /\ opFloor = [p \in Ops |-> 0]
    /\ jobSt = [j \in Jobs |-> "none"]
    /\ jobObj = [j \in Jobs |-> 0]
    /\ cut = {} /\ gwRefused = {} /\ badAdmits = {}

WriteValid ==
    /\ edits < MaxEdits /\ diskV < MaxV
    /\ diskV' = diskV + 1 /\ diskBroken' = FALSE /\ edits' = edits + 1
    /\ caught' = FALSE /\ rec' = rec /\ recSeq' = recSeq /\ recBad' = recBad /\ abortHarm' = abortHarm
    /\ UNCHANGED <<cacheVars, lifeVars, objVars, sSt, deriving, dOwner, opVars, jobVars, latchVars>>

WriteBroken ==
    /\ edits < MaxEdits /\ ~diskBroken
    /\ diskBroken' = TRUE /\ edits' = edits + 1
    /\ UNCHANGED <<diskV, rec, caught, recSeq, recBad, abortHarm, cacheVars, lifeVars, objVars, sSt, deriving, dOwner, opVars, jobVars, latchVars>>

Observe ==
    /\ Observer /\ ~diskBroken /\ (rec # diskV \/ ~caught \/ recBad)
    /\ rec' = diskV /\ caught' = TRUE /\ recBad' = FALSE
    /\ recSeq' = IF rec # diskV THEN recSeq + 1 ELSE recSeq
    /\ UNCHANGED <<diskV, diskBroken, edits, abortHarm, cacheVars, lifeVars, objVars, sSt, deriving, dOwner, opVars, jobVars, latchVars>>

CorruptRecord ==
    /\ Observer /\ ~recBad
    /\ recBad' = TRUE /\ caught' = FALSE
    /\ UNCHANGED <<diskV, diskBroken, edits, rec, recSeq, abortHarm, cacheVars, lifeVars, objVars, sSt, deriving, dOwner, opVars, jobVars, latchVars>>

TakesRecord == Observer /\ ~recBad /\ Variant # "lazyLastGood" /\ (Variant = "recordFirst" \/ recSeq > noted)
RefreshedGood ==
    IF Variant = "staleRead" THEN lastGood
    ELSE IF ~diskBroken THEN diskV
    ELSE IF TakesRecord THEN rec
    ELSE lastGood
NotedNew == IF Variant = "staleRead" THEN noted ELSE IF ~diskBroken \/ TakesRecord THEN recSeq ELSE noted
MaxPin == LET ps == {opPin[q] : q \in {x \in Ops : opSt[x] \in {"running", "woken", "waitLock", "done"}}} IN IF ps = {} THEN 0 ELSE CHOOSE m \in ps : \A x \in ps : x <= m
Last == IF diskBroken /\ caught /\ diskV \notin Underivable THEN diskV ELSE 0
RefreshedBroken == IF Variant = "staleRead" THEN cacheBroken ELSE diskBroken
NeedWaiter == IF RefreshedGood \in Underivable THEN 0 ELSE RefreshedGood
NeedNow == IF ~diskBroken /\ diskV \notin Underivable THEN diskV ELSE 0
Refuses(p) == RefreshedBroken /\ (p \in AdmitOps \/ Variant = "strictInRun" \/ (Variant = "recordThrows" /\ diskBroken /\ Observer /\ recBad))

StartRefuse(p) ==
    /\ up /\ opSt[p] = "idle" /\ Refuses(p)
    /\ lastGood' = RefreshedGood /\ noted' = NotedNew /\ cacheBroken' = RefreshedBroken
    /\ opSt' = [opSt EXCEPT ![p] = "refused"]
    /\ gwRefused' = IF p \in AdmitOps THEN gwRefused ELSE gwRefused \cup {p}
    /\ UNCHANGED <<fileVars, lifeVars, objVars, sSt, deriving, dOwner, opObj, opWait, opPin, opNeed, opUsed, opLast, opFloor, jobVars, cut, badAdmits>>

StartDirect(p) ==
    /\ up /\ opSt[p] = "idle" /\ ~Refuses(p)
    /\ RefreshedGood = oVer[cur]
    /\ lastGood' = RefreshedGood /\ noted' = NotedNew /\ cacheBroken' = RefreshedBroken
    /\ opSt' = [opSt EXCEPT ![p] = "running"]
    /\ opObj' = [opObj EXCEPT ![p] = cur]
    /\ opPin' = [opPin EXCEPT ![p] = oVer[cur]]
    /\ opNeed' = [opNeed EXCEPT ![p] = NeedNow]
    /\ opLast' = [opLast EXCEPT ![p] = Last] /\ opFloor' = [opFloor EXCEPT ![p] = MaxPin]
    /\ badAdmits' = IF p \in AdmitOps /\ (diskBroken \/ RefreshedGood \in Underivable) THEN badAdmits \cup {p} ELSE badAdmits
    /\ UNCHANGED <<fileVars, lifeVars, objVars, sSt, deriving, dOwner, opWait, opUsed, jobVars, cut, gwRefused>>

StartJoin(p, s) ==
    /\ up /\ opSt[p] = "idle" /\ ~Refuses(p)
    /\ RefreshedGood # oVer[cur]
    /\ s \in deriving
    /\ (s = RefreshedGood \/ Variant = "awaitOlder")
    /\ lastGood' = RefreshedGood /\ noted' = NotedNew /\ cacheBroken' = RefreshedBroken
    /\ opSt' = [opSt EXCEPT ![p] = "waiting"]
    /\ opWait' = [opWait EXCEPT ![p] = s]
    /\ opNeed' = [opNeed EXCEPT ![p] = NeedWaiter]
    /\ opLast' = [opLast EXCEPT ![p] = Last] /\ opFloor' = [opFloor EXCEPT ![p] = MaxPin]
    /\ UNCHANGED <<fileVars, lifeVars, objVars, sSt, deriving, dOwner, opObj, opPin, opUsed, jobVars, latchVars>>

StartQueue(p) ==
    /\ Variant # "awaitOlder"
    /\ up /\ opSt[p] = "idle" /\ ~Refuses(p)
    /\ RefreshedGood # oVer[cur]
    /\ deriving # {} /\ RefreshedGood \notin deriving
    /\ lastGood' = RefreshedGood /\ noted' = NotedNew /\ cacheBroken' = RefreshedBroken
    /\ opSt' = [opSt EXCEPT ![p] = "waiting"]
    /\ opWait' = [opWait EXCEPT ![p] = RefreshedGood]
    /\ opNeed' = [opNeed EXCEPT ![p] = NeedWaiter]
    /\ opLast' = [opLast EXCEPT ![p] = Last] /\ opFloor' = [opFloor EXCEPT ![p] = MaxPin]
    /\ UNCHANGED <<fileVars, lifeVars, objVars, sSt, deriving, dOwner, opObj, opPin, opUsed, jobVars, latchVars>>

StartDerive(p) ==
    /\ up /\ opSt[p] = "idle" /\ ~Refuses(p)
    /\ RefreshedGood # oVer[cur]
    /\ RefreshedGood \notin deriving
    /\ (deriving = {} \/ Variant = "parallelDerive")
    /\ lastGood' = RefreshedGood /\ noted' = NotedNew /\ cacheBroken' = RefreshedBroken
    /\ deriving' = deriving \cup {RefreshedGood}
    /\ dOwner' = [dOwner EXCEPT ![RefreshedGood] = p]
    /\ opSt' = [opSt EXCEPT ![p] = "waiting"]
    /\ opWait' = [opWait EXCEPT ![p] = RefreshedGood]
    /\ opNeed' = [opNeed EXCEPT ![p] = NeedWaiter]
    /\ opLast' = [opLast EXCEPT ![p] = Last] /\ opFloor' = [opFloor EXCEPT ![p] = MaxPin]
    /\ UNCHANGED <<fileVars, lifeVars, objVars, sSt, opObj, opPin, opUsed, jobVars, latchVars>>

BeginDerive(s) ==
    /\ up /\ deriving = {} /\ s # oVer[cur]
    /\ Waiters(s) # {}
    /\ deriving' = {s}
    /\ dOwner' = [dOwner EXCEPT ![s] = CHOOSE q \in Waiters(s) : TRUE]
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, objVars, sSt, opVars, jobVars, latchVars>>

DeriveOk(s) ==
    LET p == cur
        n == nObj + 1
        eager == Variant = "retireEager"
        oStA == [oSt EXCEPT ![n] = "cur", ![p] = IF eager THEN "retired" ELSE "old"]
        oSrvA == [oSrv EXCEPT ![n] = [t \in Tg |-> SrvOf(p, s, t)]]
        sStA == NewSrvState(p, s)
        woke == IF Variant = "lateWake" THEN "woken" ELSE "running"
    IN /\ s \notin Underivable
       /\ nObj < ObjBound
       /\ nObj' = n
       /\ cur' = n
       /\ oSt' = oStA
       /\ oVer' = [oVer EXCEPT ![n] = s]
       /\ oGate' = [oGate EXCEPT ![n] = [t \in Tg |-> GateOf(p, s, t)]]
       /\ oSrv' = oSrvA
       /\ nGate' = nGate + FreshGates(p, s)
       /\ nSrv' = nSrv + FreshSrvs(p, s)
       /\ sTgt' = NewSrvTgt(p, s)
       /\ sSt' = IF eager THEN StopUnref(oStA, oSrvA, sStA, p) ELSE sStA
       /\ retiredN' = IF eager THEN [retiredN EXCEPT ![p] = @ + 1] ELSE retiredN
       /\ cut' = IF eager THEN cut \cup Holders(p) ELSE cut
       /\ opSt' = [q \in Ops |-> IF q \in Waiters(s) THEN woke ELSE opSt[q]]
       /\ opObj' = [q \in Ops |-> IF q \in Waiters(s) THEN n ELSE opObj[q]]
       /\ opPin' = [q \in Ops |-> IF q \in Waiters(s) THEN s ELSE opPin[q]]

DeriveFails(s) ==
    /\ s \in Underivable
    /\ opSt' = [q \in Ops |-> IF q \in Waiters(s) THEN (IF q \in AdmitOps THEN "refused" ELSE "running") ELSE opSt[q]]
    /\ opObj' = [q \in Ops |-> IF q \in Waiters(s) THEN cur ELSE opObj[q]]
    /\ opPin' = [q \in Ops |-> IF q \in Waiters(s) THEN oVer[cur] ELSE opPin[q]]
    /\ UNCHANGED <<objVars, sSt, cut>>

FinishDerive(s) ==
    /\ up /\ s \in deriving
    /\ deriving' = deriving \ {s}
    /\ dOwner' = [dOwner EXCEPT ![s] = 0]
    /\ \/ DeriveOk(s)
       \/ DeriveFails(s)
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, opWait, opNeed, opUsed, opLast, opFloor, jobVars, gwRefused, badAdmits>>

Abort(p) ==
    /\ p \in AbortOps /\ opSt[p] = "waiting"
    /\ LET s == opWait[p]
           flightDies == Variant = "firstCallerSignal" /\ s \in deriving /\ dOwner[s] = p
           others == Waiters(s) \ {p}
       IN /\ opSt' = [q \in Ops |-> IF q = p THEN "aborted" ELSE IF flightDies /\ q \in others THEN (IF q \in AdmitOps THEN "refused" ELSE "running") ELSE opSt[q]]
          /\ opObj' = [q \in Ops |-> IF flightDies /\ q \in others THEN cur ELSE opObj[q]]
          /\ opPin' = [q \in Ops |-> IF flightDies /\ q \in others THEN oVer[cur] ELSE opPin[q]]
          /\ deriving' = IF flightDies THEN deriving \ {s} ELSE deriving
          /\ dOwner' = IF flightDies THEN [dOwner EXCEPT ![s] = 0] ELSE dOwner
          /\ abortHarm' = IF flightDies THEN abortHarm \cup others ELSE abortHarm
    /\ UNCHANGED <<diskV, diskBroken, edits, rec, caught, recSeq, recBad, cacheVars, lifeVars, objVars, sSt, opWait, opNeed, opUsed, opLast, opFloor, jobVars, latchVars>>

Wake(q) ==
    /\ opSt[q] = "woken"
    /\ opSt' = [opSt EXCEPT ![q] = "running"]
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, objVars, sSt, deriving, dOwner, opObj, opWait, opPin, opNeed, opUsed, opLast, opFloor, jobVars, latchVars>>

Reap(o) ==
    /\ oSt[o] = "old"
    /\ IF Variant = "sweepWithJob" THEN Holder(o) = {} ELSE Holders(o) = {}
    /\ oSt' = [oSt EXCEPT ![o] = "retired"]
    /\ retiredN' = [retiredN EXCEPT ![o] = @ + 1]
    /\ sSt' = StopUnref([oSt EXCEPT ![o] = "retired"], oSrv, sSt, o)
    /\ cut' = cut \cup Holders(o)
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, nObj, cur, oVer, oGate, oSrv, nGate, nSrv, sTgt, deriving, dOwner, opVars, jobVars, gwRefused, badAdmits>>

Blocked(s, t) == Variant = "lockWait" /\ \E x \in SrvIds : x # s /\ sTgt[x] = t /\ sSt[x] = "running"

Use(p, t) ==
    /\ opSt[p] = "running"
    /\ LET o == opObj[p]
           s == oSrv[o][t]
           mark == IF oSt[o] = "retired" THEN 0 ELSE oVer[o]
       IN /\ opUsed' = [opUsed EXCEPT ![p] = @ \cup {mark}]
          /\ \/ /\ s = 0
                /\ UNCHANGED <<sSt, opSt, opWait, cut>>
             \/ /\ s # 0 /\ sSt[s] = "running"
                /\ UNCHANGED <<sSt, opSt, opWait, cut>>
             \/ /\ s # 0 /\ sSt[s] = "idle" /\ ~Blocked(s, t)
                /\ sSt' = [sSt EXCEPT ![s] = "running"]
                /\ UNCHANGED <<opSt, opWait, cut>>
             \/ /\ s # 0 /\ sSt[s] = "idle" /\ Blocked(s, t)
                /\ opSt' = [opSt EXCEPT ![p] = "waitLock"]
                /\ opWait' = [opWait EXCEPT ![p] = s]
                /\ UNCHANGED <<sSt, cut>>
             \/ /\ s # 0 /\ sSt[s] = "stopped"
                /\ cut' = cut \cup {p}
                /\ UNCHANGED <<sSt, opSt, opWait>>
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, objVars, deriving, dOwner, opObj, opPin, opNeed, opLast, opFloor, jobVars, gwRefused, badAdmits>>

LockStart(p) ==
    /\ opSt[p] = "waitLock"
    /\ LET s == opWait[p]
       IN /\ ~Blocked(s, sTgt[s])
          /\ sSt[s] = "idle"
          /\ sSt' = [sSt EXCEPT ![s] = "running"]
    /\ opSt' = [opSt EXCEPT ![p] = "running"]
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, objVars, deriving, dOwner, opObj, opWait, opPin, opNeed, opUsed, opLast, opFloor, jobVars, latchVars>>

Finish(p) ==
    /\ opSt[p] = "running"
    /\ opSt' = [opSt EXCEPT ![p] = "done"]
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, objVars, sSt, deriving, dOwner, opObj, opWait, opPin, opNeed, opUsed, opLast, opFloor, jobVars, latchVars>>

Spawn(p, j) ==
    /\ opSt[p] = "running" /\ jobSt[j] = "none"
    /\ jobSt' = [jobSt EXCEPT ![j] = "live"]
    /\ jobObj' = [jobObj EXCEPT ![j] = opObj[p]]
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, objVars, sSt, deriving, dOwner, opVars, latchVars>>

JobExit(j) ==
    /\ jobSt[j] = "live"
    /\ jobSt' = [jobSt EXCEPT ![j] = "exited"]
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, objVars, sSt, deriving, dOwner, opVars, jobObj, latchVars>>

ProcessDown ==
    /\ up' = FALSE
    /\ opSt' = [q \in Ops |-> IF opSt[q] \in {"waiting", "woken", "running", "waitLock"} THEN "done" ELSE opSt[q]]
    /\ jobSt' = [j \in Jobs |-> IF jobSt[j] = "live" THEN "exited" ELSE jobSt[j]]
    /\ oSt' = [o \in ObjIds |-> IF oSt[o] \in {"cur", "old"} THEN "gone" ELSE oSt[o]]
    /\ cur' = 0
    /\ sSt' = [x \in SrvIds |-> IF sSt[x] \in {"idle", "running"} THEN "stopped" ELSE sSt[x]]
    /\ deriving' = {}
    /\ dOwner' = [v \in 1..MaxV |-> 0]

Crash ==
    /\ up /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ ProcessDown
    /\ UNCHANGED <<fileVars, cacheVars, nObj, oVer, oGate, oSrv, nGate, nSrv, sTgt, retiredN, opObj, opWait, opPin, opNeed, opUsed, opLast, opFloor, jobObj, latchVars>>

SupervisorRestart ==
    /\ Variant = "restartOnChange"
    /\ up /\ ~diskBroken /\ diskV # oVer[cur]
    /\ cut' = cut \cup {q \in Ops : opSt[q] \in {"running", "waitLock"}} \cup {j \in Jobs : jobSt[j] = "live"}
    /\ ProcessDown
    /\ UNCHANGED <<fileVars, cacheVars, crashes, nObj, oVer, oGate, oSrv, nGate, nSrv, sTgt, retiredN, opObj, opWait, opPin, opNeed, opUsed, opLast, opFloor, jobObj, gwRefused, badAdmits>>

Restart ==
    /\ ~up /\ ~diskBroken /\ diskV \notin Underivable
    /\ nObj < ObjBound
    /\ LET n == nObj + 1 IN
       /\ up' = TRUE
       /\ nObj' = n
       /\ cur' = n
       /\ oSt' = [oSt EXCEPT ![n] = "cur"]
       /\ oVer' = [oVer EXCEPT ![n] = diskV]
       /\ oGate' = [oGate EXCEPT ![n] = [t \in Tg |-> GateOf(0, diskV, t)]]
       /\ oSrv' = [oSrv EXCEPT ![n] = [t \in Tg |-> SrvOf(0, diskV, t)]]
       /\ nGate' = nGate + FreshGates(0, diskV)
       /\ nSrv' = nSrv + FreshSrvs(0, diskV)
       /\ sSt' = NewSrvState(0, diskV)
       /\ sTgt' = NewSrvTgt(0, diskV)
       /\ lastGood' = diskV /\ noted' = recSeq /\ cacheBroken' = FALSE
    /\ UNCHANGED <<fileVars, crashes, retiredN, deriving, dOwner, opVars, jobVars, latchVars>>

Next ==
    \/ WriteValid
    \/ WriteBroken
    \/ Observe
    \/ CorruptRecord
    \/ \E p \in Ops : Abort(p)
    \/ \E p \in Ops : StartRefuse(p) \/ StartDirect(p) \/ StartDerive(p) \/ StartQueue(p) \/ Finish(p) \/ Wake(p) \/ LockStart(p)
    \/ \E p \in Ops, s \in 1..MaxV : StartJoin(p, s)
    \/ \E s \in 1..MaxV : FinishDerive(s) \/ BeginDerive(s)
    \/ \E o \in ObjIds : Reap(o)
    \/ \E p \in Ops, t \in Tg : Use(p, t)
    \/ \E p \in Ops, j \in Jobs : Spawn(p, j)
    \/ \E j \in Jobs : JobExit(j)
    \/ Crash
    \/ SupervisorRestart
    \/ Restart
    \/ UNCHANGED vars

Spec == Init /\ [][Next]_vars

PinStable ==
    \A p \in Ops : opSt[p] \in {"running", "waitLock"} => (opUsed[p] \subseteq {opPin[p]} /\ oVer[opObj[p]] = opPin[p])

FreshStart ==
    /\ \A p \in Ops : opSt[p] \in {"running", "waitLock", "woken"} => opNeed[p] <= opPin[p]
    /\ \A p \in Ops : opSt[p] # "waitLock"

NoCut ==
    /\ cut = {}
    /\ \A p \in Ops : opSt[p] \in {"running", "waitLock"} => \A t \in Tg : oSrv[opObj[p]][t] # 0 => sSt[oSrv[opObj[p]][t]] # "stopped"
    /\ \A j \in Jobs : jobSt[j] = "live" => \A t \in Tg : oSrv[jobObj[j]][t] # 0 => sSt[oSrv[jobObj[j]][t]] # "stopped"

LastValidWins == \A p \in Ops : opSt[p] \in {"running", "waitLock", "woken"} => opLast[p] <= opPin[p]

NoRollbackAfterApply == \A p \in Ops : opSt[p] \in {"running", "woken", "waitLock", "done"} /\ opPin[p] # 0 => opFloor[p] <= opPin[p]

AbortIsolated == abortHarm = {}

InvalidKeepsRunning == gwRefused = {} /\ badAdmits = {}

NoRetireInUse == \A o \in ObjIds : oSt[o] = "retired" => Holders(o) = {}

NoSweepWhileHeld == \A j \in Jobs : jobSt[j] = "live" => oSt[jobObj[j]] # "retired"

RetireOnce == \A o \in ObjIds : retiredN[o] <= 1

CarryOverByIdentity ==
    \A o1, o2 \in ObjIds : (Live(o1) /\ Live(o2)) =>
        \A t \in Tg :
            /\ (Def(oVer[o1], t) # 0 /\ Def(oVer[o1], t) = Def(oVer[o2], t)) => (oGate[o1][t] = oGate[o2][t] /\ oSrv[o1][t] = oSrv[o2][t])
            /\ (Def(oVer[o1], t) # 0 /\ Def(oVer[o2], t) # 0 /\ Def(oVer[o1], t) # Def(oVer[o2], t)) => (oGate[o1][t] # oGate[o2][t] /\ oSrv[o1][t] # oSrv[o2][t])

SingleDerivation == Cardinality(deriving) <= 1

=============================================================================
