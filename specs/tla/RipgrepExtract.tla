------------------------- MODULE RipgrepExtract -------------------------
EXTENDS Naturals

CONSTANTS Processes, Layout, Mode, SweepMode, VerifyOn, BlobBad, RenameMayFail, MaxEvents, MaxCrashes, MaxUses

ASSUME Processes \in Nat \ {0}
ASSUME Layout \in {"same", "split"}
ASSUME Mode \in {"renameDir", "replaceFile"}
ASSUME SweepMode \in {"dead", "all"}
ASSUME VerifyOn \in BOOLEAN
ASSUME BlobBad \in BOOLEAN
ASSUME RenameMayFail \in BOOLEAN
ASSUME MaxEvents \in Nat
ASSUME MaxCrashes \in Nat
ASSUME MaxUses \in Nat \ {0}

Procs == 1..Processes
Dirs == 1..2
Final == {"done", "failed", "crashed"}
Live == {"start", "hash", "decompress", "rename", "winner", "rehash", "checked", "staged"}

DirOf(p) == IF Layout = "split" /\ p = Processes THEN 2 ELSE 1

VARIABLES fin, pc, fail, uses, tampered, badSpawn, events, crashes, staged, lostStaged

vars == <<fin, pc, fail, uses, tampered, badSpawn, events, crashes, staged, lostStaged>>

TypeOK ==
    /\ fin \in [Dirs -> {"absent", "good", "bad"}]
    /\ pc \in [Procs -> Live \cup Final]
    /\ fail \in [Procs -> {"none", "blob", "winner", "tamper"}]
    /\ uses \in [Procs -> 0..MaxUses]
    /\ tampered \in [Procs -> BOOLEAN]
    /\ badSpawn \in [Procs -> BOOLEAN]
    /\ events \in 0..MaxEvents
    /\ crashes \in 0..MaxCrashes
    /\ staged \in [Procs -> BOOLEAN]
    /\ lostStaged \in BOOLEAN

Init ==
    /\ fin \in [Dirs -> {"absent", "good", "bad"}]
    /\ pc = [p \in Procs |-> "start"]
    /\ fail = [p \in Procs |-> "none"]
    /\ uses = [p \in Procs |-> 0]
    /\ tampered = [p \in Procs |-> FALSE]
    /\ badSpawn = [p \in Procs |-> FALSE]
    /\ events = 0
    /\ crashes = 0
    /\ staged = [p \in Procs |-> FALSE]
    /\ lostStaged = FALSE

SweptBy(p, q) == IF SweepMode = "all" THEN q # p ELSE pc[q] = "crashed"

Start(p) ==
    /\ pc[p] = "start"
    /\ staged' = [q \in Procs |-> IF staged[q] /\ SweptBy(p, q) THEN FALSE ELSE staged[q]]
    /\ lostStaged' = (lostStaged \/ \E q \in Procs : staged[q] /\ SweptBy(p, q) /\ pc[q] \notin Final)
    /\ tampered' = [tampered EXCEPT ![p] = FALSE]
    /\ pc' = [pc EXCEPT ![p] =
           IF fin[DirOf(p)] = "absent" THEN "decompress"
           ELSE IF VerifyOn THEN "hash"
           ELSE "checked"]
    /\ UNCHANGED <<fin, fail, uses, badSpawn, events, crashes>>

Hash(p) ==
    /\ pc[p] = "hash"
    /\ pc' = [pc EXCEPT ![p] = IF fin[DirOf(p)] = "good" THEN "checked" ELSE "decompress"]
    /\ UNCHANGED <<fin, fail, uses, tampered, badSpawn, events, crashes, staged, lostStaged>>

Decompress(p) ==
    /\ pc[p] = "decompress"
    /\ IF BlobBad
       THEN /\ pc' = [pc EXCEPT ![p] = "failed"]
            /\ fail' = [fail EXCEPT ![p] = "blob"]
            /\ staged' = staged
       ELSE /\ pc' = [pc EXCEPT ![p] = "rename"]
            /\ fail' = fail
            /\ staged' = [staged EXCEPT ![p] = (Mode = "replaceFile")]
    /\ UNCHANGED <<fin, uses, tampered, badSpawn, events, crashes, lostStaged>>

RenameReplaceFile(p) ==
    \/ /\ fin' = [fin EXCEPT ![DirOf(p)] = "good"]
       /\ pc' = [pc EXCEPT ![p] = IF VerifyOn THEN "rehash" ELSE "checked"]
       /\ staged' = [staged EXCEPT ![p] = FALSE]
    \/ /\ RenameMayFail
       /\ fin[DirOf(p)] # "absent"
       /\ fin' = fin
       /\ pc' = [pc EXCEPT ![p] = "staged"]
       /\ staged' = staged

