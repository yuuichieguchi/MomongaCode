--------------------------- MODULE MemoryAutoReview ---------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    N,
    UIs,
    Acp,
    MaxCrashes,
    NoRecheck,
    RetryLeft,
    MarkAtCommit,
    MarkBeforePrint,
    IgnoreSwitch,
    ReadFirst,
    ShowDecided

ASSUME /\ N \in Nat \ {0}
       /\ UIs # {}
       /\ Acp \subseteq UIs
       /\ MaxCrashes \in Nat
       /\ NoRecheck \in BOOLEAN
       /\ RetryLeft \in BOOLEAN
       /\ MarkAtCommit \in BOOLEAN
       /\ MarkBeforePrint \in BOOLEAN
       /\ IgnoreSwitch \in BOOLEAN
       /\ ReadFirst \in BOOLEAN
       /\ ShowDecided \in BOOLEAN

Cand == 1..N

Tuis == UIs \ Acp

VARIABLES st, keptBy, rec, shown, jc, jout, run, trusted, on, crashes,
          phase, inbox, stat, seen, lines, everPrinted

vars == <<st, keptBy, rec, shown, jc, jout, run, trusted, on, crashes,
          phase, inbox, stat, seen, lines, everPrinted>>

storeVars == <<st, keptBy, rec, shown>>
judgeVars == <<jc, jout, crashes>>
envVars == <<run, trusted, on>>
uiVars == <<phase, inbox, stat, seen, lines>>

NoLines == [c \in Cand |-> 0]
NoStat == [c \in Cand |-> "none"]
NoSeen == [c \in Cand |-> FALSE]

Init ==
    /\ st = [c \in Cand |-> "absent"]
    /\ keptBy = [c \in Cand |-> "none"]
    /\ rec = [c \in Cand |-> "none"]
    /\ shown = [c \in Cand |-> FALSE]
    /\ jc = 0 /\ jout = "none" /\ crashes = 0
    /\ run = FALSE /\ trusted = TRUE /\ on = FALSE
    /\ phase = [u \in UIs |-> "closed"]
    /\ inbox = [u \in UIs |-> {}]
    /\ stat = [u \in UIs |-> NoStat]
    /\ seen = [u \in UIs |-> NoSeen]
    /\ lines = [u \in UIs |-> NoLines]
    /\ everPrinted = [c \in Cand |-> FALSE]

Waiting(c) == st[c] = "candidate"

Unjudged(c) == Waiting(c) /\ rec[c] = "none"

Eligible(c) == Waiting(c) /\ (rec[c] = "none" \/ (RetryLeft /\ rec[c] = "left"))

PersonDecided(c) == keptBy[c] = "person" \/ st[c] \in {"rejected", "retired"}

Connected(u) == phase[u] = "run" \/ (phase[u] = "pre" /\ ~ReadFirst)

Receivers == {u \in UIs : Connected(u)}

GuardHolds == on /\ trusted /\ ~run

StartAllowed == (on \/ IgnoreSwitch) /\ trusted /\ ~run

Reflect(c) ==
    /\ st[c] = "absent"
    /\ \A d \in 1..(c - 1) : st[d] # "absent"
    /\ st' = [st EXCEPT ![c] = "candidate"]
    /\ UNCHANGED <<keptBy, rec, shown, judgeVars, envVars, uiVars, everPrinted>>

Accept(c) ==
    /\ Waiting(c)
    /\ st' = [st EXCEPT ![c] = "active"]
    /\ keptBy' = [keptBy EXCEPT ![c] = "person"]
    /\ UNCHANGED <<rec, shown, judgeVars, envVars, uiVars, everPrinted>>

Reject(c) ==
    /\ Waiting(c)
    /\ st' = [st EXCEPT ![c] = "rejected"]
    /\ UNCHANGED <<keptBy, rec, shown, judgeVars, envVars, uiVars, everPrinted>>

