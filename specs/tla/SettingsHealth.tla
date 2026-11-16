------------------------- MODULE SettingsHealth -------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Runs,
    MaxVersion,
    MaxEdits,
    MaxCrashes,
    MaxSteps,
    ReadMode,
    AdmitMode,
    StartMode,
    NameFile,
    Persist

ASSUME /\ MaxVersion \in Nat \ {0}
       /\ MaxEdits \in Nat
       /\ MaxCrashes \in Nat
       /\ MaxSteps \in Nat \ {0}
       /\ ReadMode \in {"lastGood", "throw", "stale"}
       /\ AdmitMode \in {"disk", "cache"}
       /\ StartMode \in {"refuse", "ignore"}
       /\ NameFile \in BOOLEAN
       /\ Persist \in BOOLEAN

Files == {"user", "project"}
Versions == 0..MaxVersion

VARIABLES disk, lastGood, health, up, runState, steps, edits, crashes,
          admitLog, refusalLog, readFailed, badReads, startedBroken

vars == <<disk, lastGood, health, up, runState, steps, edits, crashes,
          admitLog, refusalLog, readFailed, badReads, startedBroken>>

TypeOK ==
    /\ disk \in [Files -> Versions]
    /\ lastGood \in [Files -> Versions]
    /\ health \in [Files -> {"ok", "broken"}]
    /\ up \in BOOLEAN
    /\ runState \in [Runs -> {"new", "queued", "running", "done", "failed"}]
    /\ steps \in [Runs -> 0..MaxSteps]
    /\ edits \in 0..MaxEdits
    /\ crashes \in 0..MaxCrashes
    /\ readFailed \in BOOLEAN
    /\ badReads \subseteq {"invalid", "stale"}
    /\ startedBroken \in BOOLEAN

Init ==
    /\ disk = [f \in Files |-> 1]
    /\ lastGood = [f \in Files |-> 1]
    /\ health = [f \in Files |-> "ok"]
    /\ up = TRUE
    /\ runState = [r \in Runs |-> "new"]
    /\ steps = [r \in Runs |-> 0]
    /\ edits = 0 /\ crashes = 0
    /\ admitLog = {} /\ refusalLog = {}
    /\ readFailed = FALSE /\ badReads = {}
    /\ startedBroken = FALSE

BrokenOnDisk == {f \in Files : disk[f] = 0}
BrokenInCache == {f \in Files : health[f] = "broken"}

GoodAfter(f) == IF disk[f] # 0 THEN disk[f] ELSE lastGood[f]
HealthAfter(f) == IF disk[f] # 0 THEN "ok" ELSE "broken"

RefreshAll ==
    /\ lastGood' = [f \in Files |-> GoodAfter(f)]
    /\ health' = [f \in Files |-> HealthAfter(f)]

CacheAfterRead ==
    IF ReadMode = "stale"
    THEN [good |-> lastGood, hl |-> health]
    ELSE [good |-> [f \in Files |-> GoodAfter(f)], hl |-> [f \in Files |-> HealthAfter(f)]]

ReadThrows ==
    \/ ReadMode = "throw" /\ BrokenOnDisk # {}
    \/ ReadMode = "lastGood" /\ \E f \in BrokenOnDisk : lastGood[f] = 0

