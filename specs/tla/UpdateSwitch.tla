---------------------------- MODULE UpdateSwitch ----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Runs, Jobs, Clients, Sessions, MaxV, MaxSteps, MaxStarts, MaxExecFails, Variant

ASSUME Variant \in {"decided", "today", "jobsNotHeld", "admitPending", "noNotice", "noRecord", "refuseOld"}
ASSUME MaxV \in Nat \ {0, 1}
ASSUME MaxSteps \in Nat \ {0}
ASSUME MaxStarts \in Nat \ {0}
ASSUME MaxExecFails \in Nat
ASSUME Sessions \subseteq Clients

Phases == {"down", "serving", "pending", "closing"}
RunStates == {"none", "queued", "stepping", "done"}
JobStates == {"none", "live", "ended", "killed"}
ClientStates == {"none", "starting", "waiting", "connected", "handing", "refused", "left"}
Messages == {"none", "pending", "connected", "reopen", "stillRunning", "reconnecting", "moving", "handoverFailed"}

VARIABLES iv, dv, phase, run, stepsLeft, job, cs, cv, msg, starts, abortedRun, draft, rec, execFails

vars == <<iv, dv, phase, run, stepsLeft, job, cs, cv, msg, starts, abortedRun, draft, rec, execFails>>

TypeOK ==
    /\ iv \in 1..MaxV
    /\ dv \in 0..MaxV
    /\ phase \in Phases
    /\ (phase = "down") <=> (dv = 0)
    /\ run \in [Runs -> RunStates]
    /\ stepsLeft \in [Runs -> 0..MaxSteps]
    /\ job \in [Jobs -> JobStates]
    /\ cs \in [Clients -> ClientStates]
    /\ cv \in [Clients -> 0..MaxV]
    /\ msg \in [Clients -> Messages]
    /\ starts \in 0..MaxStarts
    /\ abortedRun \in BOOLEAN
    /\ draft \in [Clients -> 0..1]
    /\ rec \in [Clients -> 0..1]
    /\ execFails \in 0..MaxExecFails

Stepping == {r \in Runs : run[r] = "stepping"}

LiveJobs == {j \in Jobs : job[j] = "live"}

Quiet == Stepping = {} /\ LiveJobs = {}

Holds == IF Variant \in {"today", "jobsNotHeld"} THEN Stepping = {} ELSE Quiet

Admits == IF Variant = "admitPending" THEN phase \in {"serving", "pending"} ELSE phase = "serving"

Work == Cardinality(Stepping) + Cardinality(LiveJobs)

NoticeFor(text) == IF Variant = "noNotice" THEN "none" ELSE text

Init ==
    /\ iv = 1
    /\ dv = 0
    /\ phase = "down"
    /\ run = [r \in Runs |-> "none"]
    /\ stepsLeft = [r \in Runs |-> 0]
    /\ job = [j \in Jobs |-> "none"]
    /\ cs = [c \in Clients |-> "none"]
    /\ cv = [c \in Clients |-> 0]
    /\ msg = [c \in Clients |-> "none"]
    /\ starts = 0
    /\ abortedRun = FALSE
    /\ draft = [c \in Clients |-> 0]
    /\ rec = [c \in Clients |-> 0]
    /\ execFails = 0

Install(c) ==
    /\ cs[c] = "none"
    /\ iv < MaxV
    /\ starts < MaxStarts
    /\ iv' = iv + 1
    /\ cs' = [cs EXCEPT ![c] = "starting"]
    /\ cv' = [cv EXCEPT ![c] = iv + 1]
    /\ msg' = [msg EXCEPT ![c] = "none"]
    /\ starts' = starts + 1
    /\ UNCHANGED <<dv, phase, run, stepsLeft, job, abortedRun, draft, rec, execFails>>

StartClient(c, v) ==
    /\ cs[c] = "none"
    /\ starts < MaxStarts
    /\ v \in 1..iv
    /\ cs' = [cs EXCEPT ![c] = "starting"]
    /\ cv' = [cv EXCEPT ![c] = v]
    /\ msg' = [msg EXCEPT ![c] = "none"]
    /\ starts' = starts + 1
    /\ UNCHANGED <<iv, dv, phase, run, stepsLeft, job, abortedRun, draft, rec, execFails>>

SpawnDaemon(c) ==
    /\ cs[c] = "starting"
    /\ phase = "down"
    /\ dv' = iv
    /\ phase' = "serving"
    /\ UNCHANGED <<iv, run, stepsLeft, job, cs, cv, msg, starts, abortedRun, draft, rec, execFails>>