Retire(c) ==
    /\ st[c] \in {"candidate", "active"}
    /\ st' = [st EXCEPT ![c] = "retired"]
    /\ UNCHANGED <<keptBy, rec, shown, judgeVars, envVars, uiVars, everPrinted>>

StartRun ==
    /\ ~run /\ run' = TRUE
    /\ UNCHANGED <<storeVars, judgeVars, trusted, on, uiVars, everPrinted>>

EndRun ==
    /\ run /\ run' = FALSE
    /\ UNCHANGED <<storeVars, judgeVars, trusted, on, uiVars, everPrinted>>

ToggleTrust ==
    /\ trusted' = ~trusted
    /\ UNCHANGED <<storeVars, judgeVars, run, on, uiVars, everPrinted>>

ToggleSwitch ==
    /\ on' = ~on
    /\ UNCHANGED <<storeVars, judgeVars, run, trusted, uiVars, everPrinted>>

Bump(x) == IF x >= 2 THEN 2 ELSE x + 1

ReadSet(u) ==
    {c \in Cand : /\ rec[c] # "none"
                  /\ ~shown[c]
                  /\ ShowDecided \/ ~PersonDecided(c)
                  /\ stat[u][c] = "none"}

StartRead(u) ==
    /\ stat' = [stat EXCEPT ![u] = [c \in Cand |-> IF c \in ReadSet(u) THEN "read" ELSE stat[u][c]]]
    /\ seen' = [seen EXCEPT ![u] = [c \in Cand |-> IF c \in ReadSet(u) THEN PersonDecided(c) ELSE seen[u][c]]]

Launch(u) ==
    /\ phase[u] = "closed"
    /\ IF u \in Acp
       THEN /\ phase' = [phase EXCEPT ![u] = "run"]
            /\ UNCHANGED <<stat, seen>>
       ELSE /\ phase' = [phase EXCEPT ![u] = "pre"]
            /\ IF ReadFirst THEN StartRead(u) ELSE UNCHANGED <<stat, seen>>
    /\ UNCHANGED <<storeVars, judgeVars, envVars, inbox, lines, everPrinted>>

FinishStart(u) ==
    /\ phase[u] = "pre"
    /\ phase' = [phase EXCEPT ![u] = "run"]
    /\ IF ReadFirst THEN UNCHANGED <<stat, seen>> ELSE StartRead(u)
    /\ UNCHANGED <<storeVars, judgeVars, envVars, inbox, lines, everPrinted>>

FetchEvent(u, c) ==
    /\ Connected(u) /\ c \in inbox[u]
    /\ inbox' = [inbox EXCEPT ![u] = @ \ {c}]
    /\ IF stat[u][c] = "none" /\ (ShowDecided \/ ~PersonDecided(c))
       THEN /\ stat' = [stat EXCEPT ![u][c] = "read"]
            /\ seen' = [seen EXCEPT ![u][c] = PersonDecided(c)]
       ELSE UNCHANGED <<stat, seen>>
    /\ UNCHANGED <<storeVars, judgeVars, envVars, phase, lines, everPrinted>>

PrintLine(u, c) ==
    /\ lines' = [lines EXCEPT ![u][c] = Bump(@)]
    /\ everPrinted' = [everPrinted EXCEPT ![c] = TRUE]
    /\ UNCHANGED shown

MarkShown(c) ==
    /\ shown' = [shown EXCEPT ![c] = TRUE]
    /\ UNCHANGED <<lines, everPrinted>>

FirstStep(u, c) ==
    /\ phase[u] # "closed" /\ stat[u][c] = "read"
    /\ stat' = [stat EXCEPT ![u][c] = "half"]
    /\ IF MarkBeforePrint THEN MarkShown(c) ELSE PrintLine(u, c)
    /\ UNCHANGED <<st, keptBy, rec, judgeVars, envVars, phase, inbox, seen>>

