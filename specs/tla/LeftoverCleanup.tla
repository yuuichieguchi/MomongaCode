---------------------------- MODULE LeftoverCleanup ----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Writers, Sweepers, Starters, Insts, Foreign, MaxGen, MaxCrash, MaxGenCrash, Variant, LockForm

ASSUME Variant \in {"decided", "ageRemoval", "pidOnly", "noTempLock", "splitCreate", "reapFirst", "listingNumbers", "unlockedStart", "noClaimDirs", "instanceNoClaim"}
ASSUME Foreign \subseteq Writers
ASSUME LockForm \in {"entry", "sidecar"}
ASSUME MaxGen \in Nat \ {0}
ASSUME MaxCrash \in Nat
ASSUME MaxGenCrash \in Nat

Gens == 1..MaxGen

WPhases == {"idle", "created", "locked", "published", "done", "failed", "crashed"}
SPhases == {"idle", "reserved", "mkdir", "running", "done", "crashed"}

VARIABLES wph, tmp, held, aged, sc, crashes, genCounter, uses, dir, supLock, alive, sph, sN, genHolder, reaping, deaths, gCrashes, ilock, iex, iclm

wvars == <<wph, tmp, held, aged, sc>>
ivars == <<ilock, iex, iclm>>
gvars == <<genCounter, uses, dir, supLock, alive, sph, sN, genHolder, reaping, deaths, gCrashes, ivars>>
vars == <<wph, tmp, held, aged, sc, crashes, genCounter, uses, dir, supLock, alive, sph, sN, genHolder, reaping, deaths, gCrashes, ilock, iex, iclm>>

Live(w) == wph[w] \in {"created", "locked", "published"}
Units(w) == tmp[w] \/ sc[w] /= "none"
PidAlive(w) == w \notin Foreign /\ Live(w)

TempRemovable(w) ==
    CASE Variant = "noTempLock" -> Units(w)
      [] Variant = "ageRemoval" -> Units(w) /\ aged[w]
      [] Variant = "pidOnly" -> Units(w) /\ ~PidAlive(w)
      [] OTHER -> Units(w) /\ ~held[w]

NextNumber ==
    IF Variant = "listingNumbers"
    THEN 1 + Cardinality({g \in Gens : dir[g]})
    ELSE genCounter + 1

Init ==
    /\ wph = [w \in Writers |-> "idle"]
    /\ tmp = [w \in Writers |-> FALSE]
    /\ held = [w \in Writers |-> FALSE]
    /\ aged = [w \in Writers |-> FALSE]
    /\ sc = [w \in Writers |-> "none"]
    /\ crashes = 0
    /\ genCounter = 0
    /\ uses = [g \in Gens |-> 0]
    /\ dir = [g \in Gens |-> FALSE]
    /\ supLock = [g \in Gens |-> "none"]
    /\ alive = [g \in Gens |-> FALSE]
    /\ sph = [s \in Starters |-> "idle"]
    /\ sN = [s \in Starters |-> 0]
    /\ genHolder = "none"
    /\ reaping = [g \in Gens |-> FALSE]
    /\ deaths = 0
    /\ gCrashes = 0
    /\ ilock = [g \in Gens |-> [i \in Insts |-> "free"]]
    /\ iex = [g \in Gens |-> [i \in Insts |-> FALSE]]
    /\ iclm = [g \in Gens |-> [i \in Insts |-> FALSE]]

CreateLocked(w) ==
    /\ Variant # "splitCreate"
    /\ wph[w] = "idle"
    /\ wph' = [wph EXCEPT ![w] = "locked"]
    /\ tmp' = [tmp EXCEPT ![w] = TRUE]
    /\ held' = [held EXCEPT ![w] = TRUE]
    /\ sc' = [sc EXCEPT ![w] = IF LockForm = "sidecar" THEN "file" ELSE "none"]
    /\ UNCHANGED <<ivars, aged, crashes, gvars>>

CreateSplit(w) ==
    /\ Variant = "splitCreate"
    /\ wph[w] = "idle"
    /\ wph' = [wph EXCEPT ![w] = "created"]
    /\ tmp' = [tmp EXCEPT ![w] = TRUE]
    /\ UNCHANGED <<ivars, held, sc, aged, crashes, gvars>>

LockSplit(w) ==
    /\ wph[w] = "created"
    /\ wph' = [wph EXCEPT ![w] = "locked"]
    /\ held' = [held EXCEPT ![w] = TRUE]
    /\ sc' = [sc EXCEPT ![w] = IF LockForm = "sidecar" THEN "file" ELSE "none"]
    /\ UNCHANGED <<ivars, tmp, aged, crashes, gvars>>

