---------------------------- MODULE Retention ----------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Sessions, Days, MaxNow, MaxCrashes, MaxSkew, UseClosure, Record, LockedBlobs, FromActivity, PerStoreSweep, DeleteWhileRead

ASSUME /\ Sessions # {}
       /\ Days \in Nat \ {0}
       /\ MaxNow \in Nat
       /\ MaxCrashes \in Nat
       /\ MaxSkew \in Nat
       /\ UseClosure \in BOOLEAN
       /\ Record \in BOOLEAN
       /\ LockedBlobs \in BOOLEAN
       /\ FromActivity \in BOOLEAN
       /\ PerStoreSweep \in BOOLEAN
       /\ DeleteWhileRead \in BOOLEAN

VARIABLES now, skews, crashes, rt, run, act, ref, tr, gw, ot, sweep, row, file, owners, putSt, lock, early, born, periods

vars == <<now, skews, crashes, rt, run, act, ref, tr, gw, ot, sweep, row, file, owners, putSt, lock, early, born, periods>>

Idle == {"none", "terminal"}

Judged(s) == IF FromActivity THEN act[s] ELSE born[s]

Expired(s) == Judged(s) + Days <= now

TrulyExpired(s) == act[s] + Days <= now

Adj(x) == {y \in Sessions : rt[y] = "live" /\ (<<x, y>> \in ref \/ <<y, x>> \in ref)}

RECURSIVE Grow(_, _)
Grow(X, n) == IF n = 0 THEN X ELSE Grow(X \cup UNION {Adj(x) : x \in X}, n - 1)

Closure(s) == Grow({s}, Cardinality(Sessions) - 1)

Unit(s) == IF UseClosure THEN Closure(s) ELSE {s}

Eligible(s) == /\ rt[s] = "live"
               /\ \A m \in Unit(s) : Expired(m) /\ (DeleteWhileRead \/ run[m] \in Idle)

OtPeriod == IF PerStoreSweep THEN Days + 1 ELSE Days

TypeOK ==
    /\ now \in 0..MaxNow
    /\ skews \in 0..MaxSkew
    /\ crashes \in 0..MaxCrashes
    /\ rt \in [Sessions -> {"absent", "live", "deleted"}]
    /\ run \in [Sessions -> {"none", "queued", "running", "terminal"}]
    /\ act \in [Sessions -> 0..MaxNow]
    /\ ref \subseteq Sessions \X Sessions
    /\ tr \in [Sessions -> {"none", "has", "gone"}]
    /\ gw \in [Sessions -> {"none", "has", "gone"}]
    /\ ot \in [Sessions -> {"none", "has", "gone"}]
    /\ periods \subseteq {Days, Days + 1}
    /\ sweep \subseteq Sessions
    /\ row \in BOOLEAN
    /\ file \in BOOLEAN
    /\ owners \subseteq Sessions
    /\ putSt \in [Sessions -> {"idle", "filed"}]
    /\ lock \in {"none", "gc", "unlink"}
    /\ early \in BOOLEAN
    /\ born \in [Sessions -> 0..MaxNow]

Init ==
    /\ now = 0
    /\ skews = 0
    /\ crashes = 0
    /\ rt = [s \in Sessions |-> "absent"]
    /\ run = [s \in Sessions |-> "none"]
    /\ act = [s \in Sessions |-> 0]
    /\ ref = {}
    /\ tr = [s \in Sessions |-> "none"]
    /\ gw = [s \in Sessions |-> "none"]
    /\ ot = [s \in Sessions |-> "none"]
    /\ periods = {}
    /\ sweep = {}
    /\ row = FALSE
    /\ file = FALSE
    /\ owners = {}
    /\ putSt = [s \in Sessions |-> "idle"]
    /\ lock = "none"
    /\ early = FALSE
    /\ born = [s \in Sessions |-> 0]

Tick ==
    /\ now < MaxNow
    /\ now' = now + 1
    /\ UNCHANGED <<skews, crashes, rt, run, act, ref, tr, gw, ot, sweep, row, file, owners, putSt, lock, early, born, periods>>

ClockBack ==
    /\ skews < MaxSkew
    /\ now > 0
    /\ now' = now - 1
    /\ skews' = skews + 1
    /\ UNCHANGED <<crashes, rt, run, act, ref, tr, gw, ot, sweep, row, file, owners, putSt, lock, early, born, periods>>

