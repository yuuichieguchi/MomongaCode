---------------------------- MODULE DerivedRepair ----------------------------
(***************************************************************************)
(* Design model of the derived records of the store (design 11.5).         *)
(*                                                                         *)
(* Code sources modelled                                                   *)
(*   packages/store/src/derived-repair.ts  repairPage, recordAppended,     *)
(*       createDerivedReads (read, write), createDerivedSnapshot           *)
(*   packages/store/src/append-records.ts  the recorders of each derivation *)
(*   packages/store/src/runtime-store.ts   claim, append, and every store  *)
(*       operation that reads a derived value                              *)
(*                                                                         *)
(* Derivations of the code and the model derivation each one is            *)
(*   derivation 14  dn  events.pinned_digest                 run           *)
(*   derivation 20  dn  events.call_id, approval_id, tool_name,            *)
(*                      notice_code, model_call_json,                      *)
(*                      run_records, started_calls           run           *)
(*   derivation 20  ds  meter_records                        session       *)
(*   derivation 23  ds  session_touched                      session       *)
(*   derivation 24  dn  run_answerers                        run           *)
(*   derivation 35  dn  run_indexed_chars                    run           *)
(*   derivation 36  dn  search_draft_runs, search_draft_steps,             *)
(*                      search_draft_parts, search_draft_paths             *)
(*                                                           run           *)
(*                                                                         *)
(* Actors of the code and the action that models each one                  *)
(*   AppendO        an older build appends and records nothing             *)
(*   AppendN        append records an event whose run is current           *)
(*   RepairPage     claim and append repair one page in their transaction  *)
(*   WRead          a writable read: one page per transaction, the event   *)
(*                  loop free between pages, the read in the transaction   *)
(*                  of the last page; with no lag a plain read             *)
(*                  transaction, which is WRead with no page               *)
(*   WRead, AppendN a store operation that reads a derived value inside    *)
(*                  its write (approval reads under changeStatus): its     *)
(*                  last page, read, state check and write are one         *)
(*                  transaction, which is WRead followed at once by        *)
(*                  AppendN for the events it appends; that sequence is    *)
(*                  a behaviour of this model, so it adds none             *)
(*   ReadOther      the read-only view of the journal thread, which        *)
(*                  derives the part past the watermark in memory and      *)
(*                  writes nothing (ReadRule tail)                         *)
(*                                                                         *)
(* Abstractions                                                            *)
(*   - the indexing of a terminal run reads the drafts of derivation 36    *)
(*     inside a writable read and then deletes them (IndexDrop); the       *)
(*     deletion moves no watermark, and RepairNeverReadsDeleted holds      *)
(*     once nothing of the run is pending                                  *)
(*   - the state checks and writes of a store operation other than its     *)
(*     derived reads and appends are not modelled: they touch no           *)
(*     derived record and no watermark (RunRecovery.tla models them)       *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Derivs, DsUnit, DsKind, MaxEvents, Pre, PageSize, ReadRule, Repair, Reps, Drop

Runs == {"r1", "r2"}
Gens == {"O", "N"}
Big == MaxEvents + 1

ASSUME Derivs \subseteq {"dn", "ds"}
ASSUME DsUnit \in {"run", "session"}
ASSUME DsKind \in {"seq", "set"}
ASSUME ReadRule \in {"today", "tail", "separate"}
ASSUME Repair \in {"pageTx", "staleMark", "advanceAtEnd"}
ASSUME Pre \in 0..MaxEvents /\ PageSize \in 1..MaxEvents
ASSUME Drop \in {"caughtUp", "early"}

ValScope(d) == IF d = "dn" THEN "run" ELSE "session"
WmUnit(d) == IF d = "dn" THEN "run" ELSE DsUnit

VARIABLES log, owner, done, wm, val, readBad, cap, rd, dropped

vars == <<log, owner, done, wm, val, readBad, cap, rd, dropped>>

Min(a, b) == IF a < b THEN a ELSE b
Max(a, b) == IF a > b THEN a ELSE b

RECURSIVE Sorted(_)
Sorted(S) ==
    IF S = {} THEN <<>>
    ELSE LET m == CHOOSE x \in S : \A y \in S : x <= y IN <<m>> \o Sorted(S \ {m})

KeyOf(L, d, i) == IF WmUnit(d) = "run" THEN L[i].run ELSE "s"
PosOf(L, d, i) == IF WmUnit(d) = "run" THEN L[i].seq ELSE i
VKey(L, d, i) == IF ValScope(d) = "run" THEN L[i].run ELSE "s"
WmKeys == Runs \cup {"s"}
KeysFor(d, r) == IF WmUnit(d) = "run" THEN r ELSE "s"

PendingSet(L, d, k, after, hi) ==
    {i \in 1..Len(L) : KeyOf(L, d, i) = k /\ PosOf(L, d, i) > after /\ PosOf(L, d, i) <= hi}

Take(L, d, k, after, hi, n) ==
    LET s == Sorted(PendingSet(L, d, k, after, hi)) IN SubSeq(s, 1, Min(n, Len(s)))

SeqToSet(q) == {q[j] : j \in 1..Len(q)}

Ins(d, q, id) ==
    IF d = "ds" /\ DsKind = "set" THEN Sorted(SeqToSet(q) \cup {id}) ELSE Append(q, id)

RECURSIVE ApplyAll(_, _, _, _)
ApplyAll(L, d, v, s) ==
    IF s = <<>> THEN v
    ELSE ApplyAll(L, d, [v EXCEPT ![VKey(L, d, Head(s))] = Ins(d, @, Head(s))], Tail(s))

NewD(L, d, k, after, hi, n) ==
    LET ids == Take(L, d, k, after, hi, n)
    IN [w |-> IF ids = <<>> THEN wm[d][k] ELSE PosOf(L, d, ids[Len(ids)]),
        v |-> ApplyAll(L, d, val[d], ids)]

Covered(d, vk) ==
    {i \in 1..Len(log) : VKey(log, d, i) = vk /\ PosOf(log, d, i) <= wm[d][KeyOf(log, d, i)]}

Truth(d, vk) == Sorted({i \in 1..Len(log) : VKey(log, d, i) = vk})

ValKeysOf(d) == IF ValScope(d) = "run" THEN Runs ELSE {"s"}

PendingAcross(d, vk) ==
    {i \in 1..Len(log) : VKey(log, d, i) = vk /\ PosOf(log, d, i) > wm[d][KeyOf(log, d, i)]}

NoCap == [on |-> FALSE, d |-> "dn", k |-> "r1", at |-> 0]

NoRd == [on |-> FALSE, d |-> "dn", vk |-> "r1"]

Init ==
    /\ log = [i \in 1..Pre |-> [run |-> "r1", seq |-> i]]
    /\ owner = [r \in Runs |-> IF r = "r1" THEN "O" ELSE "N"]
    /\ done = [r \in Runs |-> FALSE]
    /\ wm = [d \in Derivs |-> [k \in WmKeys |-> 0]]
    /\ val = [d \in Derivs |-> [k \in WmKeys |-> <<>>]]
    /\ readBad = FALSE
    /\ cap = [p \in Reps |-> NoCap]
    /\ rd = [p \in Reps |-> NoRd]
    /\ dropped = [r \in Runs |-> FALSE]

CountOf(r) == Cardinality({i \in 1..Len(log) : log[i].run = r})

NewEvent(r) == [run |-> r, seq |-> CountOf(r) + 1]

AppendO(r) ==
    /\ owner[r] = "O" /\ ~done[r] /\ Len(log) < MaxEvents
    /\ log' = Append(log, NewEvent(r))
    /\ UNCHANGED <<owner, done, wm, val, readBad, cap, rd, dropped>>

AppendN(r) ==
    /\ ~done[r] /\ Len(log) < MaxEvents
    /\ LET L2 == Append(log, NewEvent(r))
           i == Len(L2)
           ok == \A d \in Derivs : wm[d][KeyOf(L2, d, i)] = PosOf(L2, d, i) - 1
       IN /\ log' = L2
          /\ wm' = [d \in Derivs |-> IF ok THEN [wm[d] EXCEPT ![KeyOf(L2, d, i)] = PosOf(L2, d, i)] ELSE wm[d]]
          /\ val' = [d \in Derivs |-> IF ok THEN ApplyAll(L2, d, val[d], <<i>>) ELSE val[d]]
    /\ UNCHANGED <<owner, done, readBad, cap, rd, dropped>>

Finish(r) ==
    /\ ~done[r]
    /\ done' = [done EXCEPT ![r] = TRUE]
    /\ UNCHANGED <<log, owner, wm, val, readBad, cap, rd, dropped>>

CatchUpRun(r) ==
    LET upd(d) == NewD(log, d, KeysFor(d, r), wm[d][KeysFor(d, r)], Big, Big)
    IN /\ wm' = [d \in Derivs |-> [wm[d] EXCEPT ![KeysFor(d, r)] = upd(d).w]]
       /\ val' = [d \in Derivs |-> upd(d).v]
       /\ UNCHANGED dropped

Claim(r) ==
    /\ owner[r] = "O" /\ ~done[r]
    /\ owner' = [owner EXCEPT ![r] = "N"]
    /\ UNCHANGED <<log, done, wm, val, readBad, cap, rd, dropped>>

MergeTail(v, d, vk) ==
    IF d = "ds" /\ DsKind = "set"
        THEN Sorted(SeqToSet(v[d][vk]) \cup PendingAcross(d, vk))
        ELSE v[d][vk] \o Sorted(PendingAcross(d, vk))

ReadResult(v, d, vk) ==
    IF ReadRule = "tail" THEN MergeTail(v, d, vk) ELSE v[d][vk]

RelKeys(d, vk) ==
    IF WmUnit(d) = "session" THEN {"s"} ELSE IF ValScope(d) = "run" THEN {vk} ELSE Runs

Clear(d, vk) == \A k \in RelKeys(d, vk) : PendingSet(log, d, k, wm[d][k], Big) = {}

ReadStream(r, d) ==
    /\ ReadRule = "today" /\ d \in Derivs /\ ValScope(d) = "run"
    /\ IF ReadRule = "today"
          THEN CatchUpRun(r)
          ELSE UNCHANGED <<wm, val, dropped>>
    /\ readBad' = (readBad \/ ReadResult(val', d, r) # Truth(d, r))
    /\ UNCHANGED <<log, owner, done, cap, rd, dropped>>

