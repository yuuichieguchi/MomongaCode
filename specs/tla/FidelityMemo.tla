---------------------------- MODULE FidelityMemo ----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Runs, MaxEv, Cwds, Versions, Ref, Kind, Of, Handle, Blobs,
          MaxPending, BlobExpiry, D9,
          GapScan, QuiescentThrough, MergeCommit, GuardBlob,
          KeyByCwd, KeyByVersion, RecordUnreadable,
          DropInhDeps, StoreFinish, ScanReconEnds, ScanDenialOffers,
          AloneNeedsQuiet

VARIABLES cls, len, live, memo, pend, curVer, err

vars == <<cls, len, live, memo, pend, curVer, err>>

Evs == 1..MaxEv
Classes == 0..2
Cw0 == Cwds \cup {0}
Ve0 == Versions \cup {0}
Keys == Runs \X Cw0 \X Ve0
ClsKeys == Versions \X Cwds \X Runs \X Evs
Strict == D9 = "strict"
Kinds == {"task", "stated", "instr", "call", "start", "done", "denied",
          "recA", "recN", "recU", "noop"}

ASSUME /\ D9 \in {"current", "strict"}
       /\ \A r \in Runs : Ref[r].src \in 0..(r - 1)
       /\ \A r \in Runs : Ref[r].src = 0 \/ Ref[r].last \in Evs
       /\ \A r \in Runs : \A i \in Evs : Kind[r][i] \in Kinds
       /\ \A r \in Runs : Kind[r][1] = "task"
       /\ \A r \in Runs : \A i \in 2..MaxEv : Kind[r][i] # "task"
       /\ \A r \in Runs : \A i \in Evs : Of[r][i] \in 1..i
       /\ \A r \in Runs : \A i \in Evs :
            Kind[r][i] \in {"start", "done", "denied", "recA", "recN", "recU"}
                => (Of[r][i] < i /\ Kind[r][Of[r][i]] = "call")
       /\ \A r \in Runs : \A i \in Evs :
            Kind[r][i] \notin {"start", "done", "denied", "recA", "recN", "recU"}
                => Of[r][i] = i
       /\ \A r \in Runs : \A i \in Evs : Handle[r][i] \in {0} \cup Blobs
       /\ \A r \in Runs : \A i \in Evs : Handle[r][i] # 0 => Kind[r][i] = "done"

IsRec(r, i) == Kind[r][i] \in {"recA", "recN", "recU"}

Allowed(f) ==
    CASE Kind[f[3]][f[4]] \in {"task", "stated"} -> {0, 1}
      [] Kind[f[3]][f[4]] \in {"instr", "call", "done", "recA", "recN", "recU"} -> {0, 2}
      [] OTHER -> {0}

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

EmptyRow == [thr |-> 0, inh |-> 0, idep |-> 0, ts |-> FALSE, sat |-> 0,
             eat |-> 0, edep |-> 0, oc |-> 0, ov |-> 0]
HasRow(row) == row.thr > 0

Rows == [thr : Evs \cup {0}, inh : Classes, idep : {0} \cup Blobs, ts : BOOLEAN,
         sat : Evs \cup {0}, eat : Evs \cup {0}, edep : {0} \cup Blobs,
         oc : Cw0, ov : Ve0]
Writes == [k : Keys, row : Rows, unr : BOOLEAN, fin : BOOLEAN]

KeyOf(r, c, v) == <<r, IF KeyByCwd THEN c ELSE 0, IF KeyByVersion THEN v ELSE 0>>

Cl(r, i, c, v) == cls[<<v, c, r, i>>]
Dead(r, i) == Handle[r][i] # 0 /\ ~live[Handle[r][i]]

TrueSem == [ig |-> FALSE, re |-> Strict, dn |-> FALSE]
IntSem == [ig |-> TRUE, re |-> Strict, dn |-> FALSE]
ScanSem == [ig |-> FALSE, re |-> Strict \/ ScanReconEnds, dn |-> ScanDenialOffers]

