---------------------------- MODULE CompletionGate ----------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
    AlwaysConds,
    MutationConds,
    CheckDeclared,
    MaxMutations,
    MaxModelRuns,
    MaxCrashes,
    MaxHooks,
    ModelEvidence,
    StaleKept,
    CountStarted,
    RerunNoMutation,
    LateUncounted

ASSUME /\ AlwaysConds \cap MutationConds = {}
       /\ CheckDeclared \in BOOLEAN
       /\ MaxMutations \in Nat
       /\ MaxModelRuns \in Nat
       /\ MaxCrashes \in Nat
       /\ MaxHooks \in Nat
       /\ ModelEvidence \in BOOLEAN
       /\ StaleKept \in BOOLEAN
       /\ CountStarted \in BOOLEAN
       /\ RerunNoMutation \in BOOLEAN
       /\ LateUncounted \in BOOLEAN

Conds == IF CheckDeclared THEN AlwaysConds \cup MutationConds ELSE {}

StopReasonUnmet == "conditions_unmet"

StartedEvent == "verification.started"

CompletedEvent == "verification.completed"

WhenValues == {"always", "after_mutation"}

MutatingReconciled == {"already_applied", "unknown"}

MutationShapes == {<<"tool.completed", "write">>, <<"tool.reconciled", "unknown">>, <<"tool.completed", "late">>}

NoCond == "-"

VARIABLES j, status, reason, unverified, pc, wc, wdecl, crashes

vars == <<j, status, reason, unverified, pc, wc, wdecl, crashes>>

NoDecl == <<{}, {}>>

Ev(k, c, r, o, m) == [k |-> k, c |-> c, r |-> r, o |-> o, m |-> m, d |-> NoDecl]

Declared == IF CheckDeclared THEN <<AlwaysConds, MutationConds>> ELSE NoDecl

RunStarted == [Ev("run.started", NoCond, 0, "-", 0) EXCEPT !.d = Declared]

-----------------------------------------------------------------------------

Writes(e) ==
    \/ e.k = "tool.completed" /\ e.o # "read_only"
    \/ e.k = "tool.reconciled" /\ e.o \in MutatingReconciled

IsMutation(e) == Writes(e) /\ ~(LateUncounted /\ e.o = "late")

LastMut == Cardinality({i \in DOMAIN j : IsMutation(j[i])})

TrueMut == Cardinality({i \in DOMAIN j : Writes(j[i])})

Round == Cardinality({i \in DOMAIN j : j[i].k = "model.responded"})

ModelRuns == Cardinality({i \in DOMAIN j : j[i].k = "tool.completed" /\ j[i].o = "read_only"})

Hooks == Cardinality({i \in DOMAIN j : j[i].k = "hook.continue"})

CompletedOf(c) == {i \in DOMAIN j : j[i].k = CompletedEvent /\ j[i].c = c}

PassAt(c, m) == \E i \in CompletedOf(c) : j[i].o = "passed" /\ j[i].m = m

ValidPass(c) == PassAt(c, LastMut)

AnyPass(c) == \E i \in CompletedOf(c) : j[i].o = "passed"

CurrentFail(c) == \E i \in CompletedOf(c) : j[i].o = "failed" /\ j[i].m = LastMut

DoneIn(c, r) == \E i \in CompletedOf(c) : j[i].r = r

StartedNow(c) == \E i \in DOMAIN j : j[i].k = StartedEvent /\ j[i].c = c /\ j[i].m = LastMut

StartedIn(c, r) == \E i \in DOMAIN j : j[i].k = StartedEvent /\ j[i].c = c /\ j[i].r = r

ModelRan(c) == \E i \in DOMAIN j : j[i].k = "tool.completed" /\ j[i].c = c /\ j[i].o = "read_only" /\ j[i].m = LastMut

RequiredAt(c, m) == c \in AlwaysConds \/ m > 0

Required(c) == RequiredAt(c, LastMut)

Counts(c) ==
    \/ ValidPass(c)
    \/ StaleKept /\ AnyPass(c)
    \/ CountStarted /\ StartedNow(c)
    \/ ModelEvidence /\ ModelRan(c)

Owed(c) == Required(c) /\ ~Counts(c)

Runnable(c) == Owed(c) /\ ~DoneIn(c, Round) /\ (RerunNoMutation \/ ~CurrentFail(c))

Satisfied == \A c \in Conds : ~Owed(c)

FailedRoundBefore ==
    \E i \in DOMAIN j : j[i].k = CompletedEvent /\ j[i].o = "failed" /\ j[i].r < Round /\ j[i].m = LastMut

TailOpen == j[Len(j)].k \in {"model.responded", StartedEvent, CompletedEvent}

-----------------------------------------------------------------------------
Init ==
    /\ j = <<RunStarted>>
    /\ status = "RUNNING"
    /\ reason = "-"
    /\ unverified = FALSE
    /\ pc = "none"
    /\ wc = NoCond
    /\ wdecl = NoDecl
    /\ crashes = 0

Takeover ==
    /\ status = "RUNNING"
    /\ pc = "none"
    /\ wdecl' = j[1].d
    /\ pc' = IF TailOpen THEN "gate" ELSE "work"
    /\ UNCHANGED <<j, status, reason, unverified, wc, crashes>>

Crash ==
    /\ pc # "none"
    /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ pc' = "none"
    /\ wc' = NoCond
    /\ wdecl' = NoDecl
    /\ UNCHANGED <<j, status, reason, unverified>>