Publish(w) ==
    /\ wph[w] = "locked"
    /\ IF tmp[w]
       THEN /\ wph' = [wph EXCEPT ![w] = "published"]
            /\ tmp' = [tmp EXCEPT ![w] = FALSE]
            /\ held' = held
       ELSE /\ wph' = [wph EXCEPT ![w] = "failed"]
            /\ tmp' = tmp
            /\ held' = [held EXCEPT ![w] = FALSE]
    /\ UNCHANGED <<ivars, aged, sc, crashes, gvars>>

Dispose(w) ==
    /\ wph[w] = "published"
    /\ wph' = [wph EXCEPT ![w] = "done"]
    /\ sc' = [sc EXCEPT ![w] = "none"]
    /\ held' = [held EXCEPT ![w] = FALSE]
    /\ UNCHANGED <<ivars, tmp, aged, crashes, gvars>>

WriterCrash(w) ==
    /\ crashes < MaxCrash
    /\ wph[w] \in {"created", "locked", "published"}
    /\ wph' = [wph EXCEPT ![w] = "crashed"]
    /\ held' = [held EXCEPT ![w] = FALSE]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<ivars, tmp, aged, sc, gvars>>

TickAge(w) ==
    /\ Variant = "ageRemoval"
    /\ tmp[w]
    /\ ~aged[w]
    /\ aged' = [aged EXCEPT ![w] = TRUE]
    /\ UNCHANGED <<ivars, wph, tmp, held, sc, crashes, gvars>>

SweepEntryForm(w) ==
    /\ LockForm = "entry"
    /\ TempRemovable(w)
    /\ tmp' = [tmp EXCEPT ![w] = FALSE]
    /\ aged' = [aged EXCEPT ![w] = FALSE]
    /\ UNCHANGED <<ivars, wph, held, sc, crashes, gvars>>

SweepClaim(w) ==
    /\ LockForm = "sidecar"
    /\ sc[w] = "file"
    /\ TempRemovable(w)
    /\ sc' = [sc EXCEPT ![w] = "claimed"]
    /\ UNCHANGED <<ivars, wph, tmp, held, aged, crashes, gvars>>

SweepEntryRm(w) ==
    /\ LockForm = "sidecar"
    /\ sc[w] = "claimed"
    /\ tmp[w]
    /\ tmp' = [tmp EXCEPT ![w] = FALSE]
    /\ aged' = [aged EXCEPT ![w] = FALSE]
    /\ UNCHANGED <<ivars, wph, held, sc, crashes, gvars>>

SweepSidecarRm(w) ==
    /\ LockForm = "sidecar"
    /\ sc[w] = "claimed"
    /\ ~tmp[w]
    /\ sc' = [sc EXCEPT ![w] = "none"]
    /\ UNCHANGED <<ivars, wph, tmp, held, aged, crashes, gvars>>

SweepTemp(w) == SweepEntryForm(w) \/ SweepClaim(w) \/ SweepEntryRm(w) \/ SweepSidecarRm(w)

StartReserve(s) ==
    /\ sph[s] = "idle"
    /\ Variant # "unlockedStart"
    /\ genHolder = "none"
    /\ LET n == NextNumber IN
        /\ n \in Gens
        /\ genHolder' = s
        /\ sph' = [sph EXCEPT ![s] = "reserved"]
        /\ sN' = [sN EXCEPT ![s] = n]
        /\ uses' = [uses EXCEPT ![n] = @ + 1]
        /\ genCounter' = IF Variant = "listingNumbers" THEN genCounter ELSE n
        /\ dir' = [dir EXCEPT ![n] = TRUE]
        /\ supLock' = [supLock EXCEPT ![n] = "held"]
        /\ alive' = [alive EXCEPT ![n] = TRUE]
    /\ UNCHANGED <<ivars, wvars, crashes, reaping, deaths, gCrashes>>

StartRelease(s) ==
    /\ Variant # "unlockedStart"
    /\ sph[s] = "reserved"
    /\ genHolder = s
    /\ genHolder' = "none"
    /\ sph' = [sph EXCEPT ![s] = "running"]
    /\ UNCHANGED <<ivars, wvars, crashes, genCounter, uses, dir, supLock, alive, sN, reaping, deaths, gCrashes>>

StartReserveUnlocked(s) ==
    /\ Variant = "unlockedStart"
    /\ sph[s] = "idle"
    /\ LET n == NextNumber IN
        /\ n \in Gens
        /\ sph' = [sph EXCEPT ![s] = "reserved"]
        /\ sN' = [sN EXCEPT ![s] = n]
        /\ uses' = [uses EXCEPT ![n] = @ + 1]
        /\ genCounter' = n
    /\ UNCHANGED <<ivars, wvars, crashes, dir, supLock, alive, genHolder, reaping, deaths, gCrashes>>

