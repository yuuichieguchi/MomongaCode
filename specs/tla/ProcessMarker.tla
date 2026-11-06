---------------------------- MODULE ProcessMarker ----------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    MarkerCount,
    NonReadOnly,
    Descendants,
    LockModes,
    MaxCrashes,
    ProbeMapsHiddenToFree,
    CloseCreatorOnFailure,
    GuardEnabled,
    GuardFromRows,
    SoundAtCreate,
    OwnersIgnored,
    ReleaseRemoves,
    ProofDir

MarkerOrder == SubSeq(<<"m1", "m2", "m3">>, 1, MarkerCount)

Markers == {MarkerOrder[i] : i \in DOMAIN MarkerOrder}
Position(m) == CHOOSE i \in DOMAIN MarkerOrder : MarkerOrder[i] = m
Before(a, b) == Position(a) < Position(b)

MarkerStates == {"free", "held", "unknown"}
Modes == {"locked", "listed"}
Phases == {"idle", "guarded", "created", "running", "exited", "ledgered", "settled", "refused", "lost"}
Kinds == {"call", "hook", "job"}
Owners == {"none", "call", "hook", "job"}
FileStates == {"absent", "present"}
LeaderStates == {"none", "running", "exited"}
ProcStates == {"none", "running", "exec", "undump", "exited"}
AliveProcStates == {"running", "exec", "undump"}
ProofFileStates == {"absent", "locked"}
HolderNames == {"creator", "leader"} \cup Descendants
Killable == {"leader"} \cup Descendants

ASSUME /\ NonReadOnly \subseteq Markers
       /\ MarkerCount \in 1..3
       /\ LockModes \subseteq Modes
       /\ LockModes # {}
       /\ ProofDir \in {"outside", "markers"}
       /\ MaxCrashes \in Nat
       /\ {ProbeMapsHiddenToFree, CloseCreatorOnFailure, GuardEnabled, GuardFromRows, SoundAtCreate, OwnersIgnored, ReleaseRemoves} \subseteq BOOLEAN
       /\ "none" \notin Markers
       /\ Descendants \cap {"creator", "leader"} = {}

VARIABLES
    up,
    crashes,
    startupDone,
    phase,
    file,
    mode,
    kind,
    owner,
    holds,
    leader,
    proc,
    home,
    detached,
    cache,
    meta,
    ledger,
    startedWithOrphan,
    reapedLiveOwner,
    proofFile,
    runtimeSignalled,
    attempted

vars == <<up, crashes, startupDone, phase, file, mode, kind, owner, holds, leader, proc, home, detached, cache,
          meta, ledger, startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

LiveOf(holdSet) == holdSet \ {"creator"}

NamedOf(holdSet) == (holdSet \cap {"leader"}) \cup {d \in holdSet \cap Descendants : proc[d] = "running"}

HiddenOf(holdSet) == {d \in holdSet \cap Descendants : proc[d] \in {"exec", "undump"}}

ViewOf(m, holdSet) ==
    IF mode[m] = "locked"
    THEN IF holdSet # {} THEN "held" ELSE "free"
    ELSE IF NamedOf(holdSet) # {} \/ (~ProbeMapsHiddenToFree /\ HiddenOf(holdSet) # {})
         THEN "held"
         ELSE "free"

Live(m) == LiveOf(holds[m])
Named(m) == NamedOf(holds[m])
Hidden(m) == HiddenOf(holds[m])
View(m) == ViewOf(m, holds[m])

Orphan(m) == Live(m) # {} /\ owner[m] = "none"

UnsettledKeys ==
    {m \in Markers : file[m] = "present" /\ (OwnersIgnored \/ owner[m] = "none")}

RowKeys == {m \in Markers : file[m] = "present" /\ meta[m] \notin {"none", "free"}}

GuardedKeys == IF GuardFromRows THEN RowKeys ELSE UnsettledKeys

InIndexOrder(m) == \A e \in Markers : Before(e, m) => phase[e] # "idle"

EarlierCallsDone(m) ==
    \A e \in Markers : (Before(e, m) /\ kind[e] = "call") => phase[e] \in {"settled", "refused", "lost"}