Evaluate(c) ==
    /\ cs[c] = "starting"
    /\ phase \in {"serving", "pending"}
    /\ \/ /\ cv[c] = dv
          /\ cs' = [cs EXCEPT ![c] = "connected"]
          /\ msg' = [msg EXCEPT ![c] = "connected"]
          /\ phase' = phase
          /\ rec' = rec
       \/ /\ cv[c] > dv
          /\ cs' = [cs EXCEPT ![c] = "waiting"]
          /\ msg' = [msg EXCEPT ![c] = NoticeFor("pending")]
          /\ phase' = "pending"
          /\ rec' = rec
       \/ /\ cv[c] < dv
          /\ c \in Sessions
          /\ Variant # "refuseOld"
          /\ cs' = [cs EXCEPT ![c] = "handing"]
          /\ msg' = [msg EXCEPT ![c] = NoticeFor("moving")]
          /\ rec' = [rec EXCEPT ![c] = IF Variant = "noRecord" THEN 0 ELSE draft[c]]
          /\ phase' = phase
       \/ /\ cv[c] < dv
          /\ (c \notin Sessions \/ Variant = "refuseOld")
          /\ cs' = [cs EXCEPT ![c] = "refused"]
          /\ msg' = [msg EXCEPT ![c] = NoticeFor("reopen")]
          /\ phase' = phase
          /\ rec' = rec
    /\ UNCHANGED <<iv, dv, run, stepsLeft, job, cv, starts, abortedRun, draft, execFails>>

Exec(c) ==
    /\ cs[c] = "handing"
    /\ cs' = [cs EXCEPT ![c] = "starting"]
    /\ cv' = [cv EXCEPT ![c] = iv]
    /\ msg' = [msg EXCEPT ![c] = "none"]
    /\ draft' = [draft EXCEPT ![c] = rec[c]]
    /\ rec' = [rec EXCEPT ![c] = 0]
    /\ UNCHANGED <<iv, dv, phase, run, stepsLeft, job, starts, abortedRun, execFails>>

ExecFail(c) ==
    /\ cs[c] = "handing"
    /\ execFails < MaxExecFails
    /\ execFails' = execFails + 1
    /\ cs' = [cs EXCEPT ![c] = "refused"]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("handoverFailed")]
    /\ rec' = [rec EXCEPT ![c] = 0]
    /\ UNCHANGED <<iv, dv, phase, run, stepsLeft, job, cv, starts, abortedRun, draft>>

Retry(c) ==
    /\ cs[c] = "waiting"
    /\ phase \in {"serving", "down"}
    /\ cs' = [cs EXCEPT ![c] = "starting"]
    /\ UNCHANGED <<iv, dv, phase, run, stepsLeft, job, cv, msg, starts, abortedRun, draft, rec, execFails>>

Leave(c) ==
    /\ cs[c] = "waiting"
    /\ cs' = [cs EXCEPT ![c] = "left"]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("stillRunning")]
    /\ UNCHANGED <<iv, dv, phase, run, stepsLeft, job, cv, starts, abortedRun, draft, rec, execFails>>

Finish(c) ==
    /\ cs[c] \in {"connected", "refused", "left"}
    /\ cs' = [cs EXCEPT ![c] = "none"]
    /\ cv' = [cv EXCEPT ![c] = 0]
    /\ msg' = [msg EXCEPT ![c] = "none"]
    /\ draft' = [draft EXCEPT ![c] = 0]
    /\ UNCHANGED <<iv, dv, phase, run, stepsLeft, job, starts, abortedRun, rec, execFails>>

Type(c) ==
    /\ c \in Sessions
    /\ cs[c] \in {"connected", "starting", "waiting"}
    /\ draft[c] = 0
    /\ draft' = [draft EXCEPT ![c] = 1]
    /\ UNCHANGED <<iv, dv, phase, run, stepsLeft, job, cs, cv, msg, starts, abortedRun, rec, execFails>>

Send(c) ==
    /\ c \in Sessions
    /\ cs[c] = "connected"
    /\ draft[c] = 1
    /\ draft' = [draft EXCEPT ![c] = 0]
    /\ UNCHANGED <<iv, dv, phase, run, stepsLeft, job, cs, cv, msg, starts, abortedRun, rec, execFails>>

Submit(r) ==
    /\ run[r] = "none"
    /\ phase \in {"serving", "pending"}
    /\ \E c \in Clients : cs[c] = "connected"
    /\ run' = [run EXCEPT ![r] = "queued"]
    /\ \E n \in 1..MaxSteps : stepsLeft' = [stepsLeft EXCEPT ![r] = n]
    /\ UNCHANGED <<iv, dv, phase, job, cs, cv, msg, starts, abortedRun, draft, rec, execFails>>

Claim(r) ==
    /\ run[r] = "queued"
    /\ Admits
    /\ run' = [run EXCEPT ![r] = "stepping"]
    /\ UNCHANGED <<iv, dv, phase, stepsLeft, job, cs, cv, msg, starts, abortedRun, draft, rec, execFails>>