ReadOther(d, vk) ==
    /\ ReadRule # "separate" /\ d \in Derivs /\ vk \in ValKeysOf(d)
    /\ readBad' = (readBad \/ ReadResult(val, d, vk) # Truth(d, vk))
    /\ UNCHANGED <<log, owner, done, wm, val, cap, rd, dropped>>

WRead(d, vk) ==
    /\ ReadRule = "tail" /\ Repair = "pageTx"
    /\ d \in Derivs /\ vk \in ValKeysOf(d)
    /\ \E k \in RelKeys(d, vk) :
        /\ PendingSet(log, d, k, wm[d][k], Big) # {} \/ Clear(d, vk)
        /\ LET u == NewD(log, d, k, wm[d][k], Big, PageSize)
               w2 == [wm EXCEPT ![d][k] = u.w]
               v2 == [val EXCEPT ![d] = u.v]
               clear2 == \A k2 \in RelKeys(d, vk) : PendingSet(log, d, k2, w2[d][k2], Big) = {}
           IN /\ wm' = w2
              /\ val' = v2
              /\ readBad' = (readBad \/ (clear2 /\ v2[d][vk] # Truth(d, vk)))
    /\ UNCHANGED <<log, owner, done, cap, rd, dropped>>

Sep1(p, d, vk) ==
    /\ ReadRule = "separate" /\ ~rd[p].on
    /\ d \in Derivs /\ vk \in ValKeysOf(d) /\ Clear(d, vk)
    /\ rd' = [rd EXCEPT ![p] = [on |-> TRUE, d |-> d, vk |-> vk]]
    /\ UNCHANGED <<log, owner, done, wm, val, readBad, cap, dropped>>