RenameDir(p) ==
    /\ IF fin[DirOf(p)] = "absent"
       THEN /\ fin' = [fin EXCEPT ![DirOf(p)] = "good"]
            /\ pc' = [pc EXCEPT ![p] = IF VerifyOn THEN "rehash" ELSE "checked"]
       ELSE /\ fin' = fin
            /\ pc' = [pc EXCEPT ![p] = "winner"]
    /\ staged' = staged

Rename(p) ==
    /\ pc[p] = "rename"
    /\ IF Mode = "replaceFile" THEN RenameReplaceFile(p) ELSE RenameDir(p)
    /\ UNCHANGED <<fail, uses, tampered, badSpawn, events, crashes, lostStaged>>

Rehash(p) ==
    /\ pc[p] = "rehash"
    /\ IF fin[DirOf(p)] = "good"
       THEN /\ pc' = [pc EXCEPT ![p] = "checked"]
            /\ fail' = fail
       ELSE /\ pc' = [pc EXCEPT ![p] = "failed"]
            /\ fail' = [fail EXCEPT ![p] = "tamper"]
    /\ UNCHANGED <<fin, uses, tampered, badSpawn, events, crashes, staged, lostStaged>>

Winner(p) ==
    /\ pc[p] = "winner"
    /\ IF fin[DirOf(p)] = "good" \/ ~VerifyOn
       THEN /\ pc' = [pc EXCEPT ![p] = "checked"]
            /\ fail' = fail
       ELSE /\ pc' = [pc EXCEPT ![p] = "failed"]
            /\ fail' = [fail EXCEPT ![p] = "winner"]
    /\ UNCHANGED <<fin, uses, tampered, badSpawn, events, crashes, staged, lostStaged>>

Next1(p) == IF uses[p] + 1 < MaxUses THEN "start" ELSE "done"

Spawn(p) ==
    /\ pc[p] \in {"checked", "staged"}
    /\ uses' = [uses EXCEPT ![p] = @ + 1]
    /\ badSpawn' = [badSpawn EXCEPT ![p] = @ \/ (pc[p] = "checked" /\ fin[DirOf(p)] = "bad" /\ ~tampered[p])]
    /\ pc' = [pc EXCEPT ![p] = Next1(p)]
    /\ staged' = [staged EXCEPT ![p] = IF Next1(p) = "done" THEN FALSE ELSE @]
    /\ UNCHANGED <<fin, fail, tampered, events, crashes, lostStaged>>

Proc(p) == Start(p) \/ Hash(p) \/ Decompress(p) \/ Rename(p) \/ Rehash(p) \/ Winner(p) \/ Spawn(p)

Tamper(d) ==
    /\ events < MaxEvents
    /\ fin[d] # "absent"
    /\ fin' = [fin EXCEPT ![d] = "bad"]
    /\ tampered' = [p \in Procs |-> tampered[p] \/ (pc[p] = "checked" /\ DirOf(p) = d)]
    /\ events' = events + 1
    /\ UNCHANGED <<pc, fail, uses, badSpawn, crashes, staged, lostStaged>>

Remove(d) ==
    /\ events < MaxEvents
    /\ fin[d] # "absent"
    /\ fin' = [fin EXCEPT ![d] = "absent"]
    /\ events' = events + 1
    /\ UNCHANGED <<pc, fail, uses, tampered, badSpawn, crashes, staged, lostStaged>>

Crash(p) ==
    /\ crashes < MaxCrashes
    /\ pc[p] \in Live
    /\ pc' = [pc EXCEPT ![p] = "crashed"]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<fin, fail, uses, tampered, badSpawn, events, staged, lostStaged>>

Settled == \A p \in Procs : pc[p] \in Final

Next ==
    \/ \E p \in Procs : Proc(p) \/ Crash(p)
    \/ \E d \in Dirs : Tamper(d) \/ Remove(d)
    \/ Settled /\ UNCHANGED vars

Spec == Init /\ [][Next]_vars /\ \A p \in Procs : WF_vars(Proc(p))

NoBadSpawn == \A p \in Procs : ~badSpawn[p]

SpuriousFree == (MaxEvents = 0) => \A p \in Procs : fail[p] \in {"none", "blob"}

FailureNamesCause == \A p \in Procs : (pc[p] = "failed") => fail[p] # "none"

NoLiveStagedLost == ~lostStaged

Terminates == <>Settled

=========================================================================
