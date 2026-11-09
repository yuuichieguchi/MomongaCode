------------------------- MODULE SettingsHealth -------------------------
(***************************************************************************)
(* Model of the settings files of design-recorded-answers-2026-11-07.md,   *)
(* item Q15: one rule for every settings file (user, project, local). A    *)
(* broken file refuses new Runs and names the file. A Run that was already *)
(* admitted continues on the last good copy.                               *)
(*                                                                         *)
(* Code sources (the readers and writers of the modelled state)            *)
(*   the writer: the user editing, replacing or deleting a file. Deleting  *)
(*       the user file reads as the defaults, so it is a write of a valid  *)
(*       version here. A half-written file is a broken file.               *)
(*   the cache: packages/config/src/user-settings.ts:79-135                *)
(*       (createUserSettingsCache: refresh() on every read, keyed by the   *)
(*       change key; lastGood). The project and local files have no cache  *)
(*       today (packages/config/src/load-settings.ts:207 reads them on     *)
(*       every call); the design gives them the same cache, so the model   *)
(*       has one cache rule for both files                                  *)
(*   admission readers (class admit): packages/runtime/src/service/        *)
(*       app.ts:191-195 (sessionSettingsOf, the run-creating calls),       *)
(*       packages/runtime/src/process/settings-port.ts:49 (sessionCreate-  *)
(*       Settings), packages/runtime/src/process/mcp-admin.ts:49           *)
(*   in-run readers (class in-run), all through takeUserSnapshot           *)
(*       (settings-port.ts:39, 50-90) and loadSessionSettings (:45):       *)
(*       tool steps packages/runtime/src/worker/tool-step.ts:219,          *)
(*       hooks hook-step.ts:71,94, the rules governance/rules.ts:42-47,    *)
(*       the claim of a queued Run worker/claim-runner.ts:322,353,507-508, *)
(*       cancel recovery worker/cancel-recovery.ts:91, the tool runtime    *)
(*       process/tool-runtime.ts:120, token-pin.ts:36,53, role-pin.ts:8,   *)
(*       memory-share.ts:43, memory-port.ts:78, reflection.ts:88,98,       *)
(*       verified-run.ts:19. They are two actors here: Claim (a queued Run *)
(*       becomes running) and Step (a running Run reads); the others read  *)
(*       through the same path as Step                                     *)
(*   a background reader with no Run: the memory upkeep pass              *)
(*       packages/runtime/src/process/start-runtime-process.ts:632         *)
(*       (Sweep)                                                           *)
(*   readers that start no new work (class read): the session view and    *)
(*       the session patch, packages/runtime/src/service/app.ts            *)
(*       (sessionViewOf, patchSession, through sessionReadSettings) (View) *)
(*   the kept copy: packages/config/src/kept-settings.ts, the last good    *)
(*       copy of each file by path, written on every valid read into the   *)
(*       runtime state; a crash keeps it, and the start-up and recovery    *)
(*       read it from there (Persist)                                       *)
(*   the process start: start-runtime-process.ts:312-317 (the settings     *)
(*       step throws on a broken file) and supervisor/src/child-manager.ts *)
(*       :546-548, :612 (the spawn is held while the file is broken); the  *)
(*       supervisor watch supervisor/src/start-supervisor.ts:244-258 only  *)
(*       logs. The gateway reads once at its start, gateway/src/process.ts *)
(*       :465. Restart is the one actor for all three; the start-up reads  *)
(*       only the user file, so it starts only when the user file is valid;*)
(*       a project or local file may be broken at a restart                *)
(*   a daemon crash: loses the memory cache; the kept copy and the Runs   *)
(*       stay                                                              *)
(*                                                                         *)
(* Abstractions: the content of a file beyond "broken" or a version number *)
(* (a valid version is 1..MaxVersion, 0 is broken); the timing of the file *)
(* watcher (the change key makes every read see the file at that moment,   *)
(* and Watch is the refresh that happens with no reader); the other causes *)
(* that fail a Run (the model fails a Run only for a settings read); the   *)
(* CLI, which reads the file once at command start (cli/src/run/open-      *)
(* session.ts:18,24) and so is the Restart rule; two gateways or two       *)
(* runtimes racing (the process locks make it one each); the setting       *)
(* values: a deny rule is a version, and H4 is "the read returns the       *)
(* current valid version".                                                 *)
(*                                                                         *)
(* Switches. The configuration SettingsHealth is the design the model      *)
(* holds.                                                                  *)
(*   ReadMode    what an in-run reader does. "lastGood": refresh, then use *)
(*               the last good copy (the design). "throw": refresh, and    *)
(*               throw when the file is broken (the code today).           *)
(*               "stale": never refresh, use the copy taken at start       *)
(*   AdmitMode   what admission looks at. "disk": refresh, then look at    *)
(*               the file (the design). "cache": the cached health with no *)
(*               refresh                                                   *)
(*   StartMode   "refuse": the process starts only when every file is      *)
(*               valid (the design). "ignore": it starts anyway            *)
(*   NameFile    the refusal names the broken file                         *)
(*   Persist     the last good copy survives a crash (the design). FALSE:  *)
(*               it lives only in memory (the code before the kept copy)   *)
(***************************************************************************)
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

(* disk[f]      the file on disk: 0 broken, otherwise a valid version     *)
(* lastGood[f]  the cache: the last valid version it read, 0 none         *)
(* health[f]    what the cache knows of the file at its last refresh      *)
(* up           the runtime process serves                                *)
(* runState[r]  new, queued, running, done, failed; kept by the store, so *)
(*              a crash does not change it                                *)
(* admitLog     one record per admission: the files broken on disk then   *)
(* refusalLog   one record per refusal: the file it names ("none" when it *)
(*              names none) and the files broken on disk then             *)
(* readFailed   some reader threw because of a settings file              *)
(* badReads     what the readers got that they must not: "invalid" (no    *)
(*              valid copy) or "stale" (not the current valid version)    *)
(* startedBroken some start-up served with the user file broken          *)

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

(* the cache after a refresh *)
GoodAfter(f) == IF disk[f] # 0 THEN disk[f] ELSE lastGood[f]
HealthAfter(f) == IF disk[f] # 0 THEN "ok" ELSE "broken"

RefreshAll ==
    /\ lastGood' = [f \in Files |-> GoodAfter(f)]
    /\ health' = [f \in Files |-> HealthAfter(f)]

(* What the cache holds after a reader of the given mode went through it *)
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

(* A reader of the in-run class: read both files, or throw *)
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

(* H1: no Run is admitted while any of its settings files is broken *)
AdmittedOnlyWhenValid == \A a \in admitLog : a.broken = {}

(* H2: a Run admitted while valid never ends in error because a file broke *)
NoRunFails == \A r \in Runs : runState[r] # "failed"

(* No reader of the in-run class throws, a Run or not (the memory pass too) *)
NoReaderThrows == ~readFailed

(* H3 and H4: every value read is a valid version, and while the file is   *)
(* valid it is the version on disk                                         *)
ReadsValid == "invalid" \notin badReads
ReadsCurrent == "stale" \notin badReads

(* Every refusal names a file, and that file is broken *)
RefusalNamesFile == \A x \in refusalLog : x.file \in x.broken

(* H5: no process serves when its start-up read of the user file is broken *)
StartReadValid == ~startedBroken

(* A serving process has a last good copy of every file *)
ProcessHasGood == up => \A f \in Files : lastGood[f] # 0

(* Once the files are valid and stay so, every Run is admitted *)
AllValid == BrokenOnDisk = {}
FixedThenAdmitted ==
    (<>[]AllValid) => (<>[](\A r \in Runs : runState[r] # "new"))

=========================================================================