StartMkdirUnlocked(s) ==
    /\ Variant = "unlockedStart"
    /\ sph[s] = "reserved"
    /\ dir' = [dir EXCEPT ![sN[s]] = TRUE]
    /\ sph' = [sph EXCEPT ![s] = "mkdir"]
    /\ UNCHANGED <<ivars, wvars, crashes, genCounter, uses, sN, supLock, alive, genHolder, reaping, deaths, gCrashes>>

StartLockUnlocked(s) ==
    /\ Variant = "unlockedStart"
    /\ sph[s] = "mkdir"
    /\ dir[sN[s]]
    /\ supLock' = [supLock EXCEPT ![sN[s]] = "held"]
    /\ alive' = [alive EXCEPT ![sN[s]] = TRUE]
    /\ sph' = [sph EXCEPT ![s] = "running"]
    /\ UNCHANGED <<ivars, wvars, crashes, genCounter, uses, dir, sN, genHolder, reaping, deaths, gCrashes>>

GenExit(s) ==
    /\ sph[s] = "running"
    /\ sph' = [sph EXCEPT ![s] = "done"]
    /\ supLock' = [supLock EXCEPT ![sN[s]] = "free"]
    /\ deaths' = deaths + 1
    /\ UNCHANGED <<ivars, wvars, crashes, genCounter, uses, dir, alive, sN, genHolder, reaping, gCrashes>>

StarterCrash(s) ==
    /\ gCrashes < MaxGenCrash
    /\ sph[s] \in {"reserved", "mkdir", "running"}
    /\ sph' = [sph EXCEPT ![s] = "crashed"]
    /\ supLock' = [supLock EXCEPT ![sN[s]] = IF supLock[sN[s]] = "held" THEN "free" ELSE supLock[sN[s]]]
    /\ genHolder' = IF genHolder = s THEN "none" ELSE genHolder
    /\ deaths' = deaths + 1
    /\ gCrashes' = gCrashes + 1
    /\ UNCHANGED <<ivars, wvars, crashes, genCounter, uses, dir, alive, sN, reaping>>

ChildExit(g) ==
    /\ alive[g]
    /\ alive' = [alive EXCEPT ![g] = FALSE]
    /\ ilock' = [ilock EXCEPT ![g] = [i \in Insts |-> "free"]]
    /\ UNCHANGED <<wvars, crashes, genCounter, uses, dir, supLock, sph, sN, genHolder, reaping, deaths, gCrashes, iex, iclm>>