KillsWithin(scope) ==
    {kills \in [Markers -> SUBSET Killable] :
        \A m \in Markers : kills[m] \subseteq (IF m \in scope THEN Named(m) ELSE {})}

HoldsAfter(kills) == [m \in Markers |-> holds[m] \ kills[m]]

LeaderAfter(kills) == [m \in Markers |-> IF "leader" \in kills[m] THEN "exited" ELSE leader[m]]

ProcAfter(kills) ==
    [d \in Descendants |-> IF home[d] # "none" /\ d \in kills[home[d]] THEN "exited" ELSE proc[d]]

Init ==
    /\ up = TRUE
    /\ crashes = 0
    /\ startupDone = TRUE
    /\ phase = [m \in Markers |-> "idle"]
    /\ file = [m \in Markers |-> "absent"]
    /\ mode = [m \in Markers |-> "none"]
    /\ kind = [m \in Markers |-> "none"]
    /\ owner = [m \in Markers |-> "none"]
    /\ holds = [m \in Markers |-> {}]
    /\ leader = [m \in Markers |-> "none"]
    /\ proc = [d \in Descendants |-> "none"]
    /\ home = [d \in Descendants |-> "none"]
    /\ detached = [d \in Descendants |-> FALSE]
    /\ cache = [m \in Markers |-> "none"]
    /\ meta = [m \in Markers |-> "none"]
    /\ ledger = [m \in Markers |-> "none"]
    /\ startedWithOrphan = FALSE
    /\ reapedLiveOwner = FALSE
    /\ proofFile = "absent"
    /\ runtimeSignalled = FALSE
    /\ attempted = [m \in Markers |-> FALSE]

GuardCheck(m) ==
    /\ up
    /\ startupDone
    /\ phase[m] = "idle"
    /\ m \in NonReadOnly
    /\ InIndexOrder(m)
    /\ EarlierCallsDone(m)
    /\ kind' = [kind EXCEPT ![m] = "call"]
    /\ IF GuardEnabled
       THEN \E unreadable \in SUBSET GuardedKeys :
              \E kills \in KillsWithin(GuardedKeys \ unreadable) :
                LET after == HoldsAfter(kills)
                    read == GuardedKeys \ unreadable
                    stillHeld == {x \in read : ViewOf(x, after[x]) # "free"}
                    cleared == read \ stillHeld
                IN /\ holds' = after
                   /\ leader' = LeaderAfter(kills)
                   /\ proc' = ProcAfter(kills)
                   /\ file' = [x \in Markers |-> IF x \in cleared THEN "absent" ELSE file[x]]
                   /\ reapedLiveOwner' = (reapedLiveOwner \/ \E x \in Markers : kills[x] # {} /\ owner[x] # "none")
                   /\ phase' = [phase EXCEPT ![m] = IF unreadable \cup stillHeld = {} THEN "guarded" ELSE "refused"]
                   /\ startedWithOrphan' = (startedWithOrphan \/
                         (unreadable \cup stillHeld = {} /\ \E x \in Markers : LiveOf(after[x]) # {} /\ owner[x] = "none"))
       ELSE /\ phase' = [phase EXCEPT ![m] = "guarded"]
            /\ startedWithOrphan' = (startedWithOrphan \/ \E x \in Markers : Orphan(x))
            /\ UNCHANGED <<holds, leader, proc, file, reapedLiveOwner>>
    /\ UNCHANGED <<up, crashes, startupDone, mode, owner, home, detached, cache, meta, ledger,
                   proofFile, runtimeSignalled, attempted>>

CreateMarker(m) ==
    /\ up
    /\ phase[m] = "guarded"
    /\ \E chosen \in LockModes : mode' = [mode EXCEPT ![m] = chosen]
    /\ file' = [file EXCEPT ![m] = "present"]
    /\ owner' = [owner EXCEPT ![m] = "call"]
    /\ holds' = [holds EXCEPT ![m] = {"creator"}]
    /\ phase' = [phase EXCEPT ![m] = "created"]
    /\ startedWithOrphan' = (startedWithOrphan \/ (SoundAtCreate /\ \E x \in Markers \ {m} : Orphan(x)))
    /\ UNCHANGED <<up, crashes, startupDone, kind, leader, proc, home, detached, cache, meta, ledger,
                   reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

StartOwned(m, ownerKind) ==
    /\ up
    /\ startupDone
    /\ phase[m] = "idle"
    /\ InIndexOrder(m)
    /\ \E chosen \in LockModes : mode' = [mode EXCEPT ![m] = chosen]
    /\ file' = [file EXCEPT ![m] = "present"]
    /\ kind' = [kind EXCEPT ![m] = ownerKind]
    /\ owner' = [owner EXCEPT ![m] = ownerKind]
    /\ holds' = [holds EXCEPT ![m] = {"creator"}]
    /\ phase' = [phase EXCEPT ![m] = "created"]
    /\ UNCHANGED <<up, crashes, startupDone, leader, proc, home, detached, cache, meta, ledger,
                   startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

StartJob(m) == StartOwned(m, "job")

StartHook(m) == StartOwned(m, "hook")

SpawnOk(m) ==
    /\ phase[m] = "created"
    /\ leader' = [leader EXCEPT ![m] = "running"]
    /\ holds' = [holds EXCEPT ![m] = (@ \ {"creator"}) \cup {"leader"}]
    /\ phase' = [phase EXCEPT ![m] = "running"]
    /\ UNCHANGED <<up, crashes, startupDone, file, mode, kind, owner, proc, home, detached, cache, meta, ledger,
                   startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

LaunchEndsBeforeSpawn(m) ==
    /\ phase[m] = "created"
    /\ phase' = [phase EXCEPT ![m] = "exited"]
    /\ holds' = [holds EXCEPT ![m] = IF CloseCreatorOnFailure THEN @ \ {"creator"} ELSE @]
    /\ UNCHANGED <<up, crashes, startupDone, file, mode, kind, owner, leader, proc, home, detached, cache, meta,
                   ledger, startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

SpawnFail(m) == LaunchEndsBeforeSpawn(m)

Abort(m) == LaunchEndsBeforeSpawn(m)

ChildExit(m) ==
    /\ leader[m] = "running"
    /\ leader' = [leader EXCEPT ![m] = "exited"]
    /\ holds' = [holds EXCEPT ![m] = @ \ {"leader"}]
    /\ phase' = [phase EXCEPT ![m] = IF @ = "running" THEN "exited" ELSE @]
    /\ UNCHANGED <<up, crashes, startupDone, file, mode, kind, owner, proc, home, detached, cache, meta, ledger,
                   startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

DescendantFork(m, d) ==
    /\ Live(m) # {}
    /\ proc[d] = "none"
    /\ proc' = [proc EXCEPT ![d] = "running"]
    /\ home' = [home EXCEPT ![d] = m]
    /\ holds' = [holds EXCEPT ![m] = @ \cup {d}]
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, kind, owner, leader, detached, cache, meta, ledger,
                   startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

DescendantDetach(d) ==
    /\ proc[d] \in AliveProcStates
    /\ detached' = [detached EXCEPT ![d] = TRUE]
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, kind, owner, holds, leader, proc, home, cache, meta,
                   ledger, startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

DescendantExec(d) ==
    /\ proc[d] = "running"
    /\ mode[home[d]] = "listed"
    /\ d \in holds[home[d]]
    /\ proc' = [proc EXCEPT ![d] = "exec"]
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, kind, owner, holds, leader, home, detached, cache,
                   meta, ledger, startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

DescendantExecDone(d) ==
    /\ proc[d] = "exec"
    /\ proc' = [proc EXCEPT ![d] = "running"]
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, kind, owner, holds, leader, home, detached, cache,
                   meta, ledger, startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

DescendantUndumpable(d) ==
    /\ proc[d] = "running"
    /\ mode[home[d]] = "listed"
    /\ d \in holds[home[d]]
    /\ proc' = [proc EXCEPT ![d] = "undump"]
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, kind, owner, holds, leader, home, detached, cache,
                   meta, ledger, startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

DescendantCloseFd(d) ==
    /\ proc[d] = "running"
    /\ d \in holds[home[d]]
    /\ holds' = [holds EXCEPT ![home[d]] = @ \ {d}]
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, kind, owner, leader, proc, home, detached, cache,
                   meta, ledger, startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

DescendantExit(d) ==
    /\ proc[d] \in AliveProcStates
    /\ proc' = [proc EXCEPT ![d] = "exited"]
    /\ holds' = [m \in Markers |-> holds[m] \ {d}]
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, kind, owner, leader, home, detached, cache, meta,
                   ledger, startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

SettleState(m) ==
    /\ up
    /\ kind[m] = "call"
    /\ owner[m] = "call"
    /\ phase[m] = "exited"
    /\ cache[m] = "none"
    /\ \/ /\ cache' = [cache EXCEPT ![m] = "unknown"]
          /\ UNCHANGED <<holds, leader, proc>>
       \/ /\ View(m) = "free"
          /\ cache' = [cache EXCEPT ![m] = "free"]
          /\ UNCHANGED <<holds, leader, proc>>
       \/ /\ View(m) = "held"
          /\ \E kills \in KillsWithin({m}) :
                /\ cache' = [cache EXCEPT ![m] = ViewOf(m, HoldsAfter(kills)[m])]
                /\ holds' = HoldsAfter(kills)
                /\ leader' = LeaderAfter(kills)
                /\ proc' = ProcAfter(kills)
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, kind, owner, home, detached, meta, ledger,
                   startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

LedgerWrite(m) ==
    /\ kind[m] = "call"
    /\ owner[m] = "call"
    /\ phase[m] = "exited"
    /\ ledger' = [ledger EXCEPT ![m] = "written"]
    /\ meta' = [meta EXCEPT ![m] = IF cache[m] = "none" THEN "unknown" ELSE cache[m]]
    /\ phase' = [phase EXCEPT ![m] = "ledgered"]
    /\ file' = [file EXCEPT ![m] = IF ReleaseRemoves THEN "absent" ELSE @]
    /\ UNCHANGED <<up, crashes, startupDone, mode, kind, owner, holds, leader, proc, home, detached, cache,
                   startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

SettleMarker(m) ==
    /\ up
    /\ kind[m] = "call"
    /\ owner[m] = "call"
    /\ phase[m] = "ledgered"
    /\ file' = [file EXCEPT ![m] = IF cache[m] = "free" THEN "absent" ELSE @]
    /\ owner' = [owner EXCEPT ![m] = "none"]
    /\ phase' = [phase EXCEPT ![m] = "settled"]
    /\ UNCHANGED <<up, crashes, startupDone, mode, kind, holds, leader, proc, home, detached, cache, meta, ledger,
                   startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

Promote(m) ==
    /\ up
    /\ kind[m] = "call"
    /\ owner[m] = "call"
    /\ phase[m] = "running"
    /\ owner' = [owner EXCEPT ![m] = "job"]
    /\ ledger' = [ledger EXCEPT ![m] = "written"]
    /\ meta' = [meta EXCEPT ![m] = "unknown"]
    /\ phase' = [phase EXCEPT ![m] = "settled"]
    /\ UNCHANGED <<up, crashes, startupDone, file, mode, kind, holds, leader, proc, home, detached, cache,
                   startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

OwnerEnd(m) ==
    /\ up
    /\ owner[m] \in {"job", "hook"}
    /\ leader[m] # "running"
    /\ phase[m] \in {"exited", "settled"}
    /\ \/ /\ UNCHANGED <<file, holds, leader, proc>>
       \/ /\ View(m) = "free"
          /\ file' = [file EXCEPT ![m] = "absent"]
          /\ UNCHANGED <<holds, leader, proc>>
       \/ /\ View(m) = "held"
          /\ \E kills \in KillsWithin({m}) :
                /\ holds' = HoldsAfter(kills)
                /\ leader' = LeaderAfter(kills)
                /\ proc' = ProcAfter(kills)
                /\ IF ViewOf(m, HoldsAfter(kills)[m]) = "free"
                   THEN file' = [file EXCEPT ![m] = "absent"]
                   ELSE UNCHANGED file
    /\ owner' = [owner EXCEPT ![m] = "none"]
    /\ phase' = [phase EXCEPT ![m] = "settled"]
    /\ UNCHANGED <<up, crashes, startupDone, mode, kind, home, detached, cache, meta, ledger, startedWithOrphan,
                   reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

Crash ==
    /\ up
    /\ crashes < MaxCrashes
    /\ up' = FALSE
    /\ crashes' = crashes + 1
    /\ phase' = [m \in Markers |->
                    IF phase[m] \in {"created", "running", "exited"} THEN "lost"
                    ELSE IF phase[m] = "ledgered" THEN "settled"
                    ELSE IF phase[m] = "guarded" THEN "idle"
                    ELSE phase[m]]
    /\ owner' = [m \in Markers |-> "none"]
    /\ holds' = [m \in Markers |-> holds[m] \ {"creator"}]
    /\ cache' = [m \in Markers |-> "none"]
    /\ proofFile' = "absent"
    /\ UNCHANGED <<startupDone, file, mode, kind, leader, proc, home, detached, meta, ledger, startedWithOrphan,
                   reapedLiveOwner, runtimeSignalled, attempted>>

Restart ==
    /\ ~up
    /\ up' = TRUE
    /\ startupDone' = FALSE
    /\ attempted' = [m \in Markers |-> FALSE]
    /\ UNCHANGED <<crashes, phase, file, mode, kind, owner, holds, leader, proc, home, detached, cache, meta, ledger,
                   startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled>>

SweepEffect(m, mayBeUnknown) ==
    \/ /\ mayBeUnknown
       /\ UNCHANGED <<file, holds, leader, proc, reapedLiveOwner>>
    \/ /\ View(m) = "free"
       /\ file' = [file EXCEPT ![m] = "absent"]
       /\ UNCHANGED <<holds, leader, proc, reapedLiveOwner>>
    \/ /\ View(m) = "held"
       /\ \E kills \in KillsWithin({m}) :
            /\ holds' = HoldsAfter(kills)
            /\ leader' = LeaderAfter(kills)
            /\ proc' = ProcAfter(kills)
            /\ reapedLiveOwner' = (reapedLiveOwner \/ (kills[m] # {} /\ owner[m] # "none"))
            /\ IF ViewOf(m, HoldsAfter(kills)[m]) = "free"
               THEN file' = [file EXCEPT ![m] = "absent"]
               ELSE UNCHANGED file

StartupSweep(m) ==
    /\ up
    /\ ~startupDone
    /\ ~attempted[m]
    /\ m \in UnsettledKeys
    /\ SweepEffect(m, TRUE)
    /\ attempted' = [attempted EXCEPT ![m] = TRUE]
    /\ UNCHANGED <<up, crashes, startupDone, phase, mode, kind, owner, home, detached, cache, meta, ledger,
                   startedWithOrphan, proofFile, runtimeSignalled>>

FinishStartup ==
    /\ up
    /\ ~startupDone
    /\ \A m \in UnsettledKeys : attempted[m]
    /\ startupDone' = TRUE
    /\ UNCHANGED <<up, crashes, phase, file, mode, kind, owner, holds, leader, proc, home, detached, cache, meta,
                   ledger, startedWithOrphan, reapedLiveOwner, proofFile, runtimeSignalled, attempted>>

PeriodicSweepWith(m, mayBeUnknown) ==
    /\ up
    /\ startupDone
    /\ m \in UnsettledKeys
    /\ SweepEffect(m, mayBeUnknown)
    /\ UNCHANGED <<up, crashes, startupDone, phase, mode, kind, owner, home, detached, cache, meta, ledger,
                   startedWithOrphan, proofFile, runtimeSignalled, attempted>>

PeriodicSweep(m) == PeriodicSweepWith(m, TRUE)

PeriodicSweepKnown(m) == PeriodicSweepWith(m, FALSE)

ProofCreate ==
    /\ up
    /\ proofFile = "absent"
    /\ proofFile' = "locked"
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, kind, owner, holds, leader, proc, home, detached,
                   cache, meta, ledger, startedWithOrphan, reapedLiveOwner, runtimeSignalled, attempted>>

ProofClose ==
    /\ proofFile = "locked"
    /\ proofFile' = "absent"
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, kind, owner, holds, leader, proc, home, detached,
                   cache, meta, ledger, startedWithOrphan, reapedLiveOwner, runtimeSignalled, attempted>>

ProofSweep ==
    /\ ProofDir = "markers"
    /\ up
    /\ proofFile = "locked"
    /\ runtimeSignalled' = TRUE
    /\ UNCHANGED <<up, crashes, startupDone, phase, file, mode, kind, owner, holds, leader, proc, home, detached,
                   cache, meta, ledger, startedWithOrphan, reapedLiveOwner, proofFile, attempted>>

Next ==
    \/ Crash
    \/ Restart
    \/ FinishStartup
    \/ ProofCreate
    \/ ProofClose
    \/ ProofSweep
    \/ \E m \in Markers :
        \/ GuardCheck(m)
        \/ CreateMarker(m)
        \/ StartJob(m)
        \/ StartHook(m)
        \/ SpawnOk(m)
        \/ SpawnFail(m)
        \/ Abort(m)
        \/ ChildExit(m)
        \/ SettleState(m)
        \/ LedgerWrite(m)
        \/ SettleMarker(m)
        \/ Promote(m)
        \/ OwnerEnd(m)
        \/ StartupSweep(m)
        \/ PeriodicSweep(m)
    \/ \E m \in Markers, d \in Descendants : DescendantFork(m, d)
    \/ \E d \in Descendants :
        \/ DescendantDetach(d)
        \/ DescendantExec(d)
        \/ DescendantExecDone(d)
        \/ DescendantUndumpable(d)
        \/ DescendantCloseFd(d)
        \/ DescendantExit(d)

Fairness ==
    /\ \A d \in Descendants : WF_vars(DescendantExit(d))
    /\ \A m \in Markers : SF_vars(PeriodicSweepKnown(m))
    /\ \A m \in Markers : WF_vars(StartupSweep(m))
    /\ WF_vars(FinishStartup)
    /\ WF_vars(Restart)

Spec == Init /\ [][Next]_vars

LiveSpec == Spec /\ Fairness

TypeOK ==
    /\ up \in BOOLEAN
    /\ crashes \in 0..MaxCrashes
    /\ startupDone \in BOOLEAN
    /\ phase \in [Markers -> Phases]
    /\ file \in [Markers -> FileStates]
    /\ mode \in [Markers -> Modes \cup {"none"}]
    /\ kind \in [Markers -> Kinds \cup {"none"}]
    /\ owner \in [Markers -> Owners]
    /\ holds \in [Markers -> SUBSET HolderNames]
    /\ leader \in [Markers -> LeaderStates]
    /\ proc \in [Descendants -> ProcStates]
    /\ home \in [Descendants -> Markers \cup {"none"}]
    /\ detached \in [Descendants -> BOOLEAN]
    /\ cache \in [Markers -> MarkerStates \cup {"none"}]
    /\ meta \in [Markers -> MarkerStates \cup {"none"}]
    /\ ledger \in [Markers -> {"none", "written"}]
    /\ startedWithOrphan \in BOOLEAN
    /\ reapedLiveOwner \in BOOLEAN
    /\ proofFile \in ProofFileStates
    /\ runtimeSignalled \in BOOLEAN
    /\ attempted \in [Markers -> BOOLEAN]

NoUntrackedOrphan == \A m \in Markers : (file[m] = "absent" /\ phase[m] # "idle") => Live(m) = {}

NoSelfHold == \A m \in Markers : phase[m] \in {"ledgered", "settled"} => "creator" \notin holds[m]

GuardSound == ~startedWithOrphan

GuardKnowsOrphans == \A m \in Markers : (file[m] = "present" /\ Orphan(m)) => m \in UnsettledKeys

LiveOwnerNeverReaped == ~reapedLiveOwner

ProofNeverSwept == runtimeSignalled = FALSE

OneWriter == [][\A m \in Markers : meta[m] # "none" => meta'[m] = meta[m]]_vars

EventuallyCleared ==
    \A m \in Markers :
        (phase[m] \in {"settled", "lost"} /\ file[m] = "present") ~> (file[m] = "absent" \/ m \notin UnsettledKeys)

=============================================================================