SecondStep(u, c) ==
    /\ phase[u] # "closed" /\ stat[u][c] = "half"
    /\ stat' = [stat EXCEPT ![u][c] = "done"]
    /\ IF MarkBeforePrint THEN PrintLine(u, c) ELSE MarkShown(c)
    /\ UNCHANGED <<st, keptBy, rec, judgeVars, envVars, phase, inbox, seen>>

StopUI(u) ==
    /\ phase[u] # "closed"
    /\ phase' = [phase EXCEPT ![u] = "closed"]
    /\ inbox' = [inbox EXCEPT ![u] = {}]
    /\ stat' = [stat EXCEPT ![u] = NoStat]
    /\ seen' = [seen EXCEPT ![u] = NoSeen]
    /\ lines' = [lines EXCEPT ![u] = NoLines]
    /\ UNCHANGED <<storeVars, judgeVars, envVars, everPrinted>>

StartJudge(c) ==
    /\ jc = 0
    /\ StartAllowed
    /\ Eligible(c)
    /\ \A d \in 1..(c - 1) : ~Eligible(d)
    /\ jc' = c /\ jout' = "none"
    /\ UNCHANGED <<storeVars, crashes, envVars, uiVars, everPrinted>>

Decide ==
    /\ jc # 0 /\ jout = "none"
    /\ jout' \in {"allow", "notAllow"}
    /\ UNCHANGED <<storeVars, jc, crashes, envVars, uiVars, everPrinted>>

Commit ==
    /\ jc # 0 /\ jout # "none"
    /\ LET c == jc
           allow == jout = "allow"
           fits == NoRecheck \/ (Waiting(c) /\ rec[c] = "none")
       IN IF fits
          THEN /\ rec' = [rec EXCEPT ![c] = IF allow THEN "kept" ELSE "left"]
               /\ st' = IF allow THEN [st EXCEPT ![c] = "active"] ELSE st
               /\ keptBy' = IF allow THEN [keptBy EXCEPT ![c] = "auto"] ELSE keptBy
               /\ inbox' = [u \in UIs |-> IF u \in Receivers THEN inbox[u] \cup {c} ELSE inbox[u]]
               /\ shown' = [shown EXCEPT ![c] = MarkAtCommit /\ Receivers # {}]
          ELSE UNCHANGED <<storeVars, inbox>>
    /\ jc' = 0 /\ jout' = "none"
    /\ UNCHANGED <<crashes, envVars, phase, stat, seen, lines, everPrinted>>

DaemonStop ==
    /\ jc # 0 /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ jc' = 0 /\ jout' = "none"
    /\ UNCHANGED <<storeVars, envVars, uiVars, everPrinted>>

StartAny == \E c \in Cand : StartJudge(c)

JudgeStep == StartAny \/ Decide \/ Commit

Person ==
    \/ \E c \in Cand : Accept(c) \/ Reject(c) \/ Retire(c)
    \/ StartRun \/ EndRun \/ ToggleTrust \/ ToggleSwitch
    \/ \E u \in UIs : Launch(u) \/ StopUI(u)

UIStep(u) ==
    \/ FinishStart(u)
    \/ \E c \in Cand : FetchEvent(u, c) \/ FirstStep(u, c) \/ SecondStep(u, c)

Next ==
    \/ Person
    \/ \E c \in Cand : Reflect(c)
    \/ JudgeStep
    \/ DaemonStop
    \/ \E u \in UIs : UIStep(u)

Fairness ==
    /\ SF_vars(StartAny)
    /\ WF_vars(Decide)
    /\ WF_vars(Commit)
    /\ \A u \in UIs :
         /\ WF_vars(FinishStart(u))
         /\ WF_vars(\E c \in Cand : FetchEvent(u, c))
         /\ WF_vars(\E c \in Cand : FirstStep(u, c))
         /\ WF_vars(\E c \in Cand : SecondStep(u, c))

Spec == Init /\ [][Next]_vars /\ Fairness

Symmetry == Permutations(UIs)

-----------------------------------------------------------------------------