NewRoot(s) ==
    /\ rt[s] = "absent"
    /\ rt' = [rt EXCEPT ![s] = "live"]
    /\ act' = [act EXCEPT ![s] = now]
    /\ born' = [born EXCEPT ![s] = IF FromActivity THEN 0 ELSE now]
    /\ UNCHANGED <<now, skews, crashes, run, ref, tr, gw, ot, sweep, row, file, owners, putSt, lock, early, periods>>

NewChild(c, p) ==
    /\ c # p
    /\ rt[c] = "absent"
    /\ rt[p] = "live"
    /\ rt' = [rt EXCEPT ![c] = "live"]
    /\ act' = [act EXCEPT ![c] = now]
    /\ ref' = ref \cup {<<c, p>>}
    /\ born' = [born EXCEPT ![c] = IF FromActivity THEN 0 ELSE now]
    /\ UNCHANGED <<now, skews, crashes, run, tr, gw, ot, sweep, row, file, owners, putSt, lock, early, periods>>

CreateRun(s) ==
    /\ rt[s] = "live"
    /\ run[s] \in Idle
    /\ lock # "gc"
    /\ run' = [run EXCEPT ![s] = "queued"]
    /\ act' = [act EXCEPT ![s] = now]
    /\ UNCHANGED <<now, skews, crashes, rt, ref, tr, gw, ot, sweep, row, file, owners, putSt, lock, early, born, periods>>

Start(s) ==
    /\ rt[s] = "live"
    /\ run[s] = "queued"
    /\ run' = [run EXCEPT ![s] = "running"]
    /\ act' = [act EXCEPT ![s] = now]
    /\ UNCHANGED <<now, skews, crashes, rt, ref, tr, gw, ot, sweep, row, file, owners, putSt, lock, early, born, periods>>

Finish(s) ==
    /\ rt[s] = "live"
    /\ run[s] = "running"
    /\ putSt[s] = "idle"
    /\ run' = [run EXCEPT ![s] = "terminal"]
    /\ act' = [act EXCEPT ![s] = now]
    /\ UNCHANGED <<now, skews, crashes, rt, ref, tr, gw, ot, sweep, row, file, owners, putSt, lock, early, born, periods>>

PutFile(s) ==
    /\ rt[s] = "live"
    /\ run[s] = "running"
    /\ putSt[s] = "idle"
    /\ file' = TRUE
    /\ putSt' = [putSt EXCEPT ![s] = "filed"]
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, gw, ot, sweep, row, owners, lock, early, born, periods>>

PutTx(s) ==
    /\ putSt[s] = "filed"
    /\ lock # "gc"
    /\ putSt' = [putSt EXCEPT ![s] = "idle"]
    /\ IF rt[s] = "live"
       THEN /\ row' = TRUE
            /\ owners' = owners \cup {s}
            /\ file' = IF LockedBlobs THEN TRUE ELSE file
       ELSE UNCHANGED <<row, owners, file>>
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, gw, ot, sweep, lock, early, born, periods>>

GwCommit(s) ==
    /\ run[s] # "none"
    /\ gw[s] # "gone"
    /\ rt[s] = "live" \/ s \in sweep
    /\ gw' = [gw EXCEPT ![s] = "has"]
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, ot, sweep, row, file, owners, putSt, lock, early, born, periods>>

TrExport(s) ==
    /\ run[s] # "none"
    /\ tr[s] # "gone"
    /\ rt[s] = "live" \/ s \in sweep
    /\ tr' = [tr EXCEPT ![s] = "has"]
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, gw, ot, sweep, row, file, owners, putSt, lock, early, born, periods>>

Phase1(s) ==
    LET C == Unit(s) IN
    /\ lock # "gc"
    /\ Eligible(s)
    /\ rt' = [m \in Sessions |-> IF m \in C THEN "deleted" ELSE rt[m]]
    /\ owners' = owners \ C
    /\ sweep' = sweep \cup C
    /\ early' = (early \/ \E m \in C : ~TrulyExpired(m))
    /\ periods' = periods \cup {Days}
    /\ UNCHANGED <<now, skews, crashes, run, act, ref, tr, gw, ot, row, file, putSt, lock, born>>

PurgeTr(s) ==
    /\ s \in sweep
    /\ tr[s] # "gone"
    /\ tr' = [tr EXCEPT ![s] = "gone"]
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, gw, ot, sweep, row, file, owners, putSt, lock, early, born, periods>>

PurgeGw(s) ==
    /\ s \in sweep
    /\ gw[s] # "gone"
    /\ gw' = [gw EXCEPT ![s] = "gone"]
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, ot, sweep, row, file, owners, putSt, lock, early, born, periods>>

