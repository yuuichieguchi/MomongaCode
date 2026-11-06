--------------------------- MODULE FactsSweeper ---------------------------
(***************************************************************************)
(* Model of the facts sweeper of design-reliability-report.md 2.6: the     *)
(* cursor over terminal run.status events, the run_facts rows and the      *)
(* definitions version.                                                    *)
(*                                                                         *)
(* Code sources (the writers and readers of the modelled state)           *)
(*   terminal run.status events: every writer of a terminal status in      *)
(*       packages/store/src/runtime-store.ts (transition via terminals     *)
(*       finish and cancel, appendAsService, finishCancelled,              *)
(*       deadLetterExhausted, expireApprovals, the cancel cascade); they   *)
(*       are one actor here, Terminate. No code deletes a run or an event  *)
(*       (grep DELETE FROM runs, events: none), so rows are never          *)
(*       orphaned                                                          *)
(*   the sweeper: packages/runtime/src/service/search-sweeper.ts is the   *)
(*       pattern (timer, a batch of FACTS_SWEEP_BATCH_RUNS runs, one       *)
(*       cursor row); the new facts-sweeper.ts and the journal thread      *)
(*       request runFacts                                                  *)
(*   readers (the GET /v1/report/facts pages, momonga reliability,         *)
(*       --verify) write nothing and are not modelled                      *)
(*   the definitions version: a constant of the binary; it changes when    *)
(*       the daemon is replaced (Upgrade), which also ends the sweeper      *)
(*       process                                                           *)
(*                                                                         *)
(* Abstractions: the fold itself (RunRecord.tla and the unit tests of      *)
(* fold-facts.ts); the time between ticks; the content of a row. A run     *)
(* whose fold throws (Poison) stands for a journal that foldFacts          *)
(* refuses: fold-facts.ts throws RangeError for a journal with no terminal *)
(* event, and TypeError for a malformed mandate.                           *)
(*                                                                         *)
(* Switches. The configuration FactsSweeper is the design the model holds. *)
(*   ResetOnVersion      the cursor is read as 0 when it was written under *)
(*                       another definitions version                       *)
(*   CursorAfterUpsert   the cursor is written after the upserts of its    *)
(*                       batch (FALSE: before them)                        *)
(*   SkipPoison          a run whose fold throws gets a row that says so,  *)
(*                       and the cursor moves past it (FALSE: the tick     *)
(*                       throws and the next tick retries the same batch)  *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
    Runs,
    Poison,
    BatchSize,
    MaxVersion,
    MaxCrashes,
    ResetOnVersion,
    CursorAfterUpsert,
    SkipPoison

ASSUME /\ Poison \subseteq Runs
       /\ BatchSize \in Nat \ {0}
       /\ MaxVersion \in Nat \ {0}
       /\ MaxCrashes \in Nat
       /\ ResetOnVersion \in BOOLEAN
       /\ CursorAfterUpsert \in BOOLEAN
       /\ SkipPoison \in BOOLEAN

VARIABLES term, nextId, ver, cursorV, cursorPos, rows, pcs, bt, bi, crashes

vars == <<term, nextId, ver, cursorV, cursorPos, rows, pcs, bt, bi, crashes>>

(* term[r]      the id of the terminal run.status event of r, 0 while r is *)
(*              not terminal; ids follow the order of the commits          *)
(* ver          the definitions version of the running binary              *)
(* cursorV, cursorPos  the facts_cursor row: the version it was written   *)
(*              under and the last event id it covers                      *)
(* rows[r]      the definitions version of the run_facts row of r, 0 none  *)
(* pcs, bt, bi  the sweeper: idle or working; the batch (runs in id order)  *)
(*              and how many of them it has handled                       *)

Init ==
    /\ term = [r \in Runs |-> 0]
    /\ nextId = 1
    /\ ver = 1
    /\ cursorV = 1 /\ cursorPos = 0
    /\ rows = [r \in Runs |-> 0]
    /\ pcs = "idle" /\ bt = <<>> /\ bi = 0
    /\ crashes = 0

Terminate(r) ==
    /\ term[r] = 0
    /\ term' = [term EXCEPT ![r] = nextId]
    /\ nextId' = nextId + 1
    /\ UNCHANGED <<ver, cursorV, cursorPos, rows, pcs, bt, bi, crashes>>

(* The daemon is replaced by a binary with other definitions. The sweeper  *)
(* process ends with it.                                                    *)
Upgrade ==
    /\ ver < MaxVersion
    /\ ver' = ver + 1
    /\ pcs' = "idle" /\ bt' = <<>> /\ bi' = 0
    /\ UNCHANGED <<term, nextId, cursorV, cursorPos, rows, crashes>>

Crash ==
    /\ pcs = "work" /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ pcs' = "idle" /\ bt' = <<>> /\ bi' = 0
    /\ UNCHANGED <<term, nextId, ver, cursorV, cursorPos, rows>>

StartPos == IF cursorV = ver \/ ~ResetOnVersion THEN cursorPos ELSE 0

Pending == {r \in Runs : term[r] > StartPos}

RECURSIVE Ordered(_)
Ordered(S) ==
    IF S = {} THEN <<>>
    ELSE LET m == CHOOSE r \in S : \A q \in S : term[r] <= term[q]
         IN <<m>> \o Ordered(S \ {m})

FirstN(seq, n) == SubSeq(seq, 1, IF Len(seq) < n THEN Len(seq) ELSE n)

LastOf(seq) == term[seq[Len(seq)]]

(* A tick reads the cursor and takes the next BatchSize terminal runs.     *)
(* When CursorAfterUpsert is FALSE it writes the cursor first.             *)
Begin ==
    /\ pcs = "idle" /\ Pending # {}
    /\ LET batch == FirstN(Ordered(Pending), BatchSize)
       IN /\ bt' = batch
          /\ IF CursorAfterUpsert
             THEN UNCHANGED <<cursorV, cursorPos>>
             ELSE /\ cursorV' = ver
                  /\ cursorPos' = LastOf(batch)
    /\ pcs' = "work" /\ bi' = 0
    /\ UNCHANGED <<term, nextId, ver, rows, crashes>>

(* runFacts for the next run of the batch, then its upsert *)
Handle ==
    /\ pcs = "work" /\ bi < Len(bt)
    /\ LET r == bt[bi + 1]
       IN \/ /\ r \notin Poison \/ SkipPoison
             /\ rows' = [rows EXCEPT ![r] = ver]
             /\ bi' = bi + 1
             /\ pcs' = pcs
          \/ /\ r \in Poison /\ ~SkipPoison
             /\ UNCHANGED rows
             /\ pcs' = "idle" /\ bi' = 0
    /\ UNCHANGED <<term, nextId, ver, cursorV, cursorPos, bt, crashes>>

Finish ==
    /\ pcs = "work" /\ bi = Len(bt)
    /\ IF CursorAfterUpsert
       THEN /\ cursorV' = ver
            /\ cursorPos' = LastOf(bt)
       ELSE UNCHANGED <<cursorV, cursorPos>>
    /\ pcs' = "idle" /\ bt' = <<>> /\ bi' = 0
    /\ UNCHANGED <<term, nextId, ver, rows, crashes>>

Sweep == Begin \/ Handle \/ Finish

Next == (\E r \in Runs : Terminate(r)) \/ Upgrade \/ Crash \/ Sweep

Covered == \A r \in Runs : term[r] # 0 => rows[r] = ver

Spec == Init /\ [][Next]_vars /\ WF_vars(Sweep)

-----------------------------------------------------------------------------

TypeOK ==
    /\ \A r \in Runs : term[r] \in Nat /\ rows[r] \in 0..MaxVersion
    /\ pcs \in {"idle", "work"}

(* A row exists only for a terminal run: foldFacts is defined for terminal *)
(* runs only.                                                              *)
RowsOnlyForTerminal == \A r \in Runs : rows[r] # 0 => term[r] # 0

(* The cursor, as the running binary reads it, never covers a run that has *)
(* no row of the running version.                                          *)
CursorCovered ==
    \A r \in Runs :
        (term[r] # 0 /\ term[r] <= cursorPos /\ cursorV = ver) => rows[r] = ver

(* Every terminal run gets a row of the current version, and the sweeper   *)
(* reaches that state, under weak fairness of the sweeper.                 *)
Coverage == <>[]Covered

=============================================================================
