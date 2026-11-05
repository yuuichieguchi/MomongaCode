--------------------------- MODULE RequestBreaker ---------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Requests, Threshold, Budget, MaxAttempts, Targets, Variant

ASSUME Variant \in {"decided", "perSend", "twoTrials", "cut"}
ASSUME Threshold \in Nat \ {0} /\ Budget \in Nat \ {0} /\ MaxAttempts \in Nat \ {0} /\ Targets \in Nat \ {0}

TargetIds == 1..Targets
None == "none"
Outcomes == {"ok", "fail", "neutral"}

VARIABLES brk, fails, trial, holder, st, at, here, left, sent, last, verdicts, reason

vars == <<brk, fails, trial, holder, st, at, here, left, sent, last, verdicts, reason>>

TypeOK ==
    /\ brk \in [TargetIds -> {"closed", "open", "half"}]
    /\ fails \in [TargetIds -> 0..Threshold]
    /\ trial \in [TargetIds -> Requests \cup {None}]
    /\ holder \in [Requests -> [TargetIds -> BOOLEAN]]
    /\ st \in [Requests -> {"idle", "active", "done"}]
    /\ at \in [Requests -> TargetIds]
    /\ here \in [Requests -> 0..Budget]
    /\ left \in [Requests -> 0..Budget]
    /\ sent \in [Requests -> [TargetIds -> BOOLEAN]]
    /\ last \in [Requests -> [TargetIds -> {None, "fail", "neutral"}]]
    /\ verdicts \in [Requests -> [TargetIds -> 0..(Budget + 1)]]
    /\ reason \in [Requests -> {None, "success", "budget", "cut"}]

Init ==
    /\ brk = [t \in TargetIds |-> "closed"]
    /\ fails = [t \in TargetIds |-> 0]
    /\ trial = [t \in TargetIds |-> None]
    /\ holder = [r \in Requests |-> [t \in TargetIds |-> FALSE]]
    /\ st = [r \in Requests |-> "idle"]
    /\ at = [r \in Requests |-> 1]
    /\ here = [r \in Requests |-> 0]
    /\ left = [r \in Requests |-> Budget]
    /\ sent = [r \in Requests |-> [t \in TargetIds |-> FALSE]]
    /\ last = [r \in Requests |-> [t \in TargetIds |-> None]]
    /\ verdicts = [r \in Requests |-> [t \in TargetIds |-> 0]]
    /\ reason = [r \in Requests |-> None]

CanPass(r, t) == brk[t] = "closed" \/ (brk[t] = "half" /\ trial[t] \in {None, r})

HasLater(r) == at[r] < Targets

ClearHolders(t) == [q \in Requests |-> [holder[q] EXCEPT ![t] = FALSE]]

Apply(r, t, v) ==
    CASE brk[t] = "closed" /\ v = "fail" ->
            /\ fails' = [fails EXCEPT ![t] = IF fails[t] + 1 >= Threshold THEN 0 ELSE fails[t] + 1]
            /\ brk' = [brk EXCEPT ![t] = IF fails[t] + 1 >= Threshold THEN "open" ELSE "closed"]
            /\ UNCHANGED <<trial, holder>>
      [] brk[t] = "closed" /\ v = "ok" ->
            /\ fails' = [fails EXCEPT ![t] = 0]
            /\ UNCHANGED <<brk, trial, holder>>
      [] brk[t] = "half" /\ v = "ok" ->
            /\ brk' = [brk EXCEPT ![t] = "closed"]
            /\ fails' = [fails EXCEPT ![t] = 0]
            /\ trial' = [trial EXCEPT ![t] = None]
            /\ holder' = ClearHolders(t)
      [] brk[t] = "half" /\ holder[r][t] /\ v = "fail" ->
            /\ brk' = [brk EXCEPT ![t] = "open"]
            /\ trial' = [trial EXCEPT ![t] = None]
            /\ holder' = ClearHolders(t)
            /\ UNCHANGED fails
      [] brk[t] = "half" /\ holder[r][t] /\ v = "neutral" ->
            /\ trial' = [trial EXCEPT ![t] = None]
            /\ holder' = [holder EXCEPT ![r][t] = FALSE]
            /\ UNCHANGED <<brk, fails>>
      [] OTHER -> UNCHANGED <<brk, fails, trial, holder>>

Record(r, t, v) ==
    /\ verdicts' = [verdicts EXCEPT ![r][t] = @ + 1]
    /\ Apply(r, t, v)

VerdictOf(r, t) == IF last[r][t] = "fail" THEN "fail" ELSE "neutral"

Start(r) ==
    /\ st[r] = "idle"
    /\ st' = [st EXCEPT ![r] = "active"]
    /\ UNCHANGED <<brk, fails, trial, holder, at, here, left, sent, last, verdicts, reason>>

Leave(r) ==
    LET t == at[r] IN
    /\ IF sent[r][t] THEN Record(r, t, VerdictOf(r, t)) ELSE UNCHANGED <<verdicts, brk, fails, trial, holder>>
    /\ at' = [at EXCEPT ![r] = t + 1]
    /\ here' = [here EXCEPT ![r] = 0]

