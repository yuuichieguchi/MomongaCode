--------------------------- MODULE FactsSweeper ---------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
    Runs,
    Poison,
    BatchSize,
    MaxVersion,
    MaxCrashes,
    MaxInfra,
    ResetOnVersion,
    CursorAfterUpsert,
    SkipPoison,
    InfraRule

ASSUME /\ Poison \subseteq Runs
       /\ BatchSize \in Nat \ {0}
       /\ MaxVersion \in Nat \ {0}
       /\ MaxCrashes \in Nat
       /\ MaxInfra \in Nat
       /\ InfraRule \in {"retry", "unavailable", "skip"}
       /\ ResetOnVersion \in BOOLEAN
       /\ CursorAfterUpsert \in BOOLEAN
       /\ SkipPoison \in BOOLEAN

VARIABLES term, nextId, ver, cursorV, cursorPos, rows, bad, pcs, bt, bi, crashes, infra

vars == <<term, nextId, ver, cursorV, cursorPos, rows, bad, pcs, bt, bi, crashes, infra>>

Init ==
    /\ term = [r \in Runs |-> 0]
    /\ nextId = 1
    /\ ver = 1
    /\ cursorV = 1 /\ cursorPos = 0
    /\ rows = [r \in Runs |-> 0]
    /\ bad = [r \in Runs |-> FALSE]
    /\ pcs = "idle" /\ bt = <<>> /\ bi = 0
    /\ crashes = 0 /\ infra = 0

Terminate(r) ==
    /\ term[r] = 0
    /\ term' = [term EXCEPT ![r] = nextId]
    /\ nextId' = nextId + 1
    /\ UNCHANGED <<ver, cursorV, cursorPos, rows, bad, pcs, bt, bi, crashes, infra>>

Upgrade ==
    /\ ver < MaxVersion
    /\ ver' = ver + 1
    /\ pcs' = "idle" /\ bt' = <<>> /\ bi' = 0
    /\ UNCHANGED <<term, nextId, cursorV, cursorPos, rows, bad, crashes, infra>>

Crash ==
    /\ pcs = "work" /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ pcs' = "idle" /\ bt' = <<>> /\ bi' = 0
    /\ UNCHANGED <<term, nextId, ver, cursorV, cursorPos, rows, bad, infra>>

StartPos == IF cursorV = ver \/ ~ResetOnVersion THEN cursorPos ELSE 0

Pending == {r \in Runs : term[r] > StartPos}

RECURSIVE Ordered(_)
Ordered(S) ==
    IF S = {} THEN <<>>
    ELSE LET m == CHOOSE r \in S : \A q \in S : term[r] <= term[q]
         IN <<m>> \o Ordered(S \ {m})

FirstN(seq, n) == SubSeq(seq, 1, IF Len(seq) < n THEN Len(seq) ELSE n)

LastOf(seq) == term[seq[Len(seq)]]

Begin ==
    /\ pcs = "idle" /\ Pending # {}
    /\ LET batch == FirstN(Ordered(Pending), BatchSize)
       IN /\ bt' = batch
          /\ IF CursorAfterUpsert
             THEN UNCHANGED <<cursorV, cursorPos>>
             ELSE /\ cursorV' = ver
                  /\ cursorPos' = LastOf(batch)
    /\ pcs' = "work" /\ bi' = 0
    /\ UNCHANGED <<term, nextId, ver, rows, bad, crashes, infra>>

Handle ==
    /\ pcs = "work" /\ bi < Len(bt)
    /\ LET r == bt[bi + 1]
           stored(isBad) == /\ rows' = [rows EXCEPT ![r] = ver]
                            /\ bad' = [bad EXCEPT ![r] = isBad]
                            /\ bi' = bi + 1
                            /\ pcs' = pcs
       IN \/ /\ r \notin Poison
             /\ stored(FALSE)
             /\ UNCHANGED infra
          \/ /\ r \in Poison /\ SkipPoison
             /\ stored(TRUE)
             /\ UNCHANGED infra
          \/ /\ r \in Poison /\ ~SkipPoison
             /\ UNCHANGED <<rows, bad, infra>>
             /\ pcs' = "idle" /\ bi' = 0
          \/ /\ infra < MaxInfra
             /\ infra' = infra + 1
             /\ CASE InfraRule = "retry" ->
                        /\ UNCHANGED <<rows, bad>>
                        /\ pcs' = "idle" /\ bi' = 0
                  [] InfraRule = "unavailable" -> stored(TRUE)
                  [] OTHER ->
                        /\ UNCHANGED <<rows, bad>>
                        /\ bi' = bi + 1
                        /\ pcs' = pcs
    /\ UNCHANGED <<term, nextId, ver, cursorV, cursorPos, bt, crashes>>

Finish ==
    /\ pcs = "work" /\ bi = Len(bt)
    /\ IF CursorAfterUpsert
       THEN /\ cursorV' = ver
            /\ cursorPos' = LastOf(bt)
       ELSE UNCHANGED <<cursorV, cursorPos>>
    /\ pcs' = "idle" /\ bt' = <<>> /\ bi' = 0
    /\ UNCHANGED <<term, nextId, ver, rows, bad, crashes, infra>>

Sweep == Begin \/ Handle \/ Finish

Next == (\E r \in Runs : Terminate(r)) \/ Upgrade \/ Crash \/ Sweep

Covered == \A r \in Runs : term[r] # 0 => (rows[r] = ver /\ (bad[r] <=> r \in Poison))

Spec == Init /\ [][Next]_vars /\ WF_vars(Sweep)

-----------------------------------------------------------------------------

TypeOK ==
    /\ \A r \in Runs : term[r] \in Nat /\ rows[r] \in 0..MaxVersion
    /\ pcs \in {"idle", "work"}
    /\ bad \in [Runs -> BOOLEAN]

RowsOnlyForTerminal == \A r \in Runs : rows[r] # 0 => term[r] # 0

UnavailableOnlyOwn == \A r \in Runs : (rows[r] # 0 /\ bad[r]) => r \in Poison

CursorCovered ==
    \A r \in Runs :
        (term[r] # 0 /\ term[r] <= cursorPos /\ cursorV = ver) => rows[r] = ver

Coverage == <>[]Covered

=============================================================================