ClaimDead(g) ==
    /\ dir[g]
    /\ ~reaping[g]
    /\ (Variant = "noClaimDirs" \/ supLock[g] # "held")
    /\ (Variant = "unlockedStart" \/ genHolder = "none")
    /\ reaping' = [reaping EXCEPT ![g] = TRUE]
    /\ UNCHANGED <<ivars, wvars, crashes, genCounter, uses, dir, supLock, alive, sph, sN, genHolder, deaths, gCrashes>>

ReapMarkers(g) ==
    /\ reaping[g]
    /\ alive[g]
    /\ alive' = [alive EXCEPT ![g] = FALSE]
    /\ ilock' = [ilock EXCEPT ![g] = [i \in Insts |-> "free"]]
    /\ UNCHANGED <<wvars, crashes, genCounter, uses, dir, supLock, sph, sN, genHolder, reaping, deaths, gCrashes, iex, iclm>>

MakeInstance(g, i) ==
    /\ dir[g] /\ alive[g]
    /\ ~iex[g][i] /\ ~iclm[g][i]
    /\ iex' = [iex EXCEPT ![g][i] = TRUE]
    /\ ilock' = [ilock EXCEPT ![g][i] = "held"]
    /\ UNCHANGED <<wvars, crashes, genCounter, uses, dir, supLock, alive, sph, sN, genHolder, reaping, deaths, gCrashes, iclm>>

ClaimInstance(g, i) ==
    /\ reaping[g] /\ iex[g][i] /\ ilock[g][i] = "free" /\ ~iclm[g][i]
    /\ iclm' = [iclm EXCEPT ![g][i] = TRUE]
    /\ UNCHANGED <<wvars, crashes, genCounter, uses, dir, supLock, alive, sph, sN, genHolder, reaping, deaths, gCrashes, ilock, iex>>

RemoveInstance(g, i) ==
    /\ reaping[g] /\ iex[g][i]
    /\ (iclm[g][i] \/ Variant = "instanceNoClaim")
    /\ iex' = [iex EXCEPT ![g][i] = FALSE]
    /\ iclm' = [iclm EXCEPT ![g][i] = FALSE]
    /\ UNCHANGED <<wvars, crashes, genCounter, uses, dir, supLock, alive, sph, sN, genHolder, reaping, deaths, gCrashes, ilock>>

RemoveDir(g) ==
    /\ reaping[g]
    /\ dir[g]
    /\ \A i \in Insts : ~iex[g][i]
    /\ (Variant = "reapFirst" \/ ~alive[g])
    /\ dir' = [dir EXCEPT ![g] = FALSE]
    /\ supLock' = [supLock EXCEPT ![g] = IF supLock[g] = "held" THEN "held" ELSE "none"]
    /\ reaping' = [reaping EXCEPT ![g] = FALSE]
    /\ UNCHANGED <<ivars, wvars, crashes, genCounter, uses, alive, sph, sN, genHolder, deaths, gCrashes>>

WriterStep(w) ==
    \/ CreateLocked(w)
    \/ CreateSplit(w)
    \/ LockSplit(w)
    \/ Publish(w)
    \/ Dispose(w)
    \/ WriterCrash(w)
    \/ TickAge(w)

Next ==
    \/ \E w \in Writers : WriterStep(w)
    \/ \E w \in Writers : SweepTemp(w)
    \/ \E s \in Starters : StartReserve(s) \/ StartRelease(s) \/ StartReserveUnlocked(s)
                          \/ StartMkdirUnlocked(s) \/ StartLockUnlocked(s) \/ GenExit(s) \/ StarterCrash(s)
    \/ \E g \in Gens : ChildExit(g) \/ ReapMarkers(g) \/ RemoveDir(g) \/ ClaimDead(g)
    \/ \E g \in Gens, i \in Insts : MakeInstance(g, i) \/ ClaimInstance(g, i) \/ RemoveInstance(g, i)

TempFairness == \A w \in Writers : WF_vars(SweepTemp(w))
DirFairness == \A g \in Gens : WF_vars(ClaimDead(g)) /\ WF_vars(ReapMarkers(g)) /\ WF_vars(RemoveDir(g))
    /\ \A i \in Insts : WF_vars(ClaimInstance(g, i)) /\ WF_vars(RemoveInstance(g, i))
StartFairness == \A s \in Starters : WF_vars(StartRelease(s)) /\ WF_vars(StartLockUnlocked(s))

Spec == Init /\ [][Next]_vars /\ TempFairness /\ DirFairness /\ StartFairness

TypeOK ==
    /\ wph \in [Writers -> WPhases]
    /\ tmp \in [Writers -> BOOLEAN]
    /\ held \in [Writers -> BOOLEAN]
    /\ aged \in [Writers -> BOOLEAN]
    /\ sc \in [Writers -> {"none", "file", "claimed"}]
    /\ dir \in [Gens -> BOOLEAN]
    /\ supLock \in [Gens -> {"none", "free", "held"}]
    /\ alive \in [Gens -> BOOLEAN]
    /\ sph \in [Starters -> SPhases]
    /\ reaping \in [Gens -> BOOLEAN]
    /\ crashes \in 0..MaxCrash
    /\ gCrashes \in 0..MaxGenCrash
    /\ ilock \in [Gens -> [Insts -> {"free", "held"}]]
    /\ iex \in [Gens -> [Insts -> BOOLEAN]]
    /\ iclm \in [Gens -> [Insts -> BOOLEAN]]

NoLiveStepFailed == \A w \in Writers : wph[w] # "failed"

NoRemoveLive ==
    /\ \A g \in Gens : ~dir[g] => (supLock[g] # "held" /\ ~alive[g])
    /\ \A g \in Gens, i \in Insts : ~iex[g][i] => ilock[g][i] # "held"

NoNumberReuse == \A g \in Gens : uses[g] <= 1

LiveStartStepOK == \A s \in Starters : sph[s] = "mkdir" => dir[sN[s]]

LiveDialReachable == \A g \in Gens : supLock[g] = "held" => dir[g]

Leftover(w) == Units(w) /\ ~held[w] /\ wph[w] = "crashed"

Owned(g) == \E s \in Starters : sph[s] \in {"reserved", "mkdir"} /\ sN[s] = g

TempBound == Cardinality({w \in Writers : Leftover(w)}) <= crashes

GenBound == Cardinality({g \in Gens : dir[g] /\ supLock[g] # "held" /\ ~Owned(g)}) <= deaths

TempCleared == \A w \in Writers : (Units(w) /\ ~held[w]) ~> ~Units(w)

DirCleared == \A g \in Gens : (dir[g] /\ supLock[g] # "held") ~> ~dir[g]

=============================================================================
