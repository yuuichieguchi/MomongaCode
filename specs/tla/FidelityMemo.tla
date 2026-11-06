---------------------------- MODULE FidelityMemo ----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Runs, MaxEv, Cwds, Versions, Ref, Open, Handle, Blobs,
          MaxPending, BlobExpiry,
          GapScan, QuiescentThrough, MergeCommit, GuardBlob,
          KeyByCwd, KeyByVersion, RecordUnreadable

VARIABLES cls, len, live, memo, pend, curVer, err

vars == <<cls, len, live, memo, pend, curVer, err>>

Evs == 1..MaxEv
Classes == 0..2
Cw0 == Cwds \cup {0}
Ve0 == Versions \cup {0}
Keys == Runs \X Cw0 \X Ve0
ClsKeys == Versions \X Cwds \X Runs \X Evs

ASSUME /\ \A r \in Runs : Ref[r].src \in 0..(r - 1)
       /\ \A r \in Runs : Ref[r].src = 0 \/ Ref[r].last \in Evs
       /\ \A r \in Runs : \A i \in Evs : Open[r][i] \in 1..i
       /\ \A r \in Runs : \A i \in Evs : Handle[r][i] \in {0} \cup Blobs

IsCall(r, i) == \E j \in Evs : j # i /\ Open[r][j] = i
IsDone(r, i) == Open[r][i] # i
Comp(r, i) == CHOOSE j \in Evs : j # i /\ Open[r][j] = i

ASSUME \A r \in Runs : \A i \in Evs : Handle[r][i] # 0 => IsDone(r, i)

Pending(r, t) == {i \in 2..t : IsCall(r, i) /\ Comp(r, i) > t}
Quiet(r, t) == Pending(r, t) = {}
LargestQuiet(r, n) ==
    CHOOSE t \in 1..n : Quiet(r, t) /\ \A u \in (t + 1)..n : ~Quiet(r, u)

Allowed(f) ==
    IF f[4] = 1 THEN {0, 1}
    ELSE IF IsCall(f[3], f[4]) \/ IsDone(f[3], f[4]) THEN {0, 2}
    ELSE {0, 1, 2}

RECURSIVE FnsOf(_)
FnsOf(S) ==
    IF S = {} THEN {<<>>}
    ELSE LET e == CHOOSE x \in S : TRUE
         IN {[x \in (DOMAIN g) \cup {e} |-> IF x = e THEN v ELSE g[x]] :
                g \in FnsOf(S \ {e}), v \in Allowed(e)}

Max(a, b) == IF a >= b THEN a ELSE b
MaxOf(S) == IF S = {} THEN 0 ELSE CHOOSE x \in S : \A y \in S : y <= x
FirstSeq(S) == IF S = {} THEN 0 ELSE CHOOSE x \in S : \A y \in S : x <= y
MinPos(a, b) == IF a = 0 THEN b ELSE IF b = 0 THEN a ELSE IF a <= b THEN a ELSE b

EmptyRow == [thr |-> 0, inh |-> 0, ts |-> FALSE, sat |-> 0, eat |-> 0, vh |-> 0,
             oc |-> 0, ov |-> 0]
HasRow(row) == row.thr > 0

Rows == [thr : Evs \cup {0}, inh : Classes, ts : BOOLEAN,
         sat : Evs \cup {0}, eat : Evs \cup {0}, vh : {0} \cup Blobs,
         oc : Cw0, ov : Ve0]
Writes == [k : Keys, row : Rows, unr : BOOLEAN]

KeyOf(r, c, v) == <<r, IF KeyByCwd THEN c ELSE 0, IF KeyByVersion THEN v ELSE 0>>

Cl(r, i, c, v) == cls[<<v, c, r, i>>]
Dead(r, i) == Handle[r][i] # 0 /\ ~live[Handle[r][i]]
Eff(r, i, c, v) == IF Dead(r, i) THEN 0 ELSE Cl(r, i, c, v)