StepEnd(r) ==
    /\ run[r] = "stepping"
    /\ stepsLeft' = [stepsLeft EXCEPT ![r] = stepsLeft[r] - 1]
    /\ run' = [run EXCEPT ![r] = IF stepsLeft[r] = 1 THEN "done" ELSE "queued"]
    /\ UNCHANGED <<iv, dv, phase, job, cs, cv, msg, starts, abortedRun, draft, rec, execFails>>

JobStart(j) ==
    /\ job[j] = "none"
    /\ Stepping # {}
    /\ Admits
    /\ job' = [job EXCEPT ![j] = "live"]
    /\ UNCHANGED <<iv, dv, phase, run, stepsLeft, cs, cv, msg, starts, abortedRun, draft, rec, execFails>>

JobEnd(j) ==
    /\ job[j] = "live"
    /\ job' = [job EXCEPT ![j] = "ended"]
    /\ UNCHANGED <<iv, dv, phase, run, stepsLeft, cs, cv, msg, starts, abortedRun, draft, rec, execFails>>

Expire ==
    /\ Variant = "today"
    /\ phase = "pending"
    /\ Stepping # {}
    /\ abortedRun' = TRUE
    /\ run' = [r \in Runs |-> IF run[r] = "stepping" THEN "queued" ELSE run[r]]
    /\ UNCHANGED <<iv, dv, phase, stepsLeft, job, cs, cv, msg, starts, draft, rec, execFails>>

SwitchBegin ==
    /\ phase = "pending"
    /\ Holds
    /\ phase' = "closing"
    /\ UNCHANGED <<iv, dv, run, stepsLeft, job, cs, cv, msg, starts, abortedRun, draft, rec, execFails>>

Close ==
    /\ phase = "closing"
    /\ phase' = "down"
    /\ dv' = 0
    /\ job' = [j \in Jobs |-> IF job[j] = "live" THEN "killed" ELSE job[j]]
    /\ cs' = [c \in Clients |-> IF cs[c] = "connected" THEN "starting" ELSE cs[c]]
    /\ msg' = [c \in Clients |-> IF cs[c] = "connected" THEN NoticeFor("reconnecting") ELSE msg[c]]
    /\ UNCHANGED <<iv, run, stepsLeft, cv, starts, abortedRun, draft, rec, execFails>>

Next ==
    \/ \E c \in Clients : Install(c) \/ SpawnDaemon(c) \/ Evaluate(c) \/ Exec(c) \/ ExecFail(c) \/ Retry(c) \/ Leave(c) \/ Finish(c) \/ Type(c) \/ Send(c)
    \/ \E c \in Clients, v \in 1..MaxV : StartClient(c, v)
    \/ \E r \in Runs : Submit(r) \/ Claim(r) \/ StepEnd(r)
    \/ \E j \in Jobs : JobStart(j) \/ JobEnd(j)
    \/ Expire
    \/ SwitchBegin
    \/ Close

Fairness ==
    /\ \A c \in Clients : WF_vars(SpawnDaemon(c)) /\ WF_vars(Evaluate(c)) /\ WF_vars(Retry(c)) /\ WF_vars(Exec(c))
    /\ \A r \in Runs : WF_vars(StepEnd(r)) /\ WF_vars(Claim(r))
    /\ \A j \in Jobs : WF_vars(JobEnd(j))
    /\ WF_vars(SwitchBegin)
    /\ WF_vars(Close)

Spec == Init /\ [][Next]_vars /\ Fairness

NoAbortRunning == ~abortedRun

NoKilledJob == \A j \in Jobs : job[j] # "killed"

ClosingOnlyWhenQuiet == phase = "closing" => Quiet

ClientsInformed ==
    \A c \in Clients :
        /\ cs[c] = "waiting" => msg[c] = "pending"
        /\ cs[c] = "refused" => msg[c] \in {"reopen", "handoverFailed"}
        /\ cs[c] = "left" => msg[c] = "stillRunning"
        /\ cs[c] = "handing" => msg[c] = "moving"

HandoffRecordMatches == \A c \in Clients : cs[c] = "handing" => rec[c] = draft[c]

PendingAddsNoWork == [][(phase = "pending" /\ phase' = "pending") => Work' <= Work]_vars

DraftKept == [][\A c \in Clients : (cs[c] = "handing" /\ cs'[c] = "starting") => draft'[c] = draft[c]]_vars

HandoverKeepsWork == [][(\E c \in Clients : cs[c] = "handing" /\ cs'[c] # "handing") => (run' = run /\ job' = job)]_vars

PendingEnds == (phase = "pending") ~> (phase \in {"down", "serving"})

WaitingEnds == \A c \in Clients : (cs[c] = "waiting") ~> (cs[c] # "waiting")

SessionMoves ==
    \A c \in Sessions :
        (cs[c] = "starting" /\ cv[c] < dv) ~> (cv[c] >= dv \/ msg[c] = "handoverFailed")

=============================================================================