StepState(r, k, s, re) ==
    CASE Kind[r][k] = "call" -> [p |-> s.p \cup {k}, st |-> s.st]
      [] Kind[r][k] = "start" ->
            [p |-> s.p, st |-> IF Of[r][k] \in s.p THEN s.st \cup {Of[r][k]} ELSE s.st]
      [] Kind[r][k] \in {"done", "denied"} ->
            [p |-> s.p \ {Of[r][k]}, st |-> s.st \ {Of[r][k]}]
      [] IsRec(r, k) ->
            IF re THEN [p |-> s.p \ {Of[r][k]}, st |-> s.st \ {Of[r][k]}] ELSE s
      [] OTHER -> s

RECURSIVE St(_, _, _, _)
St(r, a, t, re) ==
    IF t <= a THEN [p |-> {}, st |-> {}] ELSE StepState(r, t, St(r, a, t - 1, re), re)

Offers(r, a, k, c, v, sm) ==
    LET s == St(r, a, k - 1, sm.re)
        pnd == Of[r][k] \in s.p
        args == IF pnd THEN {[cl |-> Cl(r, Of[r][k], c, v), dep |-> 0]} ELSE {}
        out == {[cl |-> IF ~sm.ig /\ Dead(r, k) THEN 0 ELSE Cl(r, k, c, v),
                 dep |-> Handle[r][k]]}
        txt == {[cl |-> Cl(r, k, c, v), dep |-> 0]}
        all == CASE Kind[r][k] \in {"stated", "instr"} -> txt
                 [] Kind[r][k] = "done" -> args \cup out
                 [] Kind[r][k] = "denied" -> IF sm.dn THEN args ELSE {}
                 [] IsRec(r, k) ->
                       txt \cup (IF Strict /\ Kind[r][k] = "recA" THEN args ELSE {})
                 [] OTHER -> {}
    IN {o \in all : o.cl > 0}

OfferSeqs(r, a, b, x, c, v, sm) ==
    {k \in (a + 1)..b : \E o \in Offers(r, a, k, c, v, sm) : o.cl = x}
SatF(r, a, b, c, v, sm) == FirstSeq(OfferSeqs(r, a, b, 1, c, v, sm))
EatF(r, a, b, c, v, sm) == FirstSeq(OfferSeqs(r, a, b, 2, c, v, sm))
EdepF(r, a, b, c, v, sm) ==
    LET e == EatF(r, a, b, c, v, sm)
        os == {o \in Offers(r, a, e, c, v, sm) : o.cl = 2}
    IN IF e = 0 THEN 0
       ELSE IF \E o \in os : o.dep = 0 THEN 0
       ELSE (CHOOSE o \in os : TRUE).dep
UnrF(r, a, b) == \E k \in (a + 1)..b : Kind[r][k] = "done" /\ Dead(r, k)
FinCl(r, a, b, c, v, re) ==
    IF Strict THEN 0 ELSE MaxOf({Cl(r, x, c, v) : x \in St(r, a, b, re).st})

QuietS(r, t) == St(r, 1, t, ScanSem.re).p = {}
TrueQuiet(r, t) == St(r, 1, t, Strict).p = {}
LargestQuiet(r, n) ==
    CHOOSE t \in 1..n : QuietS(r, t) /\ \A u \in (t + 1)..n : ~QuietS(r, u)

Wit(inhCl, inhDep, tsOn, sat, eat, edep, n, fin) ==
    LET cl == Max(Max(inhCl, IF tsOn THEN 1 ELSE 0),
                  Max(Max(IF sat > 0 /\ sat <= n THEN 1 ELSE 0,
                          IF eat > 0 /\ eat <= n THEN 2 ELSE 0), fin))
    IN [cl |-> cl,
        dep |-> IF cl = 2
                THEN (IF inhCl = 2 THEN inhDep
                      ELSE IF eat > 0 /\ eat <= n THEN edep ELSE 0)
                ELSE 0]

