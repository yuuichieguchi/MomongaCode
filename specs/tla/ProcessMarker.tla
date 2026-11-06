---------------------------- MODULE ProcessMarker ----------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    CallCount,
    NonReadOnly,
    Descendants,
    LockMode,
    MaxCrashes,
    ProbeMapsHiddenToFree,
    CloseCreatorOnFailure,
    GuardEnabled,
    RemoveInRelease,
    ProofDir

CallOrder == SubSeq(<<"c1", "c2", "c3">>, 1, CallCount)

Calls == {CallOrder[i] : i \in DOMAIN CallOrder}
Position(c) == CHOOSE i \in DOMAIN CallOrder : CallOrder[i] = c
Before(a, b) == Position(a) < Position(b)

MarkerStates == {"free", "held", "unknown"}
Modes == {"locked", "listed"}
Phases == {"idle", "guarded", "created", "running", "exited", "ledgered", "settled", "refused", "lost"}
FileStates == {"absent", "present"}
LeaderStates == {"none", "running", "exited"}
ProcStates == {"none", "running", "exec", "undump", "exited"}
AliveProcStates == {"running", "exec", "undump"}
RemovalSources == {"none", "settle", "sweep", "release"}
ProofFileStates == {"absent", "locked"}
HolderNames == {"creator", "leader"} \cup Descendants
Killable == {"leader"} \cup Descendants

ASSUME /\ NonReadOnly \subseteq Calls
       /\ Cardinality(Calls) = Len(CallOrder)
       /\ LockMode \in Modes
       /\ ProofDir \in {"outside", "markers"}
       /\ CallCount \in 1..3
       /\ MaxCrashes \in Nat
       /\ {ProbeMapsHiddenToFree, CloseCreatorOnFailure, GuardEnabled, RemoveInRelease} \subseteq BOOLEAN
       /\ "none" \notin Calls
       /\ Descendants \cap {"creator", "leader"} = {}

VARIABLES
    up,
    crashes,
    startupDone,
    phase,
    file,
    mode,
    holds,
    leader,
    proc,
    owner,
    detached,
    cache,
    meta,
    ledger,
    removedVia,
    startedWithOrphan,
    proofFile,
    proofSwept,
    attempted

vars == <<up, crashes, startupDone, phase, file, mode, holds, leader, proc, owner, detached, cache, meta,
          ledger, removedVia, startedWithOrphan, proofFile, proofSwept, attempted>>

LiveOf(holdSet) == holdSet \ {"creator"}

NamedOf(holdSet) == (holdSet \cap {"leader"}) \cup {d \in holdSet \cap Descendants : proc[d] = "running"}

HiddenOf(holdSet) == {d \in holdSet \cap Descendants : proc[d] \in {"exec", "undump"}}

ViewOf(c, holdSet) ==
    IF mode[c] = "locked"
    THEN IF holdSet # {} THEN "held" ELSE "free"
    ELSE IF NamedOf(holdSet) # {} \/ (~ProbeMapsHiddenToFree /\ HiddenOf(holdSet) # {})
         THEN "held"
         ELSE "free"

Live(c) == LiveOf(holds[c])
Named(c) == NamedOf(holds[c])
Hidden(c) == HiddenOf(holds[c])
View(c) == ViewOf(c, holds[c])

GuardSet == {c \in Calls : meta[c] \notin {"none", "free"} /\ file[c] = "present"}

EarlierDone(c) ==
    \A e \in NonReadOnly :
        Before(e, c) => (phase[e] \in {"settled", "refused"} \/ (phase[e] = "lost" /\ file[e] = "absent"))

KillsWithin(scope) ==
    {kills \in [Calls -> SUBSET Killable] :
        \A c \in Calls : kills[c] \subseteq (IF c \in scope THEN Named(c) ELSE {})}

HoldsAfter(kills) == [c \in Calls |-> holds[c] \ kills[c]]

LeaderAfter(kills) == [c \in Calls |-> IF "leader" \in kills[c] THEN "exited" ELSE leader[c]]