OtWrite(s) ==
    /\ run[s] # "none"
    /\ ot[s] # "gone"
    /\ rt[s] = "live" \/ s \in sweep
    /\ ot' = [ot EXCEPT ![s] = "has"]
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, gw, sweep, row, file, owners, putSt, lock, early, born, periods>>

PurgeOt(s) ==
    /\ s \in sweep
    /\ ot[s] # "gone"
    /\ ot' = [ot EXCEPT ![s] = "gone"]
    /\ periods' = periods \cup {OtPeriod}
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, gw, sweep, row, file, owners, putSt, lock, early, born>>

GcFirst ==
    /\ row
    /\ owners = {}
    /\ lock = "none"
    /\ IF LockedBlobs
       THEN /\ file' = FALSE
            /\ lock' = "gc"
            /\ UNCHANGED row
       ELSE /\ row' = FALSE
            /\ lock' = "unlink"
            /\ UNCHANGED file
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, gw, ot, sweep, owners, putSt, early, born, periods>>

GcSecond ==
    /\ lock # "none"
    /\ IF LockedBlobs
       THEN /\ lock = "gc"
            /\ row' = FALSE
            /\ UNCHANGED file
       ELSE /\ lock = "unlink"
            /\ file' = FALSE
            /\ UNCHANGED row
    /\ lock' = "none"
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, gw, ot, sweep, owners, putSt, early, born, periods>>

RemoveEntry(s) ==
    /\ s \in sweep
    /\ tr[s] = "gone"
    /\ gw[s] = "gone"
    /\ ot[s] = "gone"
    /\ ~(row /\ owners = {})
    /\ lock = "none"
    /\ sweep' = sweep \ {s}
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, gw, ot, row, file, owners, putSt, lock, early, born, periods>>

Crash ==
    /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ lock' = "none"
    /\ putSt' = [s \in Sessions |-> "idle"]
    /\ sweep' = IF Record THEN sweep ELSE {}
    /\ UNCHANGED <<now, skews, rt, run, act, ref, tr, gw, ot, row, file, owners, early, born, periods>>

Next ==
    \/ Tick
    \/ ClockBack
    \/ Crash
    \/ GcFirst
    \/ GcSecond
    \/ \E s \in Sessions :
        \/ NewRoot(s)
        \/ CreateRun(s)
        \/ Start(s)
        \/ Finish(s)
        \/ PutFile(s)
        \/ PutTx(s)
        \/ GwCommit(s)
        \/ TrExport(s)
        \/ OtWrite(s)
        \/ PurgeOt(s)
        \/ Phase1(s)
        \/ PurgeTr(s)
        \/ PurgeGw(s)
        \/ RemoveEntry(s)
    \/ \E c, p \in Sessions : NewChild(c, p)

Spec == Init /\ [][Next]_vars

LiveSpec ==
    /\ Spec
    /\ \A s \in Sessions : WF_vars(Phase1(s)) /\ WF_vars(PurgeTr(s)) /\ WF_vars(PurgeGw(s)) /\ WF_vars(PurgeOt(s)) /\ WF_vars(RemoveEntry(s)) /\ WF_vars(PutTx(s))
    /\ WF_vars(GcFirst)
    /\ WF_vars(GcSecond)

ActiveNotDeleted == \A s \in Sessions : run[s] \in {"queued", "running"} => rt[s] = "live"

NoEarlyDelete == ~early

NoDanglingSessionRef == \A r \in ref : rt[r[1]] = rt[r[2]]

OwnersLive == \A s \in owners : rt[s] = "live"

OwnedBlobReadable == owners # {} => row /\ file

NoUncoveredDangling ==
    \A s \in Sessions : (rt[s] = "deleted" /\ (tr[s] = "has" \/ gw[s] = "has" \/ ot[s] = "has")) => s \in sweep

ExpiredClosureDeleted == \A s \in Sessions : Eligible(s) ~> (rt[s] = "deleted" \/ ~Eligible(s))

DeletionCompletes ==
    \A s \in Sessions : rt[s] = "deleted" ~> (s \notin sweep /\ tr[s] = "gone" /\ gw[s] = "gone" /\ ot[s] = "gone")

OneSetting == periods \subseteq {Days}

NoLiveReferenceDeleted ==
    \A s \in Sessions : (run[s] \in {"queued", "running"} \/ \E c \in Sessions : <<c, s>> \in ref /\ rt[c] = "live") => rt[s] # "deleted"

UnownedBlobCollected == (row /\ owners = {}) ~> (~row \/ owners # {})

=============================================================================
