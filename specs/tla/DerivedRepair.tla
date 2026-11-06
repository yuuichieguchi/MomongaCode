---------------------------- MODULE DerivedRepair ----------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Derivs, DsUnit, MaxEvents, Pre, PageSize, ReadRule, Repair, Reps

Runs == {"r1", "r2"}
Gens == {"O", "N"}
Big == MaxEvents + 1

ASSUME Derivs \subseteq {"dn", "ds"}
ASSUME DsUnit \in {"run", "session"}
ASSUME ReadRule \in {"today", "tail"}
ASSUME Repair \in {"pageTx", "staleMark", "advanceAtEnd"}
ASSUME Pre \in 0..MaxEvents /\ PageSize \in 1..MaxEvents

ValScope(d) == IF d = "dn" THEN "run" ELSE "session"
WmUnit(d) == IF d = "dn" THEN "run" ELSE DsUnit

VARIABLES log, owner, done, wm, val, readBad, cap

vars == <<log, owner, done, wm, val, readBad, cap>>

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

RECURSIVE ApplyAll(_, _, _, _)
ApplyAll(L, d, v, s) ==
    IF s = <<>> THEN v
    ELSE ApplyAll(L, d, [v EXCEPT ![VKey(L, d, Head(s))] = Append(@, Head(s))], Tail(s))

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

Init ==
    /\ log = [i \in 1..Pre |-> [run |-> "r1", seq |-> i]]
    /\ owner = [r \in Runs |-> IF r = "r1" THEN "O" ELSE "N"]
    /\ done = [r \in Runs |-> FALSE]
    /\ wm = [d \in Derivs |-> [k \in WmKeys |-> 0]]
    /\ val = [d \in Derivs |-> [k \in WmKeys |-> <<>>]]
    /\ readBad = FALSE
    /\ cap = [p \in Reps |-> NoCap]

CountOf(r) == Cardinality({i \in 1..Len(log) : log[i].run = r})

NewEvent(r) == [run |-> r, seq |-> CountOf(r) + 1]

AppendO(r) ==
    /\ owner[r] = "O" /\ ~done[r] /\ Len(log) < MaxEvents
    /\ log' = Append(log, NewEvent(r))
    /\ UNCHANGED <<owner, done, wm, val, readBad, cap>>

AppendN(r) ==
    /\ ~done[r] /\ Len(log) < MaxEvents
    /\ LET L2 == Append(log, NewEvent(r))
           i == Len(L2)
           upd(d) == NewD(L2, d, KeyOf(L2, d, i), wm[d][KeyOf(L2, d, i)], PosOf(L2, d, i), Big)
       IN /\ log' = L2
          /\ wm' = [d \in Derivs |-> [wm[d] EXCEPT ![KeyOf(L2, d, i)] = upd(d).w]]
          /\ val' = [d \in Derivs |-> upd(d).v]
    /\ UNCHANGED <<owner, done, readBad, cap>>

Finish(r) ==
    /\ ~done[r]
    /\ done' = [done EXCEPT ![r] = TRUE]
    /\ UNCHANGED <<log, owner, wm, val, readBad, cap>>

CatchUpRun(r) ==
    LET upd(d) == NewD(log, d, KeysFor(d, r), wm[d][KeysFor(d, r)], Big, Big)
    IN /\ wm' = [d \in Derivs |-> [wm[d] EXCEPT ![KeysFor(d, r)] = upd(d).w]]
       /\ val' = [d \in Derivs |-> upd(d).v]

Claim(r) ==
    /\ owner[r] = "O" /\ ~done[r]
    /\ owner' = [owner EXCEPT ![r] = "N"]
    /\ CatchUpRun(r)
    /\ UNCHANGED <<log, done, readBad, cap>>

ReadResult(v, d, vk) ==
    IF ReadRule = "tail" THEN v[d][vk] \o Sorted(PendingAcross(d, vk)) ELSE v[d][vk]

ReadStream(r, d) ==
    /\ d \in Derivs /\ ValScope(d) = "run"
    /\ IF ReadRule = "today"
          THEN CatchUpRun(r)
          ELSE UNCHANGED <<wm, val>>
    /\ readBad' = (readBad \/ ReadResult(val', d, r) # Truth(d, r))
    /\ UNCHANGED <<log, owner, done, cap>>

ReadOther(d, vk) ==
    /\ d \in Derivs /\ vk \in ValKeysOf(d)
    /\ readBad' = (readBad \/ ReadResult(val, d, vk) # Truth(d, vk))
    /\ UNCHANGED <<log, owner, done, wm, val, cap>>

RepairPage(d, k) ==
    /\ Repair = "pageTx"
    /\ d \in Derivs /\ k \in WmKeys
    /\ LET u == NewD(log, d, k, wm[d][k], Big, PageSize)
       IN /\ wm' = [wm EXCEPT ![d][k] = u.w]
          /\ val' = [val EXCEPT ![d] = u.v]
    /\ UNCHANGED <<log, owner, done, readBad, cap>>

RepStart(p, d, k) ==
    /\ Repair # "pageTx"
    /\ ~cap[p].on /\ d \in Derivs /\ k \in WmKeys
    /\ cap' = [cap EXCEPT ![p] = [on |-> TRUE, d |-> d, k |-> k, at |-> wm[d][k]]]
    /\ UNCHANGED <<log, owner, done, wm, val, readBad>>

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
    /\ UNCHANGED <<log, owner, done, readBad>>

RepCrash(p) ==
    /\ cap[p].on
    /\ cap' = [cap EXCEPT ![p] = NoCap]
    /\ UNCHANGED <<log, owner, done, wm, val, readBad>>

Next ==
    \/ \E r \in Runs : AppendO(r) \/ AppendN(r) \/ Finish(r) \/ Claim(r)
    \/ \E r \in Runs, d \in Derivs : ReadStream(r, d)
    \/ \E d \in Derivs, vk \in WmKeys : ReadOther(d, vk)
    \/ \E d \in Derivs, k \in WmKeys : RepairPage(d, k)
    \/ \E p \in Reps : RepStep(p) \/ RepCrash(p)
    \/ \E p \in Reps, d \in Derivs, k \in WmKeys : RepStart(p, d, k)

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ Len(log) <= MaxEvents
    /\ owner \in [Runs -> Gens]
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

MarkMonotone ==
    [][\A d \in Derivs, k \in WmKeys : wm'[d][k] >= wm[d][k]]_vars

RepairIdempotent ==
    [][log' = log =>
        \A d \in Derivs : \A vk \in ValKeysOf(d) :
            val[d][vk] = Truth(d, vk) => val'[d][vk] = val[d][vk]]_vars

=============================================================================