TypeOK ==
    /\ st \in [Cand -> {"absent", "candidate", "active", "rejected", "retired"}]
    /\ keptBy \in [Cand -> {"none", "person", "auto"}]
    /\ rec \in [Cand -> {"none", "kept", "left"}]
    /\ shown \in [Cand -> BOOLEAN]
    /\ jc \in 0..N /\ jout \in {"none", "allow", "notAllow"}
    /\ crashes \in 0..MaxCrashes
    /\ run \in BOOLEAN /\ trusted \in BOOLEAN /\ on \in BOOLEAN
    /\ phase \in [UIs -> {"closed", "pre", "run"}]
    /\ inbox \in [UIs -> SUBSET Cand]
    /\ stat \in [UIs -> [Cand -> {"none", "read", "half", "done"}]]
    /\ seen \in [UIs -> [Cand -> BOOLEAN]]
    /\ lines \in [UIs -> [Cand -> 0..2]]
    /\ everPrinted \in [Cand -> BOOLEAN]

AutoKeptHasKeptRecord == \A c \in Cand : keptBy[c] = "auto" => rec[c] = "kept"

AutoKeepsOnlyAllowed ==
    [][\A c \in Cand : (rec[c] # "kept" /\ rec'[c] = "kept") => (jc = c /\ jout = "allow")]_vars

LeftNeverAutoKept == \A c \in Cand : rec[c] = "left" => keptBy[c] # "auto"

JudgeNeverRejects ==
    [][JudgeStep => \A c \in Cand :
         /\ st'[c] \in {"rejected", "retired"} => st'[c] = st[c]
         /\ (rec[c] = "none" /\ rec'[c] = "left") => st'[c] = "candidate"]_vars

PersonWins ==
    [][JudgeStep => \A c \in Cand : PersonDecided(c) =>
         /\ st'[c] = st[c]
         /\ keptBy'[c] = keptBy[c]
         /\ rec'[c] = rec[c]]_vars

JudgedOnce ==
    [][/\ \A c \in Cand : rec[c] # "none" => rec'[c] = rec[c]
       /\ \A c \in Cand : StartJudge(c) => rec[c] = "none"]_vars

StartGuard == [][(jc = 0 /\ jc' # 0) => GuardHolds]_vars

ReviewOrder == [][(jc = 0 /\ jc' # 0) => \A d \in 1..(jc' - 1) : ~Unjudged(d)]_vars

OneAtATime == [][(jc # 0 /\ jc' # 0) => jc' = jc]_vars

PrintOncePerProcess == \A u \in UIs : \A c \in Cand : lines[u][c] <= 1

NoLineWithoutRecord ==
    /\ \A u \in UIs : \A c \in Cand : lines[u][c] > 0 => rec[c] # "none"
    /\ \A c \in Cand : everPrinted[c] => rec[c] # "none"

NoLineAfterDecision == \A u \in UIs : \A c \in Cand : lines[u][c] > 0 => ~seen[u][c]

Reached(c) == everPrinted[c] \/ PersonDecided(c)

Idle(u) ==
    /\ phase[u] = "run"
    /\ inbox[u] = {}
    /\ \A c \in Cand : stat[u][c] \notin {"read", "half"}

Progress ==
    (<>[](on /\ trusted) /\ []<>(~run))
        => \A c \in Cand : Unjudged(c) ~> (rec[c] # "none" \/ ~Waiting(c))

LineReachesAPerson ==
    []<>(\E u \in Tuis : Idle(u))
        => \A c \in Cand : (rec[c] # "none") ~> Reached(c)

LineReachesOpenReader ==
    \A u \in UIs : \A c \in Cand :
        (Connected(u) /\ c \in inbox[u]) ~> (Reached(c) \/ phase[u] = "closed")

LineReachesOpenTui ==
    \A u \in Tuis : \A c \in Cand :
        (phase[u] = "run" /\ rec[c] # "none") ~> (Reached(c) \/ phase[u] = "closed")

=============================================================================