Sep2(p) ==
    /\ rd[p].on
    /\ readBad' = (readBad \/ val[rd[p].d][rd[p].vk] # Truth(rd[p].d, rd[p].vk))
    /\ rd' = [rd EXCEPT ![p] = NoRd]
    /\ UNCHANGED <<log, owner, done, wm, val, cap, dropped>>

RepairPage(d, k) ==
    /\ Repair = "pageTx"
    /\ d \in Derivs /\ k \in WmKeys
    /\ LET u == NewD(log, d, k, wm[d][k], Big, PageSize)
       IN /\ wm' = [wm EXCEPT ![d][k] = u.w]
          /\ val' = [val EXCEPT ![d] = u.v]
    /\ UNCHANGED <<log, owner, done, readBad, cap, rd, dropped>>

RepStart(p, d, k) ==
    /\ Repair # "pageTx"
    /\ ~cap[p].on /\ d \in Derivs /\ k \in WmKeys
    /\ cap' = [cap EXCEPT ![p] = [on |-> TRUE, d |-> d, k |-> k, at |-> wm[d][k]]]
    /\ UNCHANGED <<log, owner, done, wm, val, readBad, rd, dropped>>

RepStep(p) ==
    /\ cap[p].on
    /\ LET c == cap[p]
           ids == Take(log, c.d, c.k, c.at, Big, PageSize)
           nat == IF ids = <<>> THEN c.at ELSE PosOf(log, c.d, ids[Len(ids)])
           more == PendingSet(log, c.d, c.k, nat, Big) # {}
           newW == IF Repair = "staleMark" THEN nat
                   ELSE IF more THEN wm[c.d][c.k] ELSE nat
       IN /\ val' = [val EXCEPT ![c.d] = ApplyAll(log, c.d, val[c.d], ids)]
          /\ wm' = [wm EXCEPT ![c.d][c.k] = IF ids = <<>> THEN wm[c.d][c.k] ELSE newW]
          /\ cap' = [cap EXCEPT ![p] = IF ids = <<>> THEN NoCap ELSE [c EXCEPT !.at = nat]]
    /\ UNCHANGED <<log, owner, done, readBad, rd, dropped>>

