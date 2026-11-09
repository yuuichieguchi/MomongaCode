------------------------- MODULE SettingsSwap -------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Ops, AdmitOps, Jobs, MaxV, MaxEdits, MaxCrashes, Underivable, Variant

ASSUME Variant \in {"decided", "restartOnChange", "retireEager", "staleRead", "strictInRun", "sweepWithJob", "splitGate", "lockWait", "lateWake", "parallelDerive", "awaitOlder"}
ASSUME AdmitOps \subseteq Ops
ASSUME Ops \cap Jobs = {}
ASSUME MaxV \in Nat \ {0}
ASSUME MaxEdits \in Nat
ASSUME MaxCrashes \in Nat
ASSUME Underivable \subseteq 2..MaxV

DerivedObjects == {"D1", "D2", "D3", "D4"}
InputsD1 == {"models", "network", "pricing"}
InputsD2 == {"network", "telemetry"}
InputsD3 == {"sandbox"}
InputsD4 == {"network"}

Tg == {"a", "b"}
Pos(t) == IF t = "a" THEN 1 ELSE 2

Def(s, t) ==
    IF t = "a"
    THEN (IF s <= 2 THEN 1 ELSE 2)
    ELSE (IF s = 4 THEN 0 ELSE IF s <= 3 THEN 1 ELSE 3)

Net(s) == IF s <= 1 THEN 1 ELSE 2

ObjBound == MaxV * (MaxCrashes + 1 + (IF Variant = "restartOnChange" THEN MaxV ELSE 0))
ObjIds == 1..ObjBound
SrvBound == 2 * ObjBound
SrvIds == 1..SrvBound

VARIABLES diskV, diskBroken, edits, lastGood, cacheBroken, up, crashes,
          nObj, cur, oSt, oVer, oGate, oSrv, nGate, nSrv, sSt, sTgt, retiredN,
          deriving, opSt, opObj, opWait, opPin, opNeed, opUsed, jobSt, jobObj,
          cut, gwRefused, badAdmits

fileVars == <<diskV, diskBroken, edits>>
cacheVars == <<lastGood, cacheBroken>>
objVars == <<nObj, cur, oSt, oVer, oGate, oSrv, nGate, nSrv, sTgt, retiredN>>
opVars == <<opSt, opObj, opWait, opPin, opNeed, opUsed>>
jobVars == <<jobSt, jobObj>>
latchVars == <<cut, gwRefused, badAdmits>>
lifeVars == <<up, crashes>>

vars == <<diskV, diskBroken, edits, lastGood, cacheBroken, up, crashes,
          nObj, cur, oSt, oVer, oGate, oSrv, nGate, nSrv, sSt, sTgt, retiredN,
          deriving, opSt, opObj, opWait, opPin, opNeed, opUsed, jobSt, jobObj,
          cut, gwRefused, badAdmits>>

OpStates == {"idle", "waiting", "woken", "running", "waitLock", "done", "refused"}

TypeOK ==
    /\ diskV \in 1..MaxV
    /\ diskBroken \in BOOLEAN
    /\ edits \in 0..MaxEdits
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
    /\ jobSt \in [Jobs -> {"none", "live", "exited"}]
    /\ cut \subseteq (Ops \cup Jobs)
    /\ gwRefused \subseteq Ops
    /\ badAdmits \subseteq Ops

Waiters(s) == {q \in Ops : opSt[q] = "waiting" /\ opWait[q] = s}
Holder(o) == {p \in Ops : opSt[p] \in {"running", "waitLock"} /\ opObj[p] = o}
JobHolder(o) == {j \in Jobs : jobSt[j] = "live" /\ jobObj[j] = o}
Holders(o) == Holder(o) \cup JobHolder(o)
Live(o) == oSt[o] \in {"cur", "old"}

