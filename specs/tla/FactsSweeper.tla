--------------------------- MODULE FactsSweeper ---------------------------
(***************************************************************************)
(* Model of the facts sweeper of design-reliability-report.md 2.6: the     *)
(* cursor over terminal run.status events, the run_facts rows and the      *)
(* definitions version.                                                    *)
(*                                                                         *)
(* Code sources (the writers and readers of the modelled state)           *)
(*   terminal run.status events: every writer of a terminal status in      *)
(*       packages/store/src/runtime-store.ts (transition, appendAsService, finishCancelled, deadLetterExhausted, expireApprovals) *)
(*       (transition called by finish and cancel of                        *)
(*       packages/runtime/src/worker/terminals.ts (finish, cancel), and the *)
(*       cancel cascade); they are one actor here, Terminate. Only the     *)
(*       retention sweep deletes a run                                     *)
(*       (packages/store/src/retention.ts (retentionSweep)); the commit of a *)
(*       batch writes nothing for a run it no longer finds                 *)
(*       (packages/store/src/run-facts.ts (commit)), so rows are never     *)
(*       orphaned                                                          *)
(*   the sweeper: packages/runtime/src/service/facts-sweeper.ts (startFactsSweeper, recomputeFactsOf) *)
(*       (timer, a batch of FACTS_SWEEP_BATCH_RUNS runs, one cursor row,   *)
(*       the journal thread request runFacts), on the pattern of           *)
(*       packages/runtime/src/service/search-sweeper.ts (startSearchSweeper) *)
(*   readers (the GET /v1/report/facts pages, momonga reliability,         *)
(*       --verify) write nothing and are not modelled                      *)
(*   the definitions version: a constant of the binary; it changes when    *)
(*       the daemon is replaced (Upgrade), which also ends the sweeper      *)
(*       process                                                           *)
(*                                                                         *)
(*   the runFacts request:                                                 *)
(*       packages/runtime/src/memory/journal-thread-client.ts (runFacts)   *)
(*       It fails in two ways. The handler throws (the reply               *)
(*       is ok false: the fold refused the journal, Poison below). Or the   *)
(*       thread cannot answer: it died, it was silent past the limit, it   *)
(*       was restarted, the request could not be posted, the client was    *)
(*       closed (JournalThreadError from fail, request). The second kind   *)
(*       says nothing about the run; it is the infrastructure failure of   *)
(*       the Handle step, at most MaxInfra times                            *)
(*                                                                         *)
(* Abstractions: the fold itself (RunRecord.tla and the unit tests of      *)
(* packages/reliability/src/fold-facts.ts (foldFacts)); the time between   *)
(* ticks; the content of a row. A run whose fold throws (Poison) stands for *)
(* a journal that foldFacts refuses: it throws RangeError for a journal    *)
(* with no terminal event, and TypeError for a malformed mandate.          *)
(*                                                                         *)
(* Switches. The configuration FactsSweeper is the design the model holds. *)
(*   ResetOnVersion      the cursor is read as 0 when it was written under *)
(*                       another definitions version                       *)
(*   CursorAfterUpsert   the cursor is written after the upserts of its    *)
(*                       batch (FALSE: before them)                        *)
(*   SkipPoison          a run whose fold throws gets a row that says so,  *)
(*                       and the cursor moves past it (FALSE: the tick     *)
(*                       throws and the next tick retries the same batch)  *)
(*   InfraRule           what the sweeper does when the request fails for  *)
(*                       a reason that is not the run. "retry": the run    *)
(*                       gets no row, the tick ends and the cursor stays,  *)
(*                       so the next tick asks again. "unavailable": the   *)
(*                       run gets the row that says its fold failed (the   *)
(*                       code of I4d). "skip": no row, the cursor passes   *)
(***************************************************************************)
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

(* term[r]      the id of the terminal run.status event of r, 0 while r is *)
(*              not terminal; ids follow the order of the commits          *)
(* ver          the definitions version of the running binary              *)
(* cursorV, cursorPos  the facts_cursor row: the version it was written   *)
(*              under and the last event id it covers                      *)
(* rows[r]      the definitions version of the run_facts row of r, 0 none  *)
(* bad[r]       the row of r is the row that says its fold failed           *)
(* infra        how many requests have failed for a reason that is not the  *)
(*              run                                                         *)
(* pcs, bt, bi  the sweeper: idle or working; the batch (runs in id order)  *)
(*              and how many of them it has handled                       *)

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

(* The daemon is replaced by a binary with other definitions. The sweeper  *)
(* process ends with it.                                                    *)
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
    /\ UNCHANGED <<term, nextId, ver, rows, bad, crashes, infra>>

(* runFacts for the next run of the batch, then its upsert *)
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

(* A row exists only for a terminal run: foldFacts is defined for terminal *)
(* runs only.                                                              *)
RowsOnlyForTerminal == \A r \in Runs : rows[r] # 0 => term[r] # 0

(* A row says the fold failed only for a run whose own fold fails; a      *)
(* failure of the request that is not the run never makes a run           *)
(* unavailable.                                                           *)
UnavailableOnlyOwn == \A r \in Runs : (rows[r] # 0 /\ bad[r]) => r \in Poison

(* The cursor, as the running binary reads it, never covers a run that has *)
(* no row of the running version.                                          *)
CursorCovered ==
    \A r \in Runs :
        (term[r] # 0 /\ term[r] <= cursorPos /\ cursorV = ver) => rows[r] = ver

(* Every terminal run gets a row of the current version, and the sweeper   *)
(* reaches that state, under weak fairness of the sweeper.                 *)
Coverage == <>[]Covered

=============================================================================