RepCrash(p) ==
    /\ cap[p].on
    /\ cap' = [cap EXCEPT ![p] = NoCap]
    /\ UNCHANGED <<log, owner, done, wm, val, readBad, rd, dropped>>

IndexDrop(r) ==
    /\ "dn" \in Derivs
    /\ done[r] /\ ~dropped[r]
    /\ Drop = "early" \/ PendingSet(log, "dn", r, wm["dn"][r], Big) = {}
    /\ readBad' = (readBad \/ val["dn"][r] # Truth("dn", r))
    /\ dropped' = [dropped EXCEPT ![r] = TRUE]
    /\ UNCHANGED <<log, owner, done, wm, val, cap, rd>>

Next ==
    \/ \E r \in Runs : AppendO(r) \/ AppendN(r) \/ Finish(r) \/ Claim(r) \/ IndexDrop(r)
    \/ \E r \in Runs, d \in Derivs : ReadStream(r, d)
    \/ \E d \in Derivs, vk \in WmKeys : ReadOther(d, vk) \/ WRead(d, vk)
    \/ \E p \in Reps : Sep2(p)
    \/ \E p \in Reps, d \in Derivs, vk \in WmKeys : Sep1(p, d, vk)
    \/ \E d \in Derivs, k \in WmKeys : RepairPage(d, k)
    \/ \E p \in Reps : RepStep(p) \/ RepCrash(p)
    \/ \E p \in Reps, d \in Derivs, k \in WmKeys : RepStart(p, d, k)

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ Len(log) <= MaxEvents
    /\ owner \in [Runs -> Gens]
    /\ dropped \in [Runs -> BOOLEAN]
    /\ done \in [Runs -> BOOLEAN]
    /\ readBad \in BOOLEAN

Coherence ==
    \A d \in Derivs : \A vk \in ValKeysOf(d) : val[d][vk] = Sorted(Covered(d, vk))

MarkBound ==
    \A d \in Derivs, k \in WmKeys :
        wm[d][k] <= IF WmUnit(d) = "run"
                       THEN (IF k \in Runs THEN CountOf(k) ELSE 0)
                       ELSE (IF k = "s" THEN Len(log) ELSE 0)

NoBadRead == ~readBad

RepairNeverReadsDeleted == \A r \in Runs : dropped[r] => PendingSet(log, "dn", r, wm["dn"][r], Big) = {}

MarkMonotone ==
    [][\A d \in Derivs, k \in WmKeys : wm'[d][k] >= wm[d][k]]_vars

RepairIdempotent ==
    [][log' = log =>
        \A d \in Derivs : \A vk \in ValKeysOf(d) :
            val[d][vk] = Truth(d, vk) => val'[d][vk] = val[d][vk]]_vars

=============================================================================