RowUsable(row, n, r, c, v) ==
    ~GuardBlob \/ (~(row.eat > 0 /\ row.eat <= n /\ row.edep # 0 /\ ~live[row.edep])
                   /\ ~(row.idep # 0 /\ ~live[row.idep]))

RECURSIVE FoldV(_, _, _, _, _, _)
FoldV(sm, r, n, task, c, v) ==
    LET inh == IF Ref[r].src = 0 THEN [cl |-> 0, dep |-> 0]
               ELSE FoldV(sm, Ref[r].src, Ref[r].last, ~Ref[r].omit, c, v)
    IN Wit(inh.cl, inh.dep, task /\ Cl(r, 1, c, v) = 1,
           SatF(r, 1, n, c, v, sm), EatF(r, 1, n, c, v, sm), EdepF(r, 1, n, c, v, sm),
           n, FinCl(r, 1, n, c, v, sm.re))

TrueInhDep(r, c, v) ==
    IF Ref[r].src = 0 THEN 0
    ELSE FoldV(IntSem, Ref[r].src, Ref[r].last, ~Ref[r].omit, c, v).dep

RECURSIVE Verdict(_, _, _, _, _)
Verdict(r, n, task, c, v) ==
    LET row == memo[KeyOf(r, c, v)]
        useRow == HasRow(row) /\ RowUsable(row, n, r, c, v)
                  /\ ~(AloneNeedsQuiet /\ row.thr >= n /\ ~QuietS(r, n))
        alone == useRow /\ (row.thr >= n \/ ~GapScan)
        gap == useRow /\ ~alone
        sub == IF useRow \/ Ref[r].src = 0
               THEN [cl |-> 0, dep |-> 0, unr |-> FALSE, fl |-> {}]
               ELSE Verdict(Ref[r].src, Ref[r].last, ~Ref[r].omit, c, v)
        a == IF gap THEN row.thr ELSE 1
        b == IF useRow THEN row
             ELSE [EmptyRow EXCEPT !.inh = sub.cl, !.idep = sub.dep,
                                   !.ts = (Cl(r, 1, c, v) = 1)]
        gS == IF alone THEN 0 ELSE SatF(r, a, n, c, v, ScanSem)
        gE == IF alone THEN 0 ELSE EatF(r, a, n, c, v, ScanSem)
        gD == IF alone THEN 0 ELSE EdepF(r, a, n, c, v, ScanSem)
        sat == MinPos(b.sat, gS)
        eat == MinPos(b.eat, gE)
        edep == IF b.eat # 0 /\ (gE = 0 \/ b.eat <= gE) THEN b.edep ELSE gD
        fin == IF alone THEN 0 ELSE FinCl(r, a, n, c, v, ScanSem.re)
        w == Wit(b.inh, b.idep, task /\ b.ts, sat, eat, edep, n, fin)
        ownDead == useRow /\ row.eat > 0 /\ row.eat <= n /\ row.edep # 0
                   /\ ~live[row.edep]
        tid == TrueInhDep(r, c, v)
        inhDead == useRow /\ tid # 0 /\ ~live[tid]
        flags == (IF useRow /\ (row.oc # c \/ row.ov # v) THEN {"key"} ELSE {})
                 \cup (IF alone /\ row.thr < n THEN {"past"} ELSE {})
                 \cup (IF ownDead \/ inhDead THEN {"dead"} ELSE {})
    IN [cl |-> w.cl, dep |-> w.dep,
        unr |-> IF alone THEN FALSE ELSE UnrF(r, a, n) \/ sub.unr,
        fl |-> flags \cup sub.fl,
        b |-> b, a |-> a,
        mode |-> IF alone THEN "alone" ELSE IF gap THEN "gap" ELSE "fresh"]

RECURSIVE ChainReady(_)
ChainReady(r) ==
    IF Ref[r].src = 0 THEN TRUE
    ELSE len[Ref[r].src] >= Ref[r].last /\ ChainReady(Ref[r].src)

IntRow(r, t, c, v) ==
    LET inh == IF Ref[r].src = 0 THEN [cl |-> 0, dep |-> 0]
               ELSE FoldV(IntSem, Ref[r].src, Ref[r].last, ~Ref[r].omit, c, v)
    IN [thr |-> t, inh |-> inh.cl, idep |-> inh.dep,
        ts |-> Cl(r, 1, c, v) = 1,
        sat |-> SatF(r, 1, t, c, v, IntSem),
        eat |-> EatF(r, 1, t, c, v, IntSem),
        edep |-> EdepF(r, 1, t, c, v, IntSem),
        oc |-> c, ov |-> v]

Merge(a, b) ==
    IF ~HasRow(a) THEN b
    ELSE [thr |-> Max(a.thr, b.thr),
          inh |-> Max(a.inh, b.inh),
          idep |-> IF a.inh >= b.inh THEN a.idep ELSE b.idep,
          ts |-> a.ts \/ b.ts,
          sat |-> MinPos(a.sat, b.sat),
          eat |-> MinPos(a.eat, b.eat),
          edep |-> IF a.eat = 0 THEN b.edep
                   ELSE IF b.eat = 0 THEN a.edep
                   ELSE IF a.eat <= b.eat THEN a.edep ELSE b.edep,
          oc |-> b.oc, ov |-> b.ov]

TypeOK ==
    /\ \A f \in ClsKeys : cls[f] \in Allowed(f)
    /\ len \in [Runs -> 0..MaxEv]
    /\ live \in [Blobs -> BOOLEAN]
    /\ memo \in [Keys -> Rows]
    /\ pend \subseteq Writes
    /\ curVer \in Versions
    /\ err \subseteq {"result", "past", "dead", "key", "unmeasured", "finish"}

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
           q == IF QuiescentThrough THEN LargestQuiet(r, n) ELSE n
           a == v.a
           b == IF v.mode = "gap" THEN v.b ELSE [v.b EXCEPT !.thr = 0]
           gE == EatF(r, a, q, c, curVer, ScanSem)
           noFin == [thr |-> q,
                     inh |-> b.inh,
                     idep |-> IF DropInhDeps THEN 0 ELSE b.idep,
                     ts |-> Cl(r, 1, c, curVer) = 1,
                     sat |-> MinPos(b.sat, SatF(r, a, q, c, curVer, ScanSem)),
                     eat |-> MinPos(b.eat, gE),
                     edep |-> IF b.eat # 0 /\ (gE = 0 \/ b.eat <= gE) THEN b.edep
                              ELSE EdepF(r, a, q, c, curVer, ScanSem),
                     oc |-> c, ov |-> curVer]
           finCl == FinCl(r, a, n, c, curVer, ScanSem.re)
           withFin == IF StoreFinish /\ finCl = 2
                      THEN [noFin EXCEPT !.eat = MinPos(@, n),
                                         !.edep = IF noFin.eat = 0 \/ n < noFin.eat
                                                  THEN 0 ELSE @]
                      ELSE noFin
           writes == v.mode # "alone" /\ q > b.thr /\ (RecordUnreadable \/ ~v.unr)
       IN /\ pend' = IF writes
                     THEN pend \cup {[k |-> K, row |-> withFin, unr |-> v.unr,
                                      fin |-> withFin # noFin]}
                     ELSE pend
          /\ err' = err \cup v.fl
                        \cup (IF v.cl # FoldV(TrueSem, r, n, TRUE, c, curVer).cl
                              THEN {"result"} ELSE {})
    /\ UNCHANGED <<cls, len, live, memo, curVer>>

Commit(w) ==
    /\ memo' = [memo EXCEPT ![w.k] = IF MergeCommit THEN Merge(@, w.row) ELSE w.row]
    /\ pend' = pend \ {w}
    /\ err' = err \cup (IF w.unr THEN {"unmeasured"} ELSE {})
                  \cup (IF w.fin THEN {"finish"} ELSE {})
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
FinishNotStored == "finish" \notin err

QuiescentBoundary ==
    \A K \in Keys : HasRow(memo[K]) => TrueQuiet(K[1], memo[K].thr)

RowSound ==
    \A K \in Keys :
        LET row == memo[K]
            ir == IntRow(K[1], row.thr, row.oc, row.ov)
        IN HasRow(row) =>
            /\ row.inh = ir.inh /\ row.ts = ir.ts
            /\ row.sat = ir.sat /\ row.eat = ir.eat

DepsComplete ==
    \A K \in Keys :
        LET row == memo[K]
            ir == IntRow(K[1], row.thr, row.oc, row.ov)
        IN HasRow(row) => row.idep = ir.idep /\ row.edep = ir.edep

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

Src1 == [src |-> 0, last |-> 0, omit |-> FALSE]
RefL3 == [r \in Runs |-> IF r = 1 THEN Src1 ELSE [src |-> r - 1, last |-> 3, omit |-> FALSE]]
RefL4 == [r \in Runs |-> IF r = 1 THEN Src1 ELSE [src |-> r - 1, last |-> 4, omit |-> FALSE]]
RefOmit == [r \in Runs |-> IF r = 1 THEN Src1 ELSE [src |-> r - 1, last |-> 3, omit |-> TRUE]]

Plain4 == <<"task", "stated", "instr", "noop">>
Ident4 == <<1, 2, 3, 4>>
Ident5 == <<1, 2, 3, 4, 5>>

KBase == <<"task", "call", "start", "done">>
KDenied == <<"task", "call", "start", "denied">>
KOpen == <<"task", "call", "instr", "start">>
KRecA == <<"task", "call", "start", "recA">>
KRecU == <<"task", "call", "start", "recU">>
KRecN5 == <<"task", "call", "start", "recN", "done">>
Plain5 == <<"task", "stated", "instr", "noop", "noop">>
OfCall == <<1, 2, 2, 2>>
OfOpen == <<1, 2, 3, 2>>
OfCall5 == <<1, 2, 2, 2, 2>>

KindsOne(s) == [r \in Runs |-> IF r = 1 THEN s ELSE Plain4]
OfsOne(o) == [r \in Runs |-> IF r = 1 THEN o ELSE Ident4]
KindsLeaf(s) == [r \in Runs |-> IF r = 1 THEN Plain4 ELSE s]
OfsLeaf(o) == [r \in Runs |-> IF r = 1 THEN Ident4 ELSE o]

Bare4 == <<"task", "noop", "noop", "noop">>
KindBaseBare == [r \in Runs |-> IF r = 1 THEN KBase ELSE Bare4]
KindBase == KindsOne(KBase)
KindDenied == KindsOne(KDenied)
KindOpen == KindsOne(KOpen)
KindRecA == KindsOne(KRecA)
KindRecU == KindsOne(KRecU)
KindRecN5 == [r \in Runs |-> IF r = 1 THEN KRecN5 ELSE Plain5]
KindLeaf == KindsLeaf(KBase)
KindLeafBare == [r \in Runs |-> IF r = 1 THEN Bare4 ELSE KBase]
OfBase == OfsOne(OfCall)
OfOpenAll == OfsOne(OfOpen)
OfRecN5 == [r \in Runs |-> IF r = 1 THEN OfCall5 ELSE Ident5]
OfLeaf == OfsLeaf(OfCall)

HandleNone == [r \in Runs |-> [i \in Evs |-> 0]]
HandleLeaf == [r \in Runs |-> [i \in Evs |-> IF r = 2 /\ i = 4 THEN 1 ELSE 0]]
HandleSource == [r \in Runs |-> [i \in Evs |-> IF r = 1 /\ i = 4 THEN 1 ELSE 0]]

=============================================================================