Mutate ==
    /\ pc = "work"
    /\ TrueMut < MaxMutations
    /\ \E s \in MutationShapes : j' = Append(j, Ev(s[1], NoCond, 0, s[2], 0))
    /\ UNCHANGED <<status, reason, unverified, pc, wc, wdecl, crashes>>

ModelRun ==
    /\ pc = "work"
    /\ ModelRuns < MaxModelRuns
    /\ \E c \in Conds : j' = Append(j, Ev("tool.completed", c, 0, "read_only", LastMut))
    /\ UNCHANGED <<status, reason, unverified, pc, wc, wdecl, crashes>>

StopAttempt ==
    /\ pc = "work"
    /\ j' = Append(j, Ev("model.responded", NoCond, 0, "stop", 0))
    /\ pc' = "gate"
    /\ UNCHANGED <<status, reason, unverified, wc, wdecl, crashes>>

StartCheck ==
    /\ pc = "gate"
    /\ wc = NoCond
    /\ \E c \in Conds :
         /\ Runnable(c)
         /\ j' = Append(j, Ev(StartedEvent, c, Round, "-", LastMut))
         /\ wc' = c
    /\ UNCHANGED <<status, reason, unverified, pc, wdecl, crashes>>

FinishCheck ==
    /\ pc = "gate"
    /\ wc # NoCond
    /\ \E o \in {"passed", "failed"} : j' = Append(j, Ev(CompletedEvent, wc, Round, o, LastMut))
    /\ wc' = NoCond
    /\ UNCHANGED <<status, reason, unverified, pc, wdecl, crashes>>

Decide ==
    /\ pc = "gate"
    /\ wc = NoCond
    /\ \A c \in Conds : ~Runnable(c)
    /\ \/ /\ Satisfied
          /\ status' = "COMPLETED"
          /\ unverified' = (Conds = {} /\ LastMut > 0)
          /\ pc' = "none"
          /\ UNCHANGED <<j, reason>>
       \/ /\ Satisfied
          /\ Hooks < MaxHooks
          /\ j' = Append(j, Ev("hook.continue", NoCond, 0, "-", 0))
          /\ pc' = "work"
          /\ UNCHANGED <<status, reason, unverified>>
       \/ /\ ~Satisfied
          /\ FailedRoundBefore
          /\ ~RerunNoMutation
          /\ status' = "STOPPED"
          /\ reason' = StopReasonUnmet
          /\ pc' = "none"
          /\ UNCHANGED <<j, unverified>>
       \/ /\ ~Satisfied
          /\ (~FailedRoundBefore \/ RerunNoMutation)
          /\ j' = Append(j, Ev("user.message", NoCond, 0, "-", 0))
          /\ pc' = "work"
          /\ UNCHANGED <<status, reason, unverified>>
    /\ UNCHANGED <<wc, wdecl, crashes>>

Terminated ==
    /\ status # "RUNNING"
    /\ UNCHANGED vars

StepNoCrash == Takeover \/ Mutate \/ ModelRun \/ StopAttempt \/ StartCheck \/ FinishCheck \/ Decide

Next == StepNoCrash \/ Crash \/ Terminated

Spec == Init /\ [][Next]_vars /\ WF_vars(StepNoCrash)

-----------------------------------------------------------------------------

TypeOK ==
    /\ status \in {"RUNNING", "COMPLETED", "STOPPED"}
    /\ reason \in {"-", StopReasonUnmet}
    /\ unverified \in BOOLEAN
    /\ pc \in {"none", "work", "gate"}
    /\ wc \in Conds \cup {NoCond}
    /\ crashes \in 0..MaxCrashes
    /\ \A i \in DOMAIN j : j[i].c \in Conds \cup {NoCond}

CompletionNeedsCheck ==
    status = "COMPLETED" => \A c \in Conds : RequiredAt(c, TrueMut) => PassAt(c, TrueMut)

UnverifiedOnlyWithoutCheck == unverified => ~CheckDeclared

StaleResultNotKept == \A c \in Conds : Counts(c) => ValidPass(c)

StoppedHasWitness ==
    reason = StopReasonUnmet =>
        /\ status = "STOPPED"
        /\ \E c \in Conds : Required(c) /\ ~ValidPass(c) /\ CurrentFail(c)

StartedNotCounted ==
    /\ \A c \in Conds : (StartedIn(c, Round) /\ ~DoneIn(c, Round)) => ~Counts(c)
    /\ \A c \in Conds : \A r \in 0..Round : Cardinality({i \in CompletedOf(c) : j[i].r = r}) <= 1

RerunNeedsMutation ==
    \A a, b \in DOMAIN j :
        (j[a].k = CompletedEvent /\ j[a].o = "failed" /\ j[b].k = CompletedEvent /\ j[b].o = "failed" /\ j[a].r < j[b].r)
            => j[a].m < j[b].m

DeclarationImmutable ==
    /\ j[1].d = Declared
    /\ pc # "none" => wdecl = Declared
    /\ \A i \in DOMAIN j : i > 1 => j[i].k # "run.started"

TerminalNeverChanges == [][status # "RUNNING" => (status' = status /\ j' = j /\ reason' = reason)]_vars

EventsAppendOnly == [][SubSeq(j', 1, Len(j)) = j]_vars

Terminates == <>(status # "RUNNING")

=============================================================================