ProcAfter(kills) ==
    [d \in Descendants |-> IF owner[d] # "none" /\ d \in kills[owner[d]] THEN "exited" ELSE proc[d]]

Init ==
    /\ up = TRUE
    /\ crashes = 0
    /\ startupDone = TRUE
    /\ phase = [c \in Calls |-> "idle"]
    /\ file = [c \in Calls |-> "absent"]
    /\ mode = [c \in Calls |-> "none"]
    /\ holds = [c \in Calls |-> {}]
    /\ leader = [c \in Calls |-> "none"]
    /\ proc = [d \in Descendants |-> "none"]
    /\ owner = [d \in Descendants |-> "none"]
    /\ detached = [d \in Descendants |-> FALSE]
    /\ cache = [c \in Calls |-> "none"]
    /\ meta = [c \in Calls |-> "none"]
    /\ ledger = [c \in Calls |-> "none"]
    /\ removedVia = [c \in Calls |-> "none"]
    /\ startedWithOrphan = FALSE
    /\ proofFile = "absent"
    /\ proofSwept = FALSE
    /\ attempted = [c \in Calls |-> FALSE]

GuardCheck(c) ==
    /\ up
    /\ startupDone
    /\ phase[c] = "idle"
    /\ c \in NonReadOnly
    /\ EarlierDone(c)
    /\ IF GuardEnabled
       THEN \E kills \in KillsWithin(GuardSet) :
                LET after == HoldsAfter(kills)
                    stillHeld == {x \in GuardSet : ViewOf(x, after[x]) # "free"}
                    cleared == GuardSet \ stillHeld
                IN /\ holds' = after
                   /\ leader' = LeaderAfter(kills)
                   /\ proc' = ProcAfter(kills)
                   /\ file' = [x \in Calls |-> IF x \in cleared THEN "absent" ELSE file[x]]
                   /\ removedVia' = [x \in Calls |-> IF x \in cleared THEN "settle" ELSE removedVia[x]]
                   /\ phase' = [phase EXCEPT ![c] = IF stillHeld = {} THEN "guarded" ELSE "refused"]
       ELSE /\ phase' = [phase EXCEPT ![c] = "guarded"]
            /\ UNCHANGED <<holds, leader, proc, file, removedVia>>
    /\ UNCHANGED <<up, crashes, startupDone, mode, owner, detached, cache, meta, ledger, startedWithOrphan,
                   proofFile, proofSwept, attempted>>

CreateMarker(c) ==
    /\ up
    /\ phase[c] = "guarded"
    /\ file' = [file EXCEPT ![c] = "present"]
    /\ mode' = [mode EXCEPT ![c] = LockMode]
    /\ holds' = [holds EXCEPT ![c] = {"creator"}]
    /\ phase' = [phase EXCEPT ![c] = "created"]
    /\ startedWithOrphan' = (startedWithOrphan \/ \E e \in Calls : Before(e, c) /\ Live(e) # {})
    /\ UNCHANGED <<up, crashes, startupDone, leader, proc, owner, detached, cache, meta, ledger, removedVia,
                   proofFile, proofSwept, attempted>>

SpawnOk(c) ==
    /\ phase[c] = "created"
    /\ leader' = [leader EXCEPT ![c] = "running"]
    /\ holds' = [holds EXCEPT ![c] = (@ \ {"creator"}) \cup {"leader"}]
    /\ phase' = [phase EXCEPT ![c] = "running"]
    /\ UNCHANGED <<up, crashes, startupDone, file, mode, proc, owner, detached, cache, meta, ledger, removedVia,
                   startedWithOrphan, proofFile, proofSwept, attempted>>

LaunchEndsBeforeSpawn(c) ==
    /\ phase[c] = "created"
    /\ phase' = [phase EXCEPT ![c] = "exited"]
    /\ holds' = [holds EXCEPT ![c] = IF CloseCreatorOnFailure THEN @ \ {"creator"} ELSE @]
    /\ UNCHANGED <<up, crashes, startupDone, file, mode, leader, proc, owner, detached, cache, meta, ledger,
                   removedVia, startedWithOrphan, proofFile, proofSwept, attempted>>

SpawnFail(c) == LaunchEndsBeforeSpawn(c)

Abort(c) == LaunchEndsBeforeSpawn(c)

ChildExit(c) ==
    /\ leader[c] = "running"
    /\ leader' = [leader EXCEPT ![c] = "exited"]
    /\ holds' = [holds EXCEPT ![c] = @ \ {"leader"}]
    /\ phase' = [phase EXCEPT ![c] = IF @ = "running" THEN "exited" ELSE @]
    /\ UNCHANGED <<up, crashes, startupDone, file, mode, proc, owner, detached, cache, meta, ledger, removedVia,
                   startedWithOrphan, proofFile, proofSwept, attempted>>

DescendantFork(c, d) ==
    /\ Live(c) # {}
    /\ proc[d] = "none"
    /\ proc' = [proc EXCEPT ![d] = "running"]
    /\ owner' = [owner EXCEPT ![d] = c]
    /\ holds' = [holds EXCEPT ![c] = @ \cup {d}]
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, leader, detached, cache, meta, ledger,
                   removedVia, startedWithOrphan, proofFile, proofSwept, attempted>>

DescendantDetach(d) ==
    /\ proc[d] \in AliveProcStates
    /\ detached' = [detached EXCEPT ![d] = TRUE]
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, holds, leader, proc, owner, cache, meta, ledger,
                   removedVia, startedWithOrphan, proofFile, proofSwept, attempted>>

DescendantExec(d) ==
    /\ LockMode = "listed"
    /\ proc[d] = "running"
    /\ d \in holds[owner[d]]
    /\ proc' = [proc EXCEPT ![d] = "exec"]
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, holds, leader, owner, detached, cache, meta,
                   ledger, removedVia, startedWithOrphan, proofFile, proofSwept, attempted>>

DescendantExecDone(d) ==
    /\ proc[d] = "exec"
    /\ proc' = [proc EXCEPT ![d] = "running"]
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, holds, leader, owner, detached, cache, meta,
                   ledger, removedVia, startedWithOrphan, proofFile, proofSwept, attempted>>

DescendantUndumpable(d) ==
    /\ LockMode = "listed"
    /\ proc[d] = "running"
    /\ d \in holds[owner[d]]
    /\ proc' = [proc EXCEPT ![d] = "undump"]
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, holds, leader, owner, detached, cache, meta,
                   ledger, removedVia, startedWithOrphan, proofFile, proofSwept, attempted>>

DescendantCloseFd(d) ==
    /\ proc[d] = "running"
    /\ d \in holds[owner[d]]
    /\ holds' = [holds EXCEPT ![owner[d]] = @ \ {d}]
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, leader, proc, owner, detached, cache, meta,
                   ledger, removedVia, startedWithOrphan, proofFile, proofSwept, attempted>>

DescendantExit(d) ==
    /\ proc[d] \in AliveProcStates
    /\ proc' = [proc EXCEPT ![d] = "exited"]
    /\ holds' = [c \in Calls |-> holds[c] \ {d}]
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, leader, owner, detached, cache, meta, ledger,
                   removedVia, startedWithOrphan, proofFile, proofSwept, attempted>>

SettleState(c) ==
    /\ up
    /\ phase[c] = "exited"
    /\ cache[c] = "none"
    /\ \/ /\ cache' = [cache EXCEPT ![c] = "unknown"]
          /\ UNCHANGED <<holds, leader, proc>>
       \/ /\ View(c) = "free"
          /\ cache' = [cache EXCEPT ![c] = "free"]
          /\ UNCHANGED <<holds, leader, proc>>
       \/ /\ View(c) = "held"
          /\ \E kills \in KillsWithin({c}) :
                /\ cache' = [cache EXCEPT ![c] = ViewOf(c, HoldsAfter(kills)[c])]
                /\ holds' = HoldsAfter(kills)
                /\ leader' = LeaderAfter(kills)
                /\ proc' = ProcAfter(kills)
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, owner, detached, meta, ledger, removedVia,
                   startedWithOrphan, proofFile, proofSwept, attempted>>

LedgerWrite(c) ==
    /\ phase[c] = "exited"
    /\ ledger' = [ledger EXCEPT ![c] = "written"]
    /\ meta' = [meta EXCEPT ![c] = IF cache[c] = "none" THEN "unknown" ELSE cache[c]]
    /\ phase' = [phase EXCEPT ![c] = "ledgered"]
    /\ IF RemoveInRelease
       THEN /\ file' = [file EXCEPT ![c] = "absent"]
            /\ removedVia' = [removedVia EXCEPT ![c] = "release"]
       ELSE UNCHANGED <<file, removedVia>>
    /\ UNCHANGED <<up, crashes, startupDone, mode, holds, leader, proc, owner, detached, cache,
                   startedWithOrphan, proofFile, proofSwept, attempted>>

SettleMarker(c) ==
    /\ up
    /\ phase[c] = "ledgered"
    /\ IF cache[c] = "free" /\ file[c] = "present"
       THEN /\ file' = [file EXCEPT ![c] = "absent"]
            /\ removedVia' = [removedVia EXCEPT ![c] = "settle"]
       ELSE UNCHANGED <<file, removedVia>>
    /\ phase' = [phase EXCEPT ![c] = "settled"]
    /\ UNCHANGED <<up, crashes, startupDone, mode, holds, leader, proc, owner, detached, cache, meta, ledger,
                   startedWithOrphan, proofFile, proofSwept, attempted>>

Crash ==
    /\ up
    /\ crashes < MaxCrashes
    /\ up' = FALSE
    /\ crashes' = crashes + 1
    /\ phase' = [c \in Calls |->
                    IF phase[c] \in {"created", "running", "exited"} THEN "lost"
                    ELSE IF phase[c] = "ledgered" THEN "settled"
                    ELSE IF phase[c] = "guarded" THEN "idle"
                    ELSE phase[c]]
    /\ holds' = [c \in Calls |-> holds[c] \ {"creator"}]
    /\ cache' = [c \in Calls |-> "none"]
    /\ proofFile' = "absent"
    /\ UNCHANGED <<startupDone, file, mode, leader, proc, owner, detached, meta, ledger, removedVia,
                   startedWithOrphan, proofSwept, attempted>>

Restart ==
    /\ ~up
    /\ up' = TRUE
    /\ startupDone' = FALSE
    /\ attempted' = [c \in Calls |-> FALSE]
    /\ UNCHANGED <<crashes, phase, file, mode, holds, leader, proc, owner, detached, cache, meta, ledger,
                   removedVia, startedWithOrphan, proofFile, proofSwept>>

SweepEffect(c, mayBeUnknown) ==
    \/ /\ mayBeUnknown
       /\ UNCHANGED <<file, removedVia, holds, leader, proc>>
    \/ /\ View(c) = "free"
       /\ file' = [file EXCEPT ![c] = "absent"]
       /\ removedVia' = [removedVia EXCEPT ![c] = "sweep"]
       /\ UNCHANGED <<holds, leader, proc>>
    \/ /\ View(c) = "held"
       /\ \E kills \in KillsWithin({c}) :
            /\ holds' = HoldsAfter(kills)
            /\ leader' = LeaderAfter(kills)
            /\ proc' = ProcAfter(kills)
            /\ IF ViewOf(c, HoldsAfter(kills)[c]) = "free"
               THEN /\ file' = [file EXCEPT ![c] = "absent"]
                    /\ removedVia' = [removedVia EXCEPT ![c] = "sweep"]
               ELSE UNCHANGED <<file, removedVia>>

StartupSweep(c) ==
    /\ up
    /\ ~startupDone
    /\ ~attempted[c]
    /\ file[c] = "present"
    /\ SweepEffect(c, TRUE)
    /\ attempted' = [attempted EXCEPT ![c] = TRUE]
    /\ UNCHANGED <<up, crashes, startupDone, phase, mode, owner, detached, cache, meta, ledger,
                   startedWithOrphan, proofFile, proofSwept>>

FinishStartup ==
    /\ up
    /\ ~startupDone
    /\ \A c \in Calls : file[c] = "present" => attempted[c]
    /\ startupDone' = TRUE
    /\ UNCHANGED <<up, crashes, phase, file, mode, holds, leader, proc, owner, detached, cache, meta, ledger,
                   removedVia, startedWithOrphan, proofFile, proofSwept, attempted>>

PeriodicSweepWith(c, mayBeUnknown) ==
    /\ up
    /\ startupDone
    /\ phase[c] \in {"settled", "lost"}
    /\ file[c] = "present"
    /\ SweepEffect(c, mayBeUnknown)
    /\ UNCHANGED <<up, crashes, startupDone, phase, mode, owner, detached, cache, meta, ledger,
                   startedWithOrphan, proofFile, proofSwept, attempted>>

PeriodicSweep(c) == PeriodicSweepWith(c, TRUE)

PeriodicSweepKnown(c) == PeriodicSweepWith(c, FALSE)

ProofCreate ==
    /\ up
    /\ proofFile = "absent"
    /\ proofFile' = "locked"
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, holds, leader, proc, owner, detached, cache, meta,
                   ledger, removedVia, startedWithOrphan, proofSwept, attempted>>

ProofClose ==
    /\ proofFile = "locked"
    /\ proofFile' = "absent"
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, holds, leader, proc, owner, detached, cache, meta,
                   ledger, removedVia, startedWithOrphan, proofSwept, attempted>>

ProofSweep ==
    /\ ProofDir = "markers"
    /\ up
    /\ proofFile = "locked"
    /\ proofSwept' = TRUE
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, holds, leader, proc, owner, detached, cache, meta,
                   ledger, removedVia, startedWithOrphan, proofFile, attempted>>

Next ==
    \/ Crash
    \/ Restart
    \/ FinishStartup
    \/ ProofCreate
    \/ ProofClose
    \/ ProofSweep
    \/ \E c \in Calls :
        \/ GuardCheck(c)
        \/ CreateMarker(c)
        \/ SpawnOk(c)
        \/ SpawnFail(c)
        \/ Abort(c)
        \/ ChildExit(c)
        \/ SettleState(c)
        \/ LedgerWrite(c)
        \/ SettleMarker(c)
        \/ StartupSweep(c)
        \/ PeriodicSweep(c)
    \/ \E c \in Calls, d \in Descendants : DescendantFork(c, d)
    \/ \E d \in Descendants :
        \/ DescendantDetach(d)
        \/ DescendantExec(d)
        \/ DescendantExecDone(d)
        \/ DescendantUndumpable(d)
        \/ DescendantCloseFd(d)
        \/ DescendantExit(d)

Fairness ==
    /\ \A d \in Descendants : WF_vars(DescendantExit(d))
    /\ \A c \in Calls : SF_vars(PeriodicSweepKnown(c))
    /\ \A c \in Calls : WF_vars(StartupSweep(c))
    /\ WF_vars(FinishStartup)
    /\ WF_vars(Restart)

Spec == Init /\ [][Next]_vars

LiveSpec == Spec /\ Fairness

TypeOK ==
    /\ up \in BOOLEAN
    /\ crashes \in 0..MaxCrashes
    /\ startupDone \in BOOLEAN
    /\ phase \in [Calls -> Phases]
    /\ file \in [Calls -> FileStates]
    /\ mode \in [Calls -> Modes \cup {"none"}]
    /\ holds \in [Calls -> SUBSET HolderNames]
    /\ leader \in [Calls -> LeaderStates]
    /\ proc \in [Descendants -> ProcStates]
    /\ owner \in [Descendants -> Calls \cup {"none"}]
    /\ detached \in [Descendants -> BOOLEAN]
    /\ cache \in [Calls -> MarkerStates \cup {"none"}]
    /\ meta \in [Calls -> MarkerStates \cup {"none"}]
    /\ ledger \in [Calls -> {"none", "written"}]
    /\ removedVia \in [Calls -> RemovalSources]
    /\ startedWithOrphan \in BOOLEAN
    /\ proofFile \in ProofFileStates
    /\ proofSwept \in BOOLEAN
    /\ attempted \in [Calls -> BOOLEAN]

NoUntrackedOrphan == \A c \in Calls : (file[c] = "absent" /\ phase[c] # "idle") => Live(c) = {}

NoSelfHold == \A c \in Calls : phase[c] \in {"ledgered", "settled"} => "creator" \notin holds[c]

GuardSound == ~startedWithOrphan

GuardKnowsOrphans ==
    \A c \in Calls : (phase[c] = "settled" /\ file[c] = "present" /\ Live(c) # {}) => c \in GuardSet

ProofNeverSwept == ~proofSwept

OneSource == \A c \in Calls : removedVia[c] \in {"none", "settle", "sweep"}

OneWriter == [][\A c \in Calls : meta[c] # "none" => meta'[c] = meta[c]]_vars

EventuallyCleared ==
    \A c \in Calls :
        (phase[c] = "settled" /\ file[c] = "present") ~> (file[c] = "absent" \/ c \notin GuardSet)

=============================================================================