SkipOpen(r) ==
    LET t == at[r] IN
    /\ st[r] = "active"
    /\ ~CanPass(r, t)
    /\ HasLater(r)
    /\ CanPass(r, t + 1)
    /\ Leave(r)
    /\ UNCHANGED <<st, left, sent, last, reason>>

Cut(r) ==
    LET t == at[r] IN
    /\ Variant = "cut"
    /\ st[r] = "active"
    /\ ~CanPass(r, t)
    /\ ~(HasLater(r) /\ CanPass(r, t + 1))
    /\ st' = [st EXCEPT ![r] = "done"]
    /\ reason' = [reason EXCEPT ![r] = "cut"]
    /\ UNCHANGED <<brk, fails, trial, holder, at, here, left, sent, last, verdicts>>

Admits(r, t) ==
    \/ /\ brk[t] = "half" /\ trial[t] = None
       /\ trial' = [trial EXCEPT ![t] = r]
       /\ holder' = [holder EXCEPT ![r][t] = TRUE]
    \/ /\ Variant = "twoTrials" /\ brk[t] = "half" /\ trial[t] \notin {None, r}
       /\ trial' = [trial EXCEPT ![t] = r]
       /\ holder' = [holder EXCEPT ![r][t] = TRUE]
    \/ /\ ~(brk[t] = "half" /\ trial[t] = None)
       /\ Variant # "twoTrials" \/ brk[t] # "half" \/ trial[t] \in {None, r}
       /\ UNCHANGED <<trial, holder>>

MaySend(r) ==
    LET t == at[r] IN
    /\ st[r] = "active"
    /\ left[r] > 0
    /\ here[r] < MaxAttempts \/ ~HasLater(r)
    /\ ~(~CanPass(r, t) /\ HasLater(r) /\ CanPass(r, t + 1))
    /\ (Variant = "cut") => CanPass(r, t)

SendOk(r) ==
    LET t == at[r] IN
    /\ MaySend(r)
    /\ verdicts' = [verdicts EXCEPT ![r][t] = @ + 1]
    /\ brk' = [brk EXCEPT ![t] = "closed"]
    /\ fails' = [fails EXCEPT ![t] = 0]
    /\ trial' = [trial EXCEPT ![t] = None]
    /\ holder' = ClearHolders(t)
    /\ st' = [st EXCEPT ![r] = "done"]
    /\ reason' = [reason EXCEPT ![r] = "success"]
    /\ sent' = [sent EXCEPT ![r][t] = TRUE]
    /\ UNCHANGED <<at, here, left, last>>

SendError(r, e) ==
    LET t == at[r] IN
    /\ MaySend(r)
    /\ Admits(r, t)
    /\ sent' = [sent EXCEPT ![r][t] = TRUE]
    /\ last' = [last EXCEPT ![r][t] = e]
    /\ left' = [left EXCEPT ![r] = @ - 1]
    /\ here' = [here EXCEPT ![r] = @ + 1]
    /\ IF Variant = "perSend"
         THEN verdicts' = [verdicts EXCEPT ![r][t] = @ + 1]
         ELSE UNCHANGED verdicts
    /\ UNCHANGED <<brk, fails, st, at, reason>>

AfterError(r) ==
    LET t == at[r] IN
    /\ st[r] = "active"
    /\ last[r][t] # None
    /\ here[r] > 0
    /\ \/ /\ left[r] = 0
          /\ Record(r, t, VerdictOf(r, t))
          /\ st' = [st EXCEPT ![r] = "done"]
          /\ reason' = [reason EXCEPT ![r] = "budget"]
          /\ UNCHANGED <<at, here>>
       \/ /\ left[r] > 0
          /\ HasLater(r)
          /\ Leave(r)
          /\ UNCHANGED <<st, reason>>
    /\ UNCHANGED <<left, sent, last>>

Tick(t) ==
    /\ brk[t] = "open"
    /\ brk' = [brk EXCEPT ![t] = "half"]
    /\ trial' = [trial EXCEPT ![t] = None]
    /\ holder' = ClearHolders(t)
    /\ UNCHANGED <<fails, st, at, here, left, sent, last, verdicts, reason>>

Terminated ==
    /\ \A r \in Requests : st[r] = "done"
    /\ UNCHANGED vars

Next ==
    \/ \E r \in Requests :
          \/ Start(r)
          \/ SkipOpen(r)
          \/ Cut(r)
          \/ SendOk(r)
          \/ \E e \in {"fail", "neutral"} : SendError(r, e)
          \/ AfterError(r)
    \/ \E t \in TargetIds : Tick(t)
    \/ Terminated

Spec == Init /\ [][Next]_vars

NeverCut == \A r \in Requests : (st[r] = "done" /\ reason[r] # "success") => left[r] = 0

OneVerdictPerRequestAndTarget == \A r \in Requests : \A t \in TargetIds : verdicts[r][t] <= 1

AtMostOneTrial == \A t \in TargetIds : Cardinality({r \in Requests : holder[r][t]}) <= 1
=============================================================================
