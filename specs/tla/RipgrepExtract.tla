------------------------- MODULE RipgrepExtract -------------------------
EXTENDS Naturals

CONSTANTS Processes, Layout, Mode, VerifyOn, BlobBad, MaxEvents, MaxCrashes, MaxUses

ASSUME Processes \in Nat \ {0}
ASSUME Layout \in {"same", "split"}
ASSUME Mode \in {"renameDir", "replaceFile"}
ASSUME VerifyOn \in BOOLEAN
ASSUME BlobBad \in BOOLEAN
ASSUME MaxEvents \in Nat
ASSUME MaxCrashes \in Nat
ASSUME MaxUses \in Nat \ {0}

Procs == 1..Processes
Dirs == 1..2
Final == {"done", "failed", "crashed"}

DirOf(p) == IF Layout = "split" /\ p = Processes THEN 2 ELSE 1

VARIABLES fin, pc, fail, uses, tampered, badSpawn, events, crashes

vars == <<fin, pc, fail, uses, tampered, badSpawn, events, crashes>>

TypeOK ==
    /\ fin \in [Dirs -> {"absent", "good", "bad"}]
    /\ pc \in [Procs -> {"start", "decompress", "rename", "winner", "ready"} \cup Final]
    /\ fail \in [Procs -> {"none", "blob", "winner", "vanished"}]
    /\ uses \in [Procs -> 0..MaxUses]
    /\ tampered \in [Procs -> BOOLEAN]
    /\ badSpawn \in [Procs -> BOOLEAN]
    /\ events \in 0..MaxEvents
    /\ crashes \in 0..MaxCrashes

Init ==
    /\ fin \in [Dirs -> {"absent", "good", "bad"}]
    /\ pc = [p \in Procs |-> "start"]
    /\ fail = [p \in Procs |-> "none"]
    /\ uses = [p \in Procs |-> 0]
    /\ tampered = [p \in Procs |-> FALSE]
    /\ badSpawn = [p \in Procs |-> FALSE]
    /\ events = 0
    /\ crashes = 0

Start(p) ==
    /\ pc[p] = "start"
    /\ LET observed == fin[DirOf(p)]
       IN pc' = [pc EXCEPT ![p] =
              IF observed = "absent" THEN "decompress"
              ELSE IF observed = "good" \/ ~VerifyOn THEN "ready"
              ELSE "decompress"]
    /\ UNCHANGED <<fin, fail, uses, tampered, badSpawn, events, crashes>>

Decompress(p) ==
    /\ pc[p] = "decompress"
    /\ IF BlobBad
       THEN /\ pc' = [pc EXCEPT ![p] = "failed"]
            /\ fail' = [fail EXCEPT ![p] = "blob"]
       ELSE /\ pc' = [pc EXCEPT ![p] = "rename"]
            /\ fail' = fail
    /\ UNCHANGED <<fin, uses, tampered, badSpawn, events, crashes>>

Rename(p) ==
    /\ pc[p] = "rename"
    /\ IF Mode = "replaceFile"
       THEN /\ fin' = [fin EXCEPT ![DirOf(p)] = "good"]
            /\ pc' = [pc EXCEPT ![p] = "ready"]
       ELSE IF fin[DirOf(p)] = "absent"
            THEN /\ fin' = [fin EXCEPT ![DirOf(p)] = "good"]
                 /\ pc' = [pc EXCEPT ![p] = "ready"]
            ELSE /\ fin' = fin
                 /\ pc' = [pc EXCEPT ![p] = "winner"]
    /\ UNCHANGED <<fail, uses, tampered, badSpawn, events, crashes>>

Winner(p) ==
    /\ pc[p] = "winner"
    /\ LET observed == fin[DirOf(p)]
       IN IF observed = "good" \/ (observed = "bad" /\ ~VerifyOn)
          THEN /\ pc' = [pc EXCEPT ![p] = "ready"]
               /\ fail' = fail
          ELSE /\ pc' = [pc EXCEPT ![p] = "failed"]
               /\ fail' = [fail EXCEPT ![p] = IF observed = "bad" THEN "winner" ELSE "vanished"]
    /\ UNCHANGED <<fin, uses, tampered, badSpawn, events, crashes>>

Spawn(p) ==
    /\ pc[p] = "ready"
    /\ uses[p] < MaxUses
    /\ uses' = [uses EXCEPT ![p] = @ + 1]
    /\ badSpawn' = [badSpawn EXCEPT ![p] = @ \/ (fin[DirOf(p)] = "bad" /\ ~tampered[p])]
    /\ UNCHANGED <<fin, pc, fail, tampered, events, crashes>>

Finish(p) ==
    /\ pc[p] = "ready"
    /\ pc' = [pc EXCEPT ![p] = "done"]
    /\ UNCHANGED <<fin, fail, uses, tampered, badSpawn, events, crashes>>

Proc(p) == Start(p) \/ Decompress(p) \/ Rename(p) \/ Winner(p) \/ Spawn(p) \/ Finish(p)

Tamper(d) ==
    /\ events < MaxEvents
    /\ fin[d] # "absent"
    /\ fin' = [fin EXCEPT ![d] = "bad"]
    /\ tampered' = [p \in Procs |-> tampered[p] \/ (pc[p] = "ready" /\ DirOf(p) = d)]
    /\ events' = events + 1
    /\ UNCHANGED <<pc, fail, uses, badSpawn, crashes>>

Remove(d) ==
    /\ events < MaxEvents
    /\ fin[d] # "absent"
    /\ fin' = [fin EXCEPT ![d] = "absent"]
    /\ events' = events + 1
    /\ UNCHANGED <<pc, fail, uses, tampered, badSpawn, crashes>>

Crash(p) ==
    /\ crashes < MaxCrashes
    /\ pc[p] \in {"start", "decompress", "rename", "winner"}
    /\ pc' = [pc EXCEPT ![p] = "crashed"]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<fin, fail, uses, tampered, badSpawn, events>>

Settled == \A p \in Procs : pc[p] \in Final

Next ==
    \/ \E p \in Procs : Proc(p) \/ Crash(p)
    \/ \E d \in Dirs : Tamper(d) \/ Remove(d)
    \/ Settled /\ UNCHANGED vars

Spec == Init /\ [][Next]_vars /\ \A p \in Procs : WF_vars(Proc(p))

NoBadSpawn == \A p \in Procs : ~badSpawn[p]

SpuriousFree == (MaxEvents = 0) => \A p \in Procs : fail[p] \in {"none", "blob"}

FailureNamesCause == \A p \in Procs : (pc[p] = "failed") => fail[p] # "none"

Terminates == <>Settled

=========================================================================