HasPrev(p) == p \in ObjIds /\ oSt[p] = "cur"
Carry(p, s, t) == HasPrev(p) /\ Def(s, t) # 0 /\ Def(oVer[p], t) = Def(s, t)
CarryGate(p, s, t) == Carry(p, s, t) /\ (Variant # "splitGate" \/ Net(s) = Net(oVer[p]))

FreshGates(p, s) == Cardinality({u \in Tg : Def(s, u) # 0 /\ ~CarryGate(p, s, u)})
FreshSrvs(p, s) == Cardinality({u \in Tg : Def(s, u) # 0 /\ ~Carry(p, s, u)})

GateOf(p, s, t) ==
    IF Def(s, t) = 0 THEN 0
    ELSE IF CarryGate(p, s, t) THEN oGate[p][t]
    ELSE nGate + Cardinality({u \in Tg : Pos(u) <= Pos(t) /\ Def(s, u) # 0 /\ ~CarryGate(p, s, u)})

SrvOf(p, s, t) ==
    IF Def(s, t) = 0 THEN 0
    ELSE IF Carry(p, s, t) THEN oSrv[p][t]
    ELSE nSrv + Cardinality({u \in Tg : Pos(u) <= Pos(t) /\ Def(s, u) # 0 /\ ~Carry(p, s, u)})

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
    /\ lastGood = 1 /\ cacheBroken = FALSE
    /\ up = TRUE /\ crashes = 0
    /\ nObj = 1 /\ cur = 1
    /\ oSt = [o \in ObjIds |-> IF o = 1 THEN "cur" ELSE "free"]
    /\ oVer = [o \in ObjIds |-> IF o = 1 THEN 1 ELSE 0]
    /\ oGate = [o \in ObjIds |-> [t \in Tg |-> IF o = 1 /\ Def(1, t) # 0 THEN Pos(t) ELSE 0]]
    /\ oSrv = [o \in ObjIds |-> [t \in Tg |-> IF o = 1 /\ Def(1, t) # 0 THEN Pos(t) ELSE 0]]
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
    /\ jobSt = [j \in Jobs |-> "none"]
    /\ jobObj = [j \in Jobs |-> 0]
    /\ cut = {} /\ gwRefused = {} /\ badAdmits = {}

WriteValid ==
    /\ edits < MaxEdits /\ diskV < MaxV
    /\ diskV' = diskV + 1 /\ diskBroken' = FALSE /\ edits' = edits + 1
    /\ UNCHANGED <<cacheVars, lifeVars, objVars, sSt, deriving, opVars, jobVars, latchVars>>

WriteBroken ==
    /\ edits < MaxEdits /\ ~diskBroken
    /\ diskBroken' = TRUE /\ edits' = edits + 1
    /\ UNCHANGED <<diskV, cacheVars, lifeVars, objVars, sSt, deriving, opVars, jobVars, latchVars>>

RefreshedGood == IF Variant = "staleRead" \/ diskBroken THEN lastGood ELSE diskV
RefreshedBroken == IF Variant = "staleRead" THEN cacheBroken ELSE diskBroken
NeedWaiter == IF RefreshedGood \in Underivable THEN 0 ELSE RefreshedGood
NeedNow == IF ~diskBroken /\ diskV \notin Underivable THEN diskV ELSE 0
Refuses(p) == RefreshedBroken /\ (p \in AdmitOps \/ Variant = "strictInRun")

StartRefuse(p) ==
    /\ up /\ opSt[p] = "idle" /\ Refuses(p)
    /\ lastGood' = RefreshedGood /\ cacheBroken' = RefreshedBroken
    /\ opSt' = [opSt EXCEPT ![p] = "refused"]
    /\ gwRefused' = IF p \in AdmitOps THEN gwRefused ELSE gwRefused \cup {p}
    /\ UNCHANGED <<fileVars, lifeVars, objVars, sSt, deriving, opObj, opWait, opPin, opNeed, opUsed, jobVars, cut, badAdmits>>

StartDirect(p) ==
    /\ up /\ opSt[p] = "idle" /\ ~Refuses(p)
    /\ RefreshedGood = oVer[cur]
    /\ lastGood' = RefreshedGood /\ cacheBroken' = RefreshedBroken
    /\ opSt' = [opSt EXCEPT ![p] = "running"]
    /\ opObj' = [opObj EXCEPT ![p] = cur]
    /\ opPin' = [opPin EXCEPT ![p] = oVer[cur]]
    /\ opNeed' = [opNeed EXCEPT ![p] = NeedNow]
    /\ badAdmits' = IF p \in AdmitOps /\ (diskBroken \/ RefreshedGood \in Underivable) THEN badAdmits \cup {p} ELSE badAdmits
    /\ UNCHANGED <<fileVars, lifeVars, objVars, sSt, deriving, opWait, opUsed, jobVars, cut, gwRefused>>

StartJoin(p, s) ==
    /\ up /\ opSt[p] = "idle" /\ ~Refuses(p)
    /\ RefreshedGood # oVer[cur]
    /\ s \in deriving
    /\ (s = RefreshedGood \/ Variant = "awaitOlder")
    /\ lastGood' = RefreshedGood /\ cacheBroken' = RefreshedBroken
    /\ opSt' = [opSt EXCEPT ![p] = "waiting"]
    /\ opWait' = [opWait EXCEPT ![p] = s]
    /\ opNeed' = [opNeed EXCEPT ![p] = NeedWaiter]
    /\ UNCHANGED <<fileVars, lifeVars, objVars, sSt, deriving, opObj, opPin, opUsed, jobVars, latchVars>>

StartQueue(p) ==
    /\ Variant # "awaitOlder"
    /\ up /\ opSt[p] = "idle" /\ ~Refuses(p)
    /\ RefreshedGood # oVer[cur]
    /\ deriving # {} /\ RefreshedGood \notin deriving
    /\ lastGood' = RefreshedGood /\ cacheBroken' = RefreshedBroken
    /\ opSt' = [opSt EXCEPT ![p] = "waiting"]
    /\ opWait' = [opWait EXCEPT ![p] = RefreshedGood]
    /\ opNeed' = [opNeed EXCEPT ![p] = NeedWaiter]
    /\ UNCHANGED <<fileVars, lifeVars, objVars, sSt, deriving, opObj, opPin, opUsed, jobVars, latchVars>>

StartDerive(p) ==
    /\ up /\ opSt[p] = "idle" /\ ~Refuses(p)
    /\ RefreshedGood # oVer[cur]
    /\ RefreshedGood \notin deriving
    /\ (deriving = {} \/ Variant = "parallelDerive")
    /\ lastGood' = RefreshedGood /\ cacheBroken' = RefreshedBroken
    /\ deriving' = deriving \cup {RefreshedGood}
    /\ opSt' = [opSt EXCEPT ![p] = "waiting"]
    /\ opWait' = [opWait EXCEPT ![p] = RefreshedGood]
    /\ opNeed' = [opNeed EXCEPT ![p] = NeedWaiter]
    /\ UNCHANGED <<fileVars, lifeVars, objVars, sSt, opObj, opPin, opUsed, jobVars, latchVars>>

BeginDerive(s) ==
    /\ up /\ deriving = {} /\ s # oVer[cur]
    /\ Waiters(s) # {}
    /\ deriving' = {s}
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
    /\ \/ DeriveOk(s)
       \/ DeriveFails(s)
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, opWait, opNeed, opUsed, jobVars, gwRefused, badAdmits>>

Wake(q) ==
    /\ opSt[q] = "woken"
    /\ opSt' = [opSt EXCEPT ![q] = "running"]
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, objVars, sSt, deriving, opObj, opWait, opPin, opNeed, opUsed, jobVars, latchVars>>

Reap(o) ==
    /\ oSt[o] = "old"
    /\ IF Variant = "sweepWithJob" THEN Holder(o) = {} ELSE Holders(o) = {}
    /\ oSt' = [oSt EXCEPT ![o] = "retired"]
    /\ retiredN' = [retiredN EXCEPT ![o] = @ + 1]
    /\ sSt' = StopUnref([oSt EXCEPT ![o] = "retired"], oSrv, sSt, o)
    /\ cut' = cut \cup Holders(o)
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, nObj, cur, oVer, oGate, oSrv, nGate, nSrv, sTgt, deriving, opVars, jobVars, gwRefused, badAdmits>>

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
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, objVars, deriving, opObj, opPin, opNeed, jobVars, gwRefused, badAdmits>>

LockStart(p) ==
    /\ opSt[p] = "waitLock"
    /\ LET s == opWait[p]
       IN /\ ~Blocked(s, sTgt[s])
          /\ sSt[s] = "idle"
          /\ sSt' = [sSt EXCEPT ![s] = "running"]
    /\ opSt' = [opSt EXCEPT ![p] = "running"]
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, objVars, deriving, opObj, opWait, opPin, opNeed, opUsed, jobVars, latchVars>>

Finish(p) ==
    /\ opSt[p] = "running"
    /\ opSt' = [opSt EXCEPT ![p] = "done"]
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, objVars, sSt, deriving, opObj, opWait, opPin, opNeed, opUsed, jobVars, latchVars>>

Spawn(p, j) ==
    /\ opSt[p] = "running" /\ jobSt[j] = "none"
    /\ jobSt' = [jobSt EXCEPT ![j] = "live"]
    /\ jobObj' = [jobObj EXCEPT ![j] = opObj[p]]
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, objVars, sSt, deriving, opVars, latchVars>>

JobExit(j) ==
    /\ jobSt[j] = "live"
    /\ jobSt' = [jobSt EXCEPT ![j] = "exited"]
    /\ UNCHANGED <<fileVars, cacheVars, lifeVars, objVars, sSt, deriving, opVars, jobObj, latchVars>>

ProcessDown ==
    /\ up' = FALSE
    /\ opSt' = [q \in Ops |-> IF opSt[q] \in {"waiting", "woken", "running", "waitLock"} THEN "done" ELSE opSt[q]]
    /\ jobSt' = [j \in Jobs |-> IF jobSt[j] = "live" THEN "exited" ELSE jobSt[j]]
    /\ oSt' = [o \in ObjIds |-> IF oSt[o] \in {"cur", "old"} THEN "gone" ELSE oSt[o]]
    /\ cur' = 0
    /\ sSt' = [x \in SrvIds |-> IF sSt[x] \in {"idle", "running"} THEN "stopped" ELSE sSt[x]]
    /\ deriving' = {}

Crash ==
    /\ up /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ ProcessDown
    /\ UNCHANGED <<fileVars, cacheVars, nObj, oVer, oGate, oSrv, nGate, nSrv, sTgt, retiredN, opObj, opWait, opPin, opNeed, opUsed, jobObj, latchVars>>

SupervisorRestart ==
    /\ Variant = "restartOnChange"
    /\ up /\ ~diskBroken /\ diskV # oVer[cur]
    /\ cut' = cut \cup {q \in Ops : opSt[q] \in {"running", "waitLock"}} \cup {j \in Jobs : jobSt[j] = "live"}
    /\ ProcessDown
    /\ UNCHANGED <<fileVars, cacheVars, crashes, nObj, oVer, oGate, oSrv, nGate, nSrv, sTgt, retiredN, opObj, opWait, opPin, opNeed, opUsed, jobObj, gwRefused, badAdmits>>

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
       /\ lastGood' = diskV /\ cacheBroken' = FALSE
    /\ UNCHANGED <<fileVars, crashes, retiredN, deriving, opVars, jobVars, latchVars>>

Next ==
    \/ WriteValid
    \/ WriteBroken
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