ScanSeqs(r, a, b, fin) ==
    {s \in (a + 1)..b : fin \/ ~(IsCall(r, s) /\ Comp(r, s) > b)}
ScanMax(r, a, b, fin, c, v) == MaxOf({Eff(r, s, c, v) : s \in ScanSeqs(r, a, b, fin)})
ScanFirst(r, a, b, fin, c, v, x) ==
    FirstSeq({s \in ScanSeqs(r, a, b, fin) : Eff(r, s, c, v) = x})
ScanUnreadable(r, a, b, fin) == \E s \in ScanSeqs(r, a, b, fin) : Dead(r, s)

RowUsable(row, n) ==
    ~GuardBlob \/ ~(row.eat > 0 /\ row.eat <= n /\ row.vh # 0 /\ ~live[row.vh])

RowClass(row, n, task) ==
    Max(Max(row.inh, IF task /\ row.ts THEN 1 ELSE 0),
        Max(IF row.sat > 0 /\ row.sat <= n THEN 1 ELSE 0,
            IF row.eat > 0 /\ row.eat <= n THEN 2 ELSE 0))

RECURSIVE Verdict(_, _, _, _, _)
Verdict(r, n, task, c, v) ==
    LET row == memo[KeyOf(r, c, v)]
        useRow == HasRow(row) /\ RowUsable(row, n)
        alone == useRow /\ (row.thr >= n \/ ~GapScan)
        gap == useRow /\ ~alone
        sub == IF useRow \/ Ref[r].src = 0
               THEN [cl |-> 0, unr |-> FALSE, fl |-> {}]
               ELSE Verdict(Ref[r].src, Ref[r].last, ~Ref[r].omit, c, v)
        a == IF gap THEN row.thr ELSE 1
        sc == ScanMax(r, a, n, TRUE, c, v)
        rc == RowClass(row, n, task)
        flags == (IF useRow /\ (row.oc # c \/ row.ov # v) THEN {"key"} ELSE {})
                 \cup (IF alone /\ row.thr < n THEN {"past"} ELSE {})
                 \cup (IF useRow /\ row.eat > 0 /\ row.eat <= n /\ row.vh # 0
                          /\ ~live[row.vh] THEN {"dead"} ELSE {})
    IN [cl |-> IF alone THEN rc
               ELSE IF gap THEN Max(rc, sc)
               ELSE Max(Max(sub.cl, IF task THEN Cl(r, 1, c, v) ELSE 0), sc),
        unr |-> IF alone THEN FALSE
                ELSE ScanUnreadable(r, a, n, TRUE) \/ sub.unr,
        fl |-> flags \cup sub.fl,
        inh |-> IF useRow THEN row.inh ELSE sub.cl,
        mode |-> IF alone THEN "alone" ELSE IF gap THEN "gap" ELSE "fresh"]

RECURSIVE FreshV(_, _, _, _, _)
FreshV(r, n, task, c, v) ==
    Max(IF Ref[r].src = 0 THEN 0
        ELSE FreshV(Ref[r].src, Ref[r].last, ~Ref[r].omit, c, v),
        Max(MaxOf({Eff(r, s, c, v) : s \in 2..n}),
            IF task THEN Cl(r, 1, c, v) ELSE 0))

RECURSIVE IntV(_, _, _, _, _)
IntV(r, n, task, c, v) ==
    Max(IF Ref[r].src = 0 THEN 0
        ELSE IntV(Ref[r].src, Ref[r].last, ~Ref[r].omit, c, v),
        Max(MaxOf({Cl(r, s, c, v) : s \in 2..n}),
            IF task THEN Cl(r, 1, c, v) ELSE 0))

IntRow(r, t, c, v) ==
    LET eat == FirstSeq({s \in 2..t : Cl(r, s, c, v) = 2})
    IN [thr |-> t,
        inh |-> IF Ref[r].src = 0 THEN 0
                ELSE IntV(Ref[r].src, Ref[r].last, ~Ref[r].omit, c, v),
        ts |-> Cl(r, 1, c, v) = 1,
        sat |-> FirstSeq({s \in 2..t : Cl(r, s, c, v) = 1}),
        eat |-> eat,
        vh |-> IF eat = 0 THEN 0 ELSE Handle[r][eat],
        oc |-> c, ov |-> v]

RECURSIVE ChainReady(_)
ChainReady(r) ==
    IF Ref[r].src = 0 THEN TRUE
    ELSE len[Ref[r].src] >= Ref[r].last /\ ChainReady(Ref[r].src)

Merge(a, b) ==
    IF ~HasRow(a) THEN b
    ELSE [thr |-> Max(a.thr, b.thr),
          inh |-> Max(a.inh, b.inh),
          ts |-> a.ts \/ b.ts,
          sat |-> MinPos(a.sat, b.sat),
          eat |-> MinPos(a.eat, b.eat),
          vh |-> IF a.eat = 0 THEN b.vh
                 ELSE IF b.eat = 0 THEN a.vh
                 ELSE IF a.eat <= b.eat THEN a.vh ELSE b.vh,
          oc |-> b.oc, ov |-> b.ov]

TypeOK ==
    /\ \A f \in ClsKeys : cls[f] \in Allowed(f)
    /\ len \in [Runs -> 0..MaxEv]
    /\ live \in [Blobs -> BOOLEAN]
    /\ memo \in [Keys -> Rows]
    /\ pend \subseteq Writes
    /\ curVer \in Versions
    /\ err \subseteq {"result", "past", "dead", "key", "unmeasured"}

Init ==
    /\ cls \in FnsOf(ClsKeys)
    /\ len = [r \in Runs |-> 0]
    /\ live = [h \in Blobs |-> TRUE]
    /\ memo = [K \in Keys |-> EmptyRow]
    /\ pend = {}
    /\ curVer = 1
    /\ err = {}

Append(r) ==
    /\ len[r] < MaxEv
    /\ len' = [len EXCEPT ![r] = @ + 1]
    /\ UNCHANGED <<cls, live, memo, pend, curVer, err>>

Compute(r, n, c) ==
    /\ n <= len[r]
    /\ ChainReady(r)
    /\ Cardinality(pend) < MaxPending
    /\ LET v == Verdict(r, n, TRUE, c, curVer)
           K == KeyOf(r, c, curVer)
           row == memo[K]
           q == IF QuiescentThrough THEN LargestQuiet(r, n) ELSE n
           a == IF v.mode = "gap" THEN row.thr ELSE 1
           base == IF v.mode = "gap" THEN row ELSE EmptyRow
           eatS == ScanFirst(r, a, q, FALSE, c, curVer, 2)
           eat == MinPos(base.eat, eatS)
           newRow == [thr |-> q,
                      inh |-> v.inh,
                      ts |-> Cl(r, 1, c, curVer) = 1,
                      sat |-> MinPos(base.sat, ScanFirst(r, a, q, FALSE, c, curVer, 1)),
                      eat |-> eat,
                      vh |-> IF base.eat # 0 /\ (eatS = 0 \/ base.eat <= eatS)
                             THEN base.vh
                             ELSE IF eatS # 0 THEN Handle[r][eatS] ELSE 0,
                      oc |-> c, ov |-> curVer]
           writes == v.mode # "alone" /\ q > base.thr
                     /\ (RecordUnreadable \/ ~v.unr)
       IN /\ pend' = IF writes
                     THEN pend \cup {[k |-> K, row |-> newRow, unr |-> v.unr]}
                     ELSE pend
          /\ err' = err \cup v.fl
                        \cup (IF v.cl # FreshV(r, n, TRUE, c, curVer)
                              THEN {"result"} ELSE {})
    /\ UNCHANGED <<cls, len, live, memo, curVer>>

Commit(w) ==
    /\ memo' = [memo EXCEPT ![w.k] = IF MergeCommit THEN Merge(@, w.row) ELSE w.row]
    /\ pend' = pend \ {w}
    /\ err' = IF w.unr THEN err \cup {"unmeasured"} ELSE err
    /\ UNCHANGED <<cls, len, live, curVer>>

BlobExpire(h) ==
    /\ BlobExpiry
    /\ live[h]
    /\ live' = [live EXCEPT ![h] = FALSE]
    /\ UNCHANGED <<cls, len, memo, pend, curVer, err>>

BumpVersion ==
    /\ curVer + 1 \in Versions
    /\ curVer' = curVer + 1
    /\ UNCHANGED <<cls, len, live, memo, pend, err>>

Next ==
    \/ \E r \in Runs : Append(r)
    \/ \E r \in Runs, n \in Evs, c \in Cwds : Compute(r, n, c)
    \/ \E w \in pend : Commit(w)
    \/ \E h \in Blobs : BlobExpire(h)
    \/ BumpVersion

Spec == Init /\ [][Next]_vars

ResultEqualsFresh == "result" \notin err
NoPastBound == "past" \notin err
GuardedPositive == "dead" \notin err
KeyedByCwdAndVersion == "key" \notin err
NoUnmeasuredRecord == "unmeasured" \notin err

QuiescentBoundary ==
    \A K \in Keys : HasRow(memo[K]) => Quiet(K[1], memo[K].thr)

RowSound ==
    \A K \in Keys :
        LET row == memo[K]
        IN HasRow(row) => row = IntRow(K[1], row.thr, row.oc, row.ov)

MonotoneStep ==
    \A K \in Keys :
        LET a == memo[K]
            b == memo'[K]
        IN HasRow(a) =>
            /\ b.thr >= a.thr
            /\ b.inh >= a.inh
            /\ (a.ts => b.ts)
            /\ (a.sat > 0 => (b.sat > 0 /\ b.sat <= a.sat))
            /\ (a.eat > 0 => (b.eat > 0 /\ b.eat <= a.eat))

MonotoneRow == [][MonotoneStep]_vars

CommitsCommute ==
    \A w1, w2 \in pend :
        w1.k = w2.k =>
            Merge(Merge(memo[w1.k], w1.row), w2.row)
                = Merge(Merge(memo[w1.k], w2.row), w1.row)

RefMid == [r \in Runs |->
    IF r = 1 THEN [src |-> 0, last |-> 0, omit |-> FALSE]
    ELSE [src |-> r - 1, last |-> 2, omit |-> FALSE]]
RefWhole == [r \in Runs |->
    IF r = 1 THEN [src |-> 0, last |-> 0, omit |-> FALSE]
    ELSE [src |-> r - 1, last |-> MaxEv, omit |-> FALSE]]
RefOmit == [r \in Runs |->
    IF r = 1 THEN [src |-> 0, last |-> 0, omit |-> FALSE]
    ELSE [src |-> r - 1, last |-> 2, omit |-> TRUE]]

OpenPlain == [r \in Runs |-> [i \in Evs |-> i]]
OpenCall == [r \in Runs |-> [i \in Evs |-> IF r = 1 /\ i = 3 THEN 2 ELSE i]]
OpenCallLeaf == [r \in Runs |-> [i \in Evs |-> IF r = 2 /\ i = 3 THEN 2 ELSE i]]
OpenCallAll == [r \in Runs |-> [i \in Evs |-> IF i = 3 THEN 2 ELSE i]]

HandleNone == [r \in Runs |-> [i \in Evs |-> 0]]
HandleLeaf == [r \in Runs |-> [i \in Evs |-> IF r = 2 /\ i = 3 THEN 1 ELSE 0]]
HandleSource == [r \in Runs |-> [i \in Evs |-> IF r = 1 /\ i = 3 THEN 1 ELSE 0]]

=============================================================================
