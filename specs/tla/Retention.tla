---------------------------- MODULE Retention ----------------------------
(***************************************************************************)
(* Model of the retention sweep of design-recorded-answers-2026-11-07.md   *)
(* item Q16 and its Resolutions: one period (retention.days), judged per   *)
(* session from its last activity; sessions that refer to each other are  *)
(* deleted only together, once every one of them has expired; the runs,   *)
(* events, blobs, stored responses, usage and traces of a session go      *)
(* together; blobs that nothing owns are collected.                       *)
(*                                                                         *)
(* Actors, derived from the code (each writer and reader of the data that *)
(* is deleted)                                                             *)
(*   run store writers: createRunAndEnqueue (store/src/runtime-store.ts:  *)
(*       1065), claim and every transition to a terminal status (the      *)
(*       run lifecycle of RunRecovery.tla), appendPayloads. They are      *)
(*       CreateRun, Start, Finish; each is an immediate transaction and    *)
(*       sets the last activity (events.created_at, runs.created_at)       *)
(*   child sessions: createChildRun (runtime-store.ts:1107) inserts a     *)
(*       session whose first run has parent_run_id (schema.ts:227). The   *)
(*       code lets a run refer to another session only here; the model    *)
(*       lets a new session refer to any live session (NewChild), which   *)
(*       also covers an InheritRef-style reference created later          *)
(*       (store/src/inherit-reference.ts: previous_run_id is read from    *)
(*       latestRunOfSession, runtime-store.ts:1078)                       *)
(*   the other runtime DB writers: the journal thread runFacts commit      *)
(*       (store/src/run-facts.ts:222, an immediate transaction), the      *)
(*       facts sweeper, session_touched, approvals, jobs, memories'       *)
(*       provenance. All write one SQLite database with foreign keys on   *)
(*       (foundation/src/sqlite.ts:69) inside immediate transactions     *)
(*       (schema.ts: run_facts.run_id REFERENCES runs). A write to a      *)
(*       deleted run fails at the foreign key, and a write that lands     *)
(*       first is deleted with the session or, when it is activity,       *)
(*       makes the closure unexpired. They are the same actor class as    *)
(*       CreateRun; none is a separate step here                          *)
(*   blob writers: BlobStore.put (store/src/blobs.ts:191), called by      *)
(*       the worker (runtime/src/worker/context-step.ts:245), the tool    *)
(*       executor (tools/src/executor.ts:510,515) and background jobs     *)
(*       (runtime/src/process/background-jobs.ts:114). put writes the     *)
(*       content file when it is missing (the dedupe: holdsContent, :59), *)
(*       then inserts the blobs row and the blob_owners row in one        *)
(*       immediate transaction. The journal thread cannot write a blob:   *)
(*       it builds its blob store with a clock that throws                *)
(*       (runtime/src/memory/journal-thread.ts:402,420)                   *)
(*   blob readers: BlobStore.read (blobs.ts:167) by the worker and by     *)
(*       the journal thread's fidelity scan (journal-thread.ts:299). A     *)
(*       read is scoped to a session that owns the blob (readableBy,      *)
(*       blobs.ts:148), so a reader of a live session reads a blob that   *)
(*       the session owns; OwnedBlobReadable is the property it needs      *)
(*   the gateway: commit (gateway/src/core/store.ts:226) writes the       *)
(*       response and its usage rows when a model call completes, in the   *)
(*       gateway database, which has no foreign key to the runtime. It    *)
(*       is GwCommit. Its reader of an earlier response              *)
(*       (previous_response_id, core/input.ts:31) finds it or gets a      *)
(*       clean not-found; it copies the content and keeps no pointer      *)
(*   trace writers: the telemetry exporters of the runtime and gateway    *)
(*       processes write spans with run_id into their trace stores        *)
(*       (observability/src/trace-store.ts:80); both purge by the same    *)
(*       call and are one store here (TrExport, PurgeTr)                  *)
(*   the age purge of trace bodies (observability/src/body-purge.ts,      *)
(*       started at runtime/src/process/start-runtime-process.ts:415 and  *)
(*       gateway/src/process.ts:482): retired by the rule, because one    *)
(*       question has one rule. Responses with no run link are purged by  *)
(*       age in the gateway alone; nothing refers to them, and they are   *)
(*       not modelled                                                     *)
(*   attach and replay readers (readRunEvents, store/src/types.ts:580;    *)
(*       replay, :736) read pages of one session. A reader of a running   *)
(*       or queued run is protected by ActiveNotDeleted. A reader of a    *)
(*       terminal expired session may find the session gone between two   *)
(*       pages and gets a clean not-found, because the deletion of the    *)
(*       runtime rows is one transaction, so no page is torn              *)
(*   parent-side readers: childRuns and childByCall (runtime-store.ts:     *)
(*       183-184) and the recursive tree queries (:189-200) read the       *)
(*       children of a run, as run-facts.ts:133 reads its ancestors. A     *)
(*       parent and a child are read together, so the unit of deletion     *)
(*       holds both; NoDanglingSessionRef states it in both directions     *)
(*   the sweeper (new): Phase1 to RemoveEntry below, in the runtime       *)
(*       process; a crash is Crash                                        *)
(*                                                                         *)
(* lock stands for the SQLite write lock. It blocks, in this model, only   *)
(* the actors whose interleaving with the collector matters (PutTx,        *)
(* Phase1, CreateRun); blocking more actors would only remove behaviours.  *)
(*                                                                         *)
(* RT5 (events are deleted only through retention) is the exception of     *)
(* F16.1 in the events trigger, tied to this model by the registry test    *)
(* of R6; it is not an actor here.                                         *)
(*                                                                         *)
(* The late writers. A gateway commit or a span export for a run lands    *)
(* within the model-call and flush limits after the run's last event;     *)
(* the minimum period is one day. The model lets them write until the     *)
(* store's purge for the session has run (GwCommit, TrExport); it does    *)
(* not model a write after the purge.                                      *)
(*                                                                         *)
(* Abstractions: SQL and the table list (rt stands for every runtime-DB   *)
(* row of a session; the registry test of R6 ties the table list to the   *)
(* schema); file names; batch size; the content of a row; one blob (two   *)
(* sessions can share it); one run per session at a time; the number of   *)
(* gateway rows. Time is an integer clock; a session is expired when      *)
(* act + Days <= now. Orphan content files that no blobs row names (a     *)
(* crash between the file write and the transaction) are not collected     *)
(* by the sweep and are not modelled.                                      *)
(*                                                                         *)
(* Switches. The configuration Retention is the design the model holds.   *)
(*   UseClosure    the unit of deletion is the closure of sessions under  *)
(*                 "refers to" (FALSE: the session alone)                  *)
(*   Record        the retention_sweeps rows survive a crash (FALSE: the   *)
(*                 list of sessions still to purge is in memory)           *)
(*   LockedBlobs   the blob protocol. TRUE: put checks and writes the      *)
(*                 content file inside its transaction, and the collector  *)
(*                 unlinks inside its transaction, before it deletes the   *)
(*                 row. FALSE: put checks the file before its transaction  *)
(*                 (today) and the collector deletes the row, then         *)
(*                 unlinks after the commit                                *)
(*   FromActivity  a session is judged from its last activity (FALSE:      *)
(*                 from its creation; NoEarlyDelete judges against the     *)
(*                 last activity in both cases)                            *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Sessions, Days, MaxNow, MaxCrashes, MaxSkew, UseClosure, Record, LockedBlobs, FromActivity

ASSUME /\ Sessions # {}
       /\ Days \in Nat \ {0}
       /\ MaxNow \in Nat
       /\ MaxCrashes \in Nat
       /\ MaxSkew \in Nat
       /\ UseClosure \in BOOLEAN
       /\ Record \in BOOLEAN
       /\ LockedBlobs \in BOOLEAN
       /\ FromActivity \in BOOLEAN

VARIABLES now, skews, crashes, rt, run, act, ref, tr, gw, sweep, row, file, owners, putSt, lock, early, born

vars == <<now, skews, crashes, rt, run, act, ref, tr, gw, sweep, row, file, owners, putSt, lock, early, born>>

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
               /\ \A m \in Unit(s) : Expired(m) /\ run[m] \in Idle

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
    /\ UNCHANGED <<skews, crashes, rt, run, act, ref, tr, gw, sweep, row, file, owners, putSt, lock, early, born>>

ClockBack ==
    /\ skews < MaxSkew
    /\ now > 0
    /\ now' = now - 1
    /\ skews' = skews + 1
    /\ UNCHANGED <<crashes, rt, run, act, ref, tr, gw, sweep, row, file, owners, putSt, lock, early, born>>

NewRoot(s) ==
    /\ rt[s] = "absent"
    /\ rt' = [rt EXCEPT ![s] = "live"]
    /\ act' = [act EXCEPT ![s] = now]
    /\ born' = [born EXCEPT ![s] = IF FromActivity THEN 0 ELSE now]
    /\ UNCHANGED <<now, skews, crashes, run, ref, tr, gw, sweep, row, file, owners, putSt, lock, early>>

NewChild(c, p) ==
    /\ c # p
    /\ rt[c] = "absent"
    /\ rt[p] = "live"
    /\ rt' = [rt EXCEPT ![c] = "live"]
    /\ act' = [act EXCEPT ![c] = now]
    /\ ref' = ref \cup {<<c, p>>}
    /\ born' = [born EXCEPT ![c] = IF FromActivity THEN 0 ELSE now]
    /\ UNCHANGED <<now, skews, crashes, run, tr, gw, sweep, row, file, owners, putSt, lock, early>>

CreateRun(s) ==
    /\ rt[s] = "live"
    /\ run[s] \in Idle
    /\ lock # "gc"
    /\ run' = [run EXCEPT ![s] = "queued"]
    /\ act' = [act EXCEPT ![s] = now]
    /\ UNCHANGED <<now, skews, crashes, rt, ref, tr, gw, sweep, row, file, owners, putSt, lock, early, born>>

Start(s) ==
    /\ rt[s] = "live"
    /\ run[s] = "queued"
    /\ run' = [run EXCEPT ![s] = "running"]
    /\ act' = [act EXCEPT ![s] = now]
    /\ UNCHANGED <<now, skews, crashes, rt, ref, tr, gw, sweep, row, file, owners, putSt, lock, early, born>>

Finish(s) ==
    /\ rt[s] = "live"
    /\ run[s] = "running"
    /\ putSt[s] = "idle"
    /\ run' = [run EXCEPT ![s] = "terminal"]
    /\ act' = [act EXCEPT ![s] = now]
    /\ UNCHANGED <<now, skews, crashes, rt, ref, tr, gw, sweep, row, file, owners, putSt, lock, early, born>>

PutFile(s) ==
    /\ rt[s] = "live"
    /\ run[s] = "running"
    /\ putSt[s] = "idle"
    /\ file' = TRUE
    /\ putSt' = [putSt EXCEPT ![s] = "filed"]
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, gw, sweep, row, owners, lock, early, born>>

PutTx(s) ==
    /\ putSt[s] = "filed"
    /\ lock # "gc"
    /\ putSt' = [putSt EXCEPT ![s] = "idle"]
    /\ IF rt[s] = "live"
       THEN /\ row' = TRUE
            /\ owners' = owners \cup {s}
            /\ file' = IF LockedBlobs THEN TRUE ELSE file
       ELSE UNCHANGED <<row, owners, file>>
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, gw, sweep, lock, early, born>>

GwCommit(s) ==
    /\ run[s] # "none"
    /\ gw[s] # "gone"
    /\ rt[s] = "live" \/ s \in sweep
    /\ gw' = [gw EXCEPT ![s] = "has"]
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, sweep, row, file, owners, putSt, lock, early, born>>

TrExport(s) ==
    /\ run[s] # "none"
    /\ tr[s] # "gone"
    /\ rt[s] = "live" \/ s \in sweep
    /\ tr' = [tr EXCEPT ![s] = "has"]
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, gw, sweep, row, file, owners, putSt, lock, early, born>>

Phase1(s) ==
    LET C == Unit(s) IN
    /\ lock # "gc"
    /\ Eligible(s)
    /\ rt' = [m \in Sessions |-> IF m \in C THEN "deleted" ELSE rt[m]]
    /\ owners' = owners \ C
    /\ sweep' = sweep \cup C
    /\ early' = (early \/ \E m \in C : ~TrulyExpired(m))
    /\ UNCHANGED <<now, skews, crashes, run, act, ref, tr, gw, row, file, putSt, lock, born>>

PurgeTr(s) ==
    /\ s \in sweep
    /\ tr[s] # "gone"
    /\ tr' = [tr EXCEPT ![s] = "gone"]
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, gw, sweep, row, file, owners, putSt, lock, early, born>>

PurgeGw(s) ==
    /\ s \in sweep
    /\ gw[s] # "gone"
    /\ gw' = [gw EXCEPT ![s] = "gone"]
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, sweep, row, file, owners, putSt, lock, early, born>>

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
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, gw, sweep, owners, putSt, early, born>>

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
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, gw, sweep, owners, putSt, early, born>>

RemoveEntry(s) ==
    /\ s \in sweep
    /\ tr[s] = "gone"
    /\ gw[s] = "gone"
    /\ ~(row /\ owners = {})
    /\ lock = "none"
    /\ sweep' = sweep \ {s}
    /\ UNCHANGED <<now, skews, crashes, rt, run, act, ref, tr, gw, row, file, owners, putSt, lock, early, born>>

Crash ==
    /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ lock' = "none"
    /\ putSt' = [s \in Sessions |-> "idle"]
    /\ sweep' = IF Record THEN sweep ELSE {}
    /\ UNCHANGED <<now, skews, rt, run, act, ref, tr, gw, row, file, owners, early, born>>

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
        \/ Phase1(s)
        \/ PurgeTr(s)
        \/ PurgeGw(s)
        \/ RemoveEntry(s)
    \/ \E c, p \in Sessions : NewChild(c, p)

Spec == Init /\ [][Next]_vars

LiveSpec ==
    /\ Spec
    /\ \A s \in Sessions : WF_vars(Phase1(s)) /\ WF_vars(PurgeTr(s)) /\ WF_vars(PurgeGw(s)) /\ WF_vars(RemoveEntry(s)) /\ WF_vars(PutTx(s))
    /\ WF_vars(GcFirst)
    /\ WF_vars(GcSecond)

ActiveNotDeleted == \A s \in Sessions : run[s] \in {"queued", "running"} => rt[s] = "live"

NoEarlyDelete == ~early

NoDanglingSessionRef == \A r \in ref : rt[r[1]] = rt[r[2]]

OwnersLive == \A s \in owners : rt[s] = "live"

OwnedBlobReadable == owners # {} => row /\ file

NoUncoveredDangling ==
    \A s \in Sessions : (rt[s] = "deleted" /\ (tr[s] = "has" \/ gw[s] = "has")) => s \in sweep

ExpiredClosureDeleted == \A s \in Sessions : Eligible(s) ~> (rt[s] = "deleted" \/ ~Eligible(s))

DeletionCompletes ==
    \A s \in Sessions : rt[s] = "deleted" ~> (s \notin sweep /\ tr[s] = "gone" /\ gw[s] = "gone")

UnownedBlobCollected == (row /\ owners = {}) ~> (~row \/ owners # {})

=============================================================================
