---------------------------- MODULE InheritRef ----------------------------
(***************************************************************************)
(* Design model of inheritance by reference (design-offloop-journal-work   *)
(* section 13, decision 35 (b)). The child's context.inherited event holds *)
(* the reference only; the history is read from the original records on    *)
(* the journal thread.                                                     *)
(*                                                                         *)
(* Runs: A is a terminal predecessor with two item records (and, in one    *)
(* initial state, a compaction). C is the child. With Chain, B sits        *)
(* between: A <- B <- C. B writes its own final record (an item or a       *)
(* compaction) and ends.                                                   *)
(*                                                                         *)
(* Positions: an item has an absolute position in one numbering shared by  *)
(* the chain (13.5); a compaction record replaces every item up to its     *)
(* position (the floor). The oracle OldHist is the fold of today's code:   *)
(* the copy that projectInheritance would have written for the prefix.     *)
(*                                                                         *)
(* Abstractions: item content, token counts and the window bound (a        *)
(* property of the reader, tested), synthesised items, omitSeqs, via and   *)
(* never-started runs, the SQL ranges, the order of the thread's units.    *)
(* A run's own compaction is written only with its final record. A zombie *)
(* holder can still read a terminal run after that record and gets the     *)
(* window above the run's own floor; that window is never built (Use is    *)
(* fenced), so ReadEqualsInheritAtWrite is stated for the windows that     *)
(* reach a build. The first build is the only build modelled.              *)
(*                                                                         *)
(* Configurations (scripts/tlc.sh <name>, specs/tla/<name>.cfg)            *)
(*   InheritRef             check: P and C, every safety property          *)
(*   InheritRef.chain       check, deep tier: A, B, C, B's reference new   *)
(*                          or legacy, a worker crash, a daemon crash and  *)
(*                          a stall                                        *)
(*   InheritRef.chainSmall  check: the same chain with one daemon crash    *)
(*                          and no worker crash or stall                   *)
(*   InheritRef.live        check: UseEventually under LiveSpec            *)
(*   InheritRef.copyOnInherit, .readsLatest, .noAlreadyCheck,              *)
(*   .noWalkedCheck, .readAppends: evidence, each violates one property    *)
(*                                                                         *)
(* Variants (constants), each one removes one rule of the design:          *)
(*   CopyOnInherit  the new event carries the items                        *)
(*   ReadsLatest    the read ignores fromLastSeq                           *)
(*   NoAlreadyCheck no claim-time, plan-time or commit-time check for an   *)
(*                  existing reference                                     *)
(*   NoWalkedCheck  the commit does not compare the predecessor's lastSeq  *)
(*   ReadAppends    the read writes a record                               *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Chain,
    AllowLegacy,
    MaxService,
    MaxWorkerCrashes,
    MaxDaemonCrashes,
    MaxStalls,
    CopyOnInherit,
    ReadsLatest,
    NoAlreadyCheck,
    NoWalkedCheck,
    ReadAppends

Runs == IF Chain THEN {"A", "B", "C"} ELSE {"A", "C"}
Children == Runs \ {"A"}
Src(r) == IF r = "C" THEN (IF Chain THEN "B" ELSE "A") ELSE "A"
Workers == {1, 2}
Slots == Children \X Workers
Pcs == {"none", "idle", "planned", "committed", "read", "used", "dead", "lost"}
Live == {"idle", "planned", "committed", "read", "used"}

NoPtr == [run |-> "none", idx |-> 0]
NoPlan == [none |-> TRUE]
NoWin == <<[none |-> TRUE]>>

VARIABLES
    ev,
    st,
    nsvc,
    lease,
    tok,
    pc,
    wtok,
    plan,
    win,
    wcr,
    dcr,
    stalls,
    builds,
    staleRef,
    readWrote

vars == <<ev, st, nsvc, lease, tok, pc, wtok, plan, win, wcr, dcr, stalls, builds, staleRef, readWrote>>

ItemEv == [k |-> "i"]
CompEv(t) == [k |-> "c", through |-> t]

Max(S) == CHOOSE x \in S : \A y \in S : y <= x

HasRef(r) == Len(ev[r]) > 0 /\ ev[r][1].k = "ref"
RefCount(r) == Cardinality({e \in 1..Len(ev[r]) : ev[r][e].k = "ref"})

ItemsIn(r, u) == Cardinality({e \in 1..u : ev[r][e].k = "i"})
Base(r) == IF HasRef(r) THEN ev[r][1].next - 1 ELSE 0
NextPos(r, u) == Base(r) + ItemsIn(r, u) + 1

RECURSIVE OwnPairs(_, _)
OwnPairs(r, u) ==
    IF u = 0 THEN <<>>
    ELSE IF ev[r][u].k = "i"
            THEN Append(OwnPairs(r, u - 1), <<Base(r) + ItemsIn(r, u), <<r, u>>>>)
            ELSE OwnPairs(r, u - 1)

Cuts(r, u) == {e \in 1..u : ev[r][e].k = "c"}

Ptr(r, u) ==
    IF Cuts(r, u) # {} THEN [run |-> r, idx |-> Max(Cuts(r, u))]
    ELSE IF HasRef(r) /\ u >= 1 THEN ev[r][1].comp
    ELSE NoPtr

FloorOf(p) == IF p.run = "none" THEN 0 ELSE ev[p.run][p.idx].through

Above(seq, f) == SelectSeq(seq, LAMBDA p : p[1] > f)

RECURSIVE OldHist(_, _)
OldHist(r, u) ==
    IF u = 0 THEN <<>>
    ELSE LET prev == OldHist(r, u - 1)
             e == ev[r][u]
         IN IF e.k = "i" THEN Append(prev, <<Base(r) + ItemsIn(r, u), <<r, u>>>>)
            ELSE IF e.k = "c" THEN Above(prev, e.through)
            ELSE IF e.k = "ref" /\ e.form = "legacy" THEN e.carried
            ELSE IF e.k = "ref" THEN OldHist(e.from, e.last)
            ELSE prev

RECURSIVE Resolve(_, _)
Resolve(r, u) ==
    IF u < 1 \/ ~HasRef(r) THEN [p |-> OwnPairs(r, u), runs |-> {r}]
    ELSE LET f == ev[r][1]
         IN IF f.form = "legacy"
               THEN [p |-> f.carried \o OwnPairs(r, u), runs |-> {r}]
               ELSE LET s == Resolve(f.from, f.last)
                    IN [p |-> s.p \o OwnPairs(r, u), runs |-> s.runs \cup {r}]

OwnFloor(r) == IF Cuts(r, Len(ev[r])) = {} THEN 0 ELSE ev[r][Max(Cuts(r, Len(ev[r])))].through

WindowOf(r) ==
    LET f == ev[r][1]
        upTo == IF ReadsLatest THEN Len(ev[f.from]) ELSE f.last
        res == Resolve(f.from, upTo)
        floor == IF FloorOf(f.comp) > OwnFloor(r) THEN FloorOf(f.comp) ELSE OwnFloor(r)
    IN Above(res.p, floor)

Fenced(s) == lease[s[1]] = "held" /\ tok[s[1]] = wtok[s]

HolderAlive(r) == \E w \in Workers : pc[<<r, w>>] \in Live /\ wtok[<<r, w>>] = tok[r]

Ids(seq) == {seq[i][2] : i \in 1..Len(seq)}

TypeOK ==
    /\ \A r \in Runs : \A e \in 1..Len(ev[r]) : ev[r][e].k \in {"i", "c", "ref", "r"}
    /\ st \in [Runs -> {"fresh", "active", "terminal"}]
    /\ nsvc \in 0..MaxService
    /\ lease \in [Children -> {"free", "held"}]
    /\ tok \in [Children -> Nat]
    /\ pc \in [Slots -> Pcs]
    /\ wtok \in [Slots -> Nat]
    /\ wcr \in 0..MaxWorkerCrashes
    /\ dcr \in 0..MaxDaemonCrashes
    /\ stalls \in 0..MaxStalls
    /\ \A s \in Slots : plan[s] = NoPlan \/ (plan[s].last \in Nat /\ plan[s].next \in Nat)
    /\ \A s \in Slots : win[s] = NoWin \/ \A i \in 1..Len(win[s]) : win[s][i][1] \in Nat
    /\ \A r \in Children : \A b \in builds[r] : b # NoWin
    /\ staleRef \in BOOLEAN
    /\ readWrote \in BOOLEAN

Init ==
    /\ ev \in {[r \in Runs |-> IF r = "A" THEN <<ItemEv, ItemEv>> ELSE <<>>],
               [r \in Runs |-> IF r = "A" THEN <<ItemEv, ItemEv, CompEv(1)>> ELSE <<>>]}
    /\ st = [r \in Runs |-> IF r = "A" THEN "terminal" ELSE "fresh"]
    /\ nsvc = 0
    /\ lease = [r \in Children |-> "free"]
    /\ tok = [r \in Children |-> 0]
    /\ pc = [s \in Slots |-> "none"]
    /\ wtok = [s \in Slots |-> 0]
    /\ plan = [s \in Slots |-> NoPlan]
    /\ win = [s \in Slots |-> NoWin]
    /\ wcr = 0
    /\ dcr = 0
    /\ stalls = 0
    /\ builds = [r \in Children |-> {}]
    /\ staleRef = FALSE
    /\ readWrote = FALSE

ServiceAppend(r) ==
    /\ st[r] = "terminal"
    /\ nsvc < MaxService
    /\ nsvc' = nsvc + 1
    /\ ev' = [ev EXCEPT ![r] = Append(@, ItemEv)]
    /\ UNCHANGED <<st, lease, tok, pc, wtok, plan, win, wcr, dcr, stalls, builds, staleRef, readWrote>>

Claim(s) ==
    LET r == s[1]
    IN /\ st[r] # "terminal"
       /\ lease[r] = "free"
       /\ pc[s] \in {"none", "dead", "lost"}
       /\ lease' = [lease EXCEPT ![r] = "held"]
       /\ tok' = [tok EXCEPT ![r] = @ + 1]
       /\ wtok' = [wtok EXCEPT ![s] = tok[r] + 1]
       /\ pc' = [pc EXCEPT ![s] = "idle"]
       /\ plan' = [plan EXCEPT ![s] = NoPlan]
       /\ win' = [win EXCEPT ![s] = NoWin]
       /\ UNCHANGED <<ev, st, nsvc, wcr, dcr, stalls, builds, staleRef, readWrote>>

Plan(s) ==
    LET r == s[1]
        q == Src(r)
        last == Len(ev[q])
        ptr == Ptr(q, last)
    IN /\ pc[s] = "idle"
       /\ IF HasRef(r) /\ ~NoAlreadyCheck
             THEN /\ pc' = [pc EXCEPT ![s] = "committed"]
                  /\ UNCHANGED <<ev, plan, readWrote>>
             ELSE /\ st[q] = "terminal"
                  /\ pc' = [pc EXCEPT ![s] = "planned"]
                  /\ plan' = [plan EXCEPT ![s] = [last |-> last, next |-> NextPos(q, last), comp |-> ptr, copy |-> OldHist(q, last), through |-> FloorOf(ptr)]]
                  /\ UNCHANGED <<ev, readWrote>>
       /\ UNCHANGED <<st, nsvc, lease, tok, wtok, win, wcr, dcr, stalls, builds, staleRef>>

CommitRef(s) ==
    LET r == s[1]
        q == Src(r)
        p == plan[s]
        legacy == AllowLegacy /\ r = "B"
        refEv(form) ==
            [k |-> "ref", form |-> form, from |-> q, last |-> p.last, next |-> p.next,
             carried |-> IF form = "legacy" \/ CopyOnInherit THEN p.copy ELSE <<>>,
             comp |-> IF form = "legacy" THEN (IF p.through > 0 THEN [run |-> r, idx |-> 1] ELSE NoPtr) ELSE p.comp,
             through |-> p.through]
        hasEarlier == HasRef(r) /\ ~NoAlreadyCheck
        moved == Len(ev[q]) # p.last /\ ~NoWalkedCheck
        write(form) ==
            /\ pc' = [pc EXCEPT ![s] = "committed"]
            /\ st' = [st EXCEPT ![r] = "active"]
            /\ staleRef' = (staleRef \/ Len(ev[q]) # p.last)
            /\ ev' = [ev EXCEPT ![r] = Append(@, refEv(form))]
    IN /\ pc[s] = "planned"
       /\ \/ /\ ~Fenced(s)
             /\ pc' = [pc EXCEPT ![s] = "lost"]
             /\ UNCHANGED <<ev, st, staleRef>>
          \/ /\ Fenced(s)
             /\ hasEarlier
             /\ pc' = [pc EXCEPT ![s] = "committed"]
             /\ UNCHANGED <<ev, st, staleRef>>
          \/ /\ Fenced(s)
             /\ ~hasEarlier
             /\ moved
             /\ pc' = [pc EXCEPT ![s] = "idle"]
             /\ UNCHANGED <<ev, st, staleRef>>
          \/ /\ Fenced(s)
             /\ ~hasEarlier
             /\ ~moved
             /\ \/ write("reference")
                \/ /\ legacy
                   /\ write("legacy")
       /\ UNCHANGED <<nsvc, lease, tok, wtok, plan, win, wcr, dcr, stalls, builds, readWrote>>

Read(s) ==
    LET r == s[1]
    IN /\ pc[s] = "committed"
       /\ HasRef(r)
       /\ pc' = [pc EXCEPT ![s] = "read"]
       /\ win' = [win EXCEPT ![s] = WindowOf(r)]
       /\ IF ReadAppends
             THEN ev' = [ev EXCEPT ![r] = Append(@, [k |-> "r"])]
             ELSE ev' = ev
       /\ readWrote' = (readWrote \/ ev' # ev)
       /\ UNCHANGED <<st, nsvc, lease, tok, wtok, plan, wcr, dcr, stalls, builds, staleRef>>

Use(s) ==
    LET r == s[1]
    IN /\ pc[s] = "read"
       /\ IF Fenced(s)
             THEN /\ pc' = [pc EXCEPT ![s] = "used"]
                  /\ builds' = [builds EXCEPT ![r] = @ \cup {win[s]}]
                  /\ win' = win
             ELSE /\ pc' = [pc EXCEPT ![s] = "lost"]
                  /\ win' = [win EXCEPT ![s] = NoWin]
                  /\ UNCHANGED builds
       /\ UNCHANGED <<ev, st, nsvc, lease, tok, wtok, plan, wcr, dcr, stalls, staleRef, readWrote>>

Retire(s) ==
    /\ pc[s] = "used"
    /\ ~Fenced(s)
    /\ pc' = [pc EXCEPT ![s] = "lost"]
    /\ win' = [win EXCEPT ![s] = NoWin]
    /\ UNCHANGED <<ev, st, nsvc, lease, tok, wtok, plan, wcr, dcr, stalls, builds, staleRef, readWrote>>

Finish(s) ==
    LET r == s[1]
        floor == FloorOf(Ptr(r, Len(ev[r])))
        top == NextPos(r, Len(ev[r])) - 1
    IN /\ r = "B"
       /\ pc[s] = "used"
       /\ Fenced(s)
       /\ st[r] = "active"
       /\ \/ ev' = [ev EXCEPT ![r] = Append(@, ItemEv)]
          \/ \E t \in (floor + 1)..top : ev' = [ev EXCEPT ![r] = Append(@, CompEv(t))]
       /\ st' = [st EXCEPT ![r] = "terminal"]
       /\ lease' = [lease EXCEPT ![r] = "free"]
       /\ UNCHANGED <<nsvc, tok, pc, wtok, plan, win, wcr, dcr, stalls, builds, staleRef, readWrote>>

WorkerCrash(s) ==
    /\ wcr < MaxWorkerCrashes
    /\ st[s[1]] # "terminal"
    /\ pc[s] \in {"idle", "planned", "committed", "read"}
    /\ wcr' = wcr + 1
    /\ pc' = [pc EXCEPT ![s] = "dead"]
    /\ plan' = [plan EXCEPT ![s] = NoPlan]
    /\ win' = [win EXCEPT ![s] = NoWin]
    /\ UNCHANGED <<ev, st, nsvc, lease, tok, wtok, dcr, stalls, builds, staleRef, readWrote>>

DaemonCrash ==
    /\ dcr < MaxDaemonCrashes
    /\ dcr' = dcr + 1
    /\ pc' = [s \in Slots |-> IF pc[s] \in Live /\ st[s[1]] # "terminal" THEN "dead" ELSE pc[s]]
    /\ plan' = [s \in Slots |-> IF pc[s] \in Live /\ st[s[1]] # "terminal" THEN NoPlan ELSE plan[s]]
    /\ win' = [s \in Slots |-> IF pc[s] \in Live /\ st[s[1]] # "terminal" THEN NoWin ELSE win[s]]
    /\ UNCHANGED <<ev, st, nsvc, lease, tok, wtok, wcr, stalls, builds, staleRef, readWrote>>

ExpireHolderGone(r) ==
    /\ st[r] # "terminal"
    /\ lease[r] = "held"
    /\ ~HolderAlive(r)
    /\ lease' = [lease EXCEPT ![r] = "free"]
    /\ UNCHANGED <<ev, st, nsvc, tok, pc, wtok, plan, win, wcr, dcr, stalls, builds, staleRef, readWrote>>

ExpireStall(r) ==
    /\ st[r] # "terminal"
    /\ lease[r] = "held"
    /\ HolderAlive(r)
    /\ stalls < MaxStalls
    /\ stalls' = stalls + 1
    /\ lease' = [lease EXCEPT ![r] = "free"]
    /\ UNCHANGED <<ev, st, nsvc, tok, pc, wtok, plan, win, wcr, dcr, builds, staleRef, readWrote>>

Stutter == UNCHANGED vars

Next ==
    \/ DaemonCrash
    \/ Stutter
    \/ \E r \in Runs : ServiceAppend(r)
    \/ \E r \in Children : ExpireHolderGone(r) \/ ExpireStall(r)
    \/ \E s \in Slots :
        \/ Claim(s)
        \/ Plan(s)
        \/ CommitRef(s)
        \/ Read(s)
        \/ Use(s)
        \/ Retire(s)
        \/ Finish(s)
        \/ WorkerCrash(s)

Fairness ==
    /\ \A s \in Slots :
        /\ WF_vars(Claim(s))
        /\ WF_vars(Plan(s))
        /\ WF_vars(CommitRef(s))
        /\ WF_vars(Read(s))
        /\ WF_vars(Use(s))
        /\ WF_vars(Retire(s))
        /\ WF_vars(Finish(s))
    /\ \A r \in Children : WF_vars(ExpireHolderGone(r))

Spec == Init /\ [][Next]_vars

LiveSpec == Spec /\ Fairness

AtMostOneReference == \A r \in Runs : RefCount(r) <= 1

NoHistoryInEvent ==
    \A r \in Runs : \A e \in 1..Len(ev[r]) :
        (ev[r][e].k = "ref" /\ ev[r][e].form = "reference") => ev[r][e].carried = <<>>

ReadingStates == {"read", "used"}

ReadEqualsInheritAtWrite ==
    \A s \in Slots :
        pc[s] = "used" => win[s] = OldHist(Src(s[1]), ev[s[1]][1].last)

NoDuplicateItems ==
    \A s \in Slots : pc[s] \in ReadingStates => Cardinality(Ids(win[s])) = Len(win[s])

NoStaleReference == ~staleRef

ReadWritesNothing == ~readWrote

BuildsAgree == \A r \in Children : Cardinality(builds[r]) <= 1

UsedWasRead == \A s \in Slots : pc[s] = "used" => win[s] # NoWin

WindowIsVolatile == \A s \in Slots : pc[s] \in {"none", "dead", "lost"} => win[s] = NoWin

StopsAtOldShape ==
    \A p \in Children :
        (HasRef(p) /\ ev[p][1].form = "legacy") =>
            \A q \in Children : (p \in Resolve(q, Len(ev[q])).runs => Src(p) \notin Resolve(q, Len(ev[q])).runs)

UseEventually == <>(builds["C"] # {})

=============================================================================