ReadProblems(vals) ==
    (IF \E f \in Files : vals[f] = 0 THEN {"invalid"} ELSE {})
    \cup (IF \E f \in Files : disk[f] # 0 /\ vals[f] # disk[f] THEN {"stale"} ELSE {})

InRunRead(failedState, okState, r) ==
    LET c == CacheAfterRead
    IN /\ lastGood' = c.good
       /\ health' = c.hl
       /\ IF ReadThrows
          THEN /\ readFailed' = TRUE
               /\ IF r # "none" THEN runState' = [runState EXCEPT ![r] = failedState] ELSE UNCHANGED runState
               /\ UNCHANGED badReads
          ELSE /\ badReads' = badReads \cup ReadProblems(c.good)
               /\ IF r # "none" THEN runState' = [runState EXCEPT ![r] = okState] ELSE UNCHANGED runState
               /\ UNCHANGED readFailed

Edit(f) ==
    /\ edits < MaxEdits
    /\ \E v \in Versions \ {disk[f]} : disk' = [disk EXCEPT ![f] = v]
    /\ edits' = edits + 1
    /\ UNCHANGED <<lastGood, health, up, runState, steps, crashes, admitLog, refusalLog, readFailed, badReads, startedBroken>>

Watch ==
    /\ up
    /\ RefreshAll
    /\ UNCHANGED <<disk, up, runState, steps, edits, crashes, admitLog, refusalLog, readFailed, badReads, startedBroken>>

Gate ==
    IF AdmitMode = "disk" THEN BrokenOnDisk ELSE BrokenInCache

Admit(r) ==
    /\ up /\ runState[r] = "new"
    /\ IF AdmitMode = "disk"
       THEN RefreshAll
       ELSE UNCHANGED <<lastGood, health>>
    /\ IF Gate = {}
       THEN /\ runState' = [runState EXCEPT ![r] = "queued"]
            /\ admitLog' = admitLog \cup {[run |-> r, broken |-> BrokenOnDisk]}
            /\ UNCHANGED refusalLog
       ELSE /\ refusalLog' = refusalLog \cup
                 {[file |-> IF NameFile THEN CHOOSE f \in Gate : TRUE ELSE "none", broken |-> BrokenOnDisk]}
            /\ UNCHANGED <<runState, admitLog>>
    /\ UNCHANGED <<disk, up, steps, edits, crashes, readFailed, badReads, startedBroken>>

Claim(r) ==
    /\ up /\ runState[r] = "queued"
    /\ InRunRead("failed", "running", r)
    /\ UNCHANGED <<disk, up, steps, edits, crashes, admitLog, refusalLog, startedBroken>>

Step(r) ==
    /\ up /\ runState[r] = "running" /\ steps[r] < MaxSteps
    /\ steps' = [steps EXCEPT ![r] = steps[r] + 1]
    /\ InRunRead("failed", "running", r)
    /\ UNCHANGED <<disk, up, edits, crashes, admitLog, refusalLog, startedBroken>>

Finish(r) ==
    /\ runState[r] = "running" /\ steps[r] = MaxSteps
    /\ runState' = [runState EXCEPT ![r] = "done"]
    /\ UNCHANGED <<disk, lastGood, health, up, steps, edits, crashes, admitLog, refusalLog, readFailed, badReads, startedBroken>>

Sweep ==
    /\ up
    /\ InRunRead("failed", "running", "none")
    /\ UNCHANGED <<disk, up, steps, edits, crashes, admitLog, refusalLog, startedBroken>>

View ==
    /\ up
    /\ InRunRead("failed", "running", "none")
    /\ UNCHANGED <<disk, up, steps, edits, crashes, admitLog, refusalLog, startedBroken>>

Crash ==
    /\ up /\ crashes < MaxCrashes
    /\ up' = FALSE
    /\ crashes' = crashes + 1
    /\ lastGood' = IF Persist THEN lastGood ELSE [f \in Files |-> 0]
    /\ health' = [f \in Files |-> "ok"]
    /\ UNCHANGED <<disk, runState, steps, edits, admitLog, refusalLog, readFailed, badReads, startedBroken>>

Restart ==
    /\ ~up
    /\ StartMode = "ignore" \/ disk["user"] # 0
    /\ up' = TRUE
    /\ RefreshAll
    /\ startedBroken' = (startedBroken \/ disk["user"] = 0)
    /\ UNCHANGED <<disk, runState, steps, edits, crashes, admitLog, refusalLog, readFailed, badReads>>

Next ==
    \/ \E f \in Files : Edit(f)
    \/ Watch
    \/ \E r \in Runs : Admit(r) \/ Claim(r) \/ Step(r) \/ Finish(r)
    \/ Sweep
    \/ View
    \/ Crash
    \/ Restart

Spec == Init /\ [][Next]_vars
        /\ WF_vars(Restart)
        /\ \A r \in Runs : WF_vars(Admit(r)) /\ WF_vars(Claim(r)) /\ WF_vars(Step(r)) /\ WF_vars(Finish(r))

AdmittedOnlyWhenValid == \A a \in admitLog : a.broken = {}

NoRunFails == \A r \in Runs : runState[r] # "failed"

NoReaderThrows == ~readFailed

ReadsValid == "invalid" \notin badReads
ReadsCurrent == "stale" \notin badReads

RefusalNamesFile == \A x \in refusalLog : x.file \in x.broken

StartReadValid == ~startedBroken

ProcessHasGood == up => \A f \in Files : lastGood[f] # 0

AllValid == BrokenOnDisk = {}
FixedThenAdmitted ==
    (<>[]AllValid) => (<>[](\A r \in Runs : runState[r] # "new"))

=========================================================================
