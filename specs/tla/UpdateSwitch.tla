---------------------------- MODULE UpdateSwitch ----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Runs, Jobs, Clients, Sessions, MaxV, MaxGen, MaxSteps, MaxStarts, MaxExecFails, MaxModals, Variant

ASSUME Variant \in {"decided", "today", "pausePending", "defer", "claimRetiring", "killJobs", "noNotice", "noRecord", "refuseOld"}
ASSUME MaxV \in Nat \ {0, 1}
ASSUME MaxGen \in Nat \ {0}
ASSUME MaxSteps \in Nat \ {0}
ASSUME MaxStarts \in Nat \ {0}
ASSUME MaxExecFails \in Nat
ASSUME MaxModals \in Nat
ASSUME Sessions \subseteq Clients

Gens == 1..MaxGen
GenStates == {"none", "serving", "retiring", "draining", "gone"}
RunStates == {"none", "queued", "stepping", "done"}
JobStates == {"none", "live", "ended", "killed"}
ClientStates == {"none", "starting", "waiting", "connected", "handing", "refused", "left"}
Messages == {"none", "pending", "connected", "reopen", "stillRunning", "reconnecting", "moving", "handoverFailed", "retiring"}

VARIABLES iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, cs, cv, conn, msg, starts, abortedRun, draft, rec, execFails, modal, modals

vars == <<iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, cs, cv, conn, msg, starts, abortedRun, draft, rec, execFails, modal, modals>>

Serving == {g \in Gens : gstate[g] = "serving"}

Alive == {g \in Gens : gstate[g] \in {"serving", "retiring", "draining"}}

Cur == CHOOSE g \in Serving : TRUE

StepsAt(g) == {r \in Runs : run[r] = "stepping" /\ at[r] = g}

JobsAt(g) == {j \in Jobs : job[j] = "live" /\ jat[j] = g}

Empty(g) == StepsAt(g) = {} /\ JobsAt(g) = {}

Stepping == {r \in Runs : run[r] = "stepping"}

TypeOK ==
    /\ iv \in 1..MaxV
    /\ gstate \in [Gens -> GenStates]
    /\ ver \in [Gens -> 0..MaxV]
    /\ nextGen \in 1..(MaxGen + 1)
    /\ run \in [Runs -> RunStates]
    /\ stepsLeft \in [Runs -> 0..MaxSteps]
    /\ at \in [Runs -> 0..MaxGen]
    /\ job \in [Jobs -> JobStates]
    /\ jat \in [Jobs -> 0..MaxGen]
    /\ cs \in [Clients -> ClientStates]
    /\ cv \in [Clients -> 0..MaxV]
    /\ conn \in [Clients -> 0..MaxGen]
    /\ msg \in [Clients -> Messages]
    /\ starts \in 0..MaxStarts
    /\ abortedRun \in BOOLEAN
    /\ draft \in [Clients -> 0..1]
    /\ rec \in [Clients -> 0..1]
    /\ execFails \in 0..MaxExecFails
    /\ modal \in [Clients -> BOOLEAN]
    /\ modals \in 0..MaxModals

NoticeFor(text) == IF Variant = "noNotice" THEN "none" ELSE text

Init ==
    /\ iv = 1
    /\ gstate = [g \in Gens |-> "none"]
    /\ ver = [g \in Gens |-> 0]
    /\ nextGen = 1
    /\ run = [r \in Runs |-> "none"]
    /\ stepsLeft = [r \in Runs |-> 0]
    /\ at = [r \in Runs |-> 0]
    /\ job = [j \in Jobs |-> "none"]
    /\ jat = [j \in Jobs |-> 0]
    /\ cs = [c \in Clients |-> "none"]
    /\ cv = [c \in Clients |-> 0]
    /\ conn = [c \in Clients |-> 0]
    /\ msg = [c \in Clients |-> "none"]
    /\ starts = 0
    /\ abortedRun = FALSE
    /\ draft = [c \in Clients |-> 0]
    /\ rec = [c \in Clients |-> 0]
    /\ execFails = 0
    /\ modal = [c \in Clients |-> FALSE]
    /\ modals = 0

Install(c) ==
    /\ cs[c] = "none"
    /\ iv < MaxV
    /\ starts < MaxStarts
    /\ iv' = iv + 1
    /\ cs' = [cs EXCEPT ![c] = "starting"]
    /\ cv' = [cv EXCEPT ![c] = iv + 1]
    /\ msg' = [msg EXCEPT ![c] = "none"]
    /\ starts' = starts + 1
    /\ UNCHANGED <<gstate, ver, nextGen, run, stepsLeft, at, job, jat, conn, abortedRun, draft, rec, execFails, modal, modals>>

StartClient(c, v) ==
    /\ cs[c] = "none"
    /\ starts < MaxStarts
    /\ v \in 1..iv
    /\ cs' = [cs EXCEPT ![c] = "starting"]
    /\ cv' = [cv EXCEPT ![c] = v]
    /\ msg' = [msg EXCEPT ![c] = "none"]
    /\ starts' = starts + 1
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, conn, abortedRun, draft, rec, execFails, modal, modals>>

StartFirst(c) ==
    /\ cs[c] = "starting"
    /\ Alive = {}
    /\ nextGen <= MaxGen
    /\ gstate' = [gstate EXCEPT ![nextGen] = "serving"]
    /\ ver' = [ver EXCEPT ![nextGen] = iv]
    /\ nextGen' = nextGen + 1
    /\ UNCHANGED <<iv, run, stepsLeft, at, job, jat, cs, cv, conn, msg, starts, abortedRun, draft, rec, execFails, modal, modals>>

Promote(c, text) ==
    /\ nextGen <= MaxGen
    /\ gstate' = [g \in Gens |-> IF g = nextGen THEN "serving" ELSE IF g = Cur THEN "retiring" ELSE gstate[g]]
    /\ ver' = [ver EXCEPT ![nextGen] = iv]
    /\ nextGen' = nextGen + 1
    /\ msg' = [msg EXCEPT ![c] = NoticeFor(text)]
    /\ UNCHANGED <<iv, run, stepsLeft, at, job, jat, cs, cv, conn, starts, abortedRun, draft, rec, execFails, modal, modals>>

BeginDrain(c) ==
    /\ gstate' = [gstate EXCEPT ![Cur] = "draining"]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("pending")]
    /\ UNCHANGED <<iv, ver, nextGen, run, stepsLeft, at, job, jat, cs, cv, conn, starts, abortedRun, draft, rec, execFails, modal, modals>>

Connect(c) ==
    /\ cs' = [cs EXCEPT ![c] = "connected"]
    /\ conn' = [conn EXCEPT ![c] = Cur]
    /\ msg' = [msg EXCEPT ![c] = "connected"]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, cv, starts, abortedRun, draft, rec, execFails, modal, modals>>

Wait(c) ==
    /\ cs' = [cs EXCEPT ![c] = "waiting"]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("pending")]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, cv, conn, starts, abortedRun, draft, rec, execFails, modal, modals>>

Move(c) ==
    /\ c \in Sessions
    /\ Variant # "refuseOld"
    /\ cs' = [cs EXCEPT ![c] = "handing"]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("moving")]
    /\ rec' = [rec EXCEPT ![c] = IF Variant = "noRecord" THEN 0 ELSE draft[c]]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, cv, conn, starts, abortedRun, draft, execFails, modal, modals>>

Refuse(c) ==
    /\ \/ c \notin Sessions
       \/ Variant = "refuseOld"
    /\ cs' = [cs EXCEPT ![c] = "refused"]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("reopen")]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, cv, conn, starts, abortedRun, draft, rec, execFails, modal, modals>>

Evaluate(c) ==
    /\ cs[c] = "starting"
    /\ Serving # {}
    /\ \/ cv[c] = ver[Cur] /\ Connect(c)
       \/ cv[c] < ver[Cur] /\ (Move(c) \/ Refuse(c))
       \/ /\ cv[c] > ver[Cur]
          /\ \/ /\ Variant \in {"decided", "claimRetiring", "killJobs", "noNotice", "noRecord", "refuseOld"}
                /\ Promote(c, "retiring")
             \/ /\ Variant \in {"today", "pausePending"}
                /\ BeginDrain(c)
             \/ /\ Variant = "defer"
                /\ IF Empty(Cur) THEN Promote(c, "retiring") ELSE Wait(c)

Notified(c) ==
    /\ c \in Sessions
    /\ Variant # "refuseOld"
    /\ cs[c] = "connected"
    /\ ~modal[c]
    /\ Serving # {}
    /\ ver[Cur] > cv[c]
    /\ Move(c)

OpenModal(c) ==
    /\ c \in Sessions
    /\ cs[c] = "connected"
    /\ ~modal[c]
    /\ modals < MaxModals
    /\ modal' = [modal EXCEPT ![c] = TRUE]
    /\ modals' = modals + 1
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, cs, cv, conn, msg, starts, abortedRun, draft, rec, execFails>>

CloseModal(c) ==
    /\ modal[c]
    /\ modal' = [modal EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, cs, cv, conn, msg, starts, abortedRun, draft, rec, execFails, modals>>

Exec(c) ==
    /\ cs[c] = "handing"
    /\ cs' = [cs EXCEPT ![c] = "starting"]
    /\ cv' = [cv EXCEPT ![c] = iv]
    /\ conn' = [conn EXCEPT ![c] = 0]
    /\ msg' = [msg EXCEPT ![c] = "none"]
    /\ draft' = [draft EXCEPT ![c] = rec[c]]
    /\ rec' = [rec EXCEPT ![c] = 0]
    /\ modal' = [modal EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, starts, abortedRun, execFails, modals>>

ExecFail(c) ==
    /\ cs[c] = "handing"
    /\ execFails < MaxExecFails
    /\ execFails' = execFails + 1
    /\ cs' = [cs EXCEPT ![c] = "refused"]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("handoverFailed")]
    /\ rec' = [rec EXCEPT ![c] = 0]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, cv, conn, starts, abortedRun, draft, modal, modals>>

Retry(c) ==
    /\ cs[c] = "waiting"
    /\ Serving # {}
    /\ cs' = [cs EXCEPT ![c] = "starting"]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, cv, conn, msg, starts, abortedRun, draft, rec, execFails, modal, modals>>

Leave(c) ==
    /\ cs[c] = "waiting"
    /\ cs' = [cs EXCEPT ![c] = "left"]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("stillRunning")]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, cv, conn, starts, abortedRun, draft, rec, execFails, modal, modals>>

Finish(c) ==
    /\ cs[c] \in {"connected", "refused", "left"}
    /\ cs' = [cs EXCEPT ![c] = "none"]
    /\ cv' = [cv EXCEPT ![c] = 0]
    /\ conn' = [conn EXCEPT ![c] = 0]
    /\ msg' = [msg EXCEPT ![c] = "none"]
    /\ draft' = [draft EXCEPT ![c] = 0]
    /\ modal' = [modal EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, starts, abortedRun, rec, execFails, modals>>

Type(c) ==
    /\ c \in Sessions
    /\ cs[c] \in {"connected", "starting", "waiting"}
    /\ draft[c] = 0
    /\ draft' = [draft EXCEPT ![c] = 1]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, cs, cv, conn, msg, starts, abortedRun, rec, execFails, modal, modals>>

Send(c) ==
    /\ c \in Sessions
    /\ cs[c] = "connected"
    /\ draft[c] = 1
    /\ draft' = [draft EXCEPT ![c] = 0]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, job, jat, cs, cv, conn, msg, starts, abortedRun, rec, execFails, modal, modals>>

Submit(r) ==
    /\ run[r] = "none"
    /\ \E c \in Clients : cs[c] = "connected"
    /\ run' = [run EXCEPT ![r] = "queued"]
    /\ \E n \in 1..MaxSteps : stepsLeft' = [stepsLeft EXCEPT ![r] = n]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, at, job, jat, cs, cv, conn, msg, starts, abortedRun, draft, rec, execFails, modal, modals>>

Claimers == IF Variant = "claimRetiring" THEN {g \in Gens : gstate[g] \in {"serving", "retiring"}} ELSE Serving

Claim(r, g) ==
    /\ run[r] = "queued"
    /\ g \in Claimers
    /\ run' = [run EXCEPT ![r] = "stepping"]
    /\ at' = [at EXCEPT ![r] = g]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, stepsLeft, job, jat, cs, cv, conn, msg, starts, abortedRun, draft, rec, execFails, modal, modals>>

StepEnd(r) ==
    /\ run[r] = "stepping"
    /\ stepsLeft' = [stepsLeft EXCEPT ![r] = stepsLeft[r] - 1]
    /\ run' = [run EXCEPT ![r] = IF stepsLeft[r] = 1 THEN "done" ELSE "queued"]
    /\ at' = [at EXCEPT ![r] = 0]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, job, jat, cs, cv, conn, msg, starts, abortedRun, draft, rec, execFails, modal, modals>>

JobStart(j, r) ==
    /\ job[j] = "none"
    /\ run[r] = "stepping"
    /\ at[r] \in Claimers
    /\ job' = [job EXCEPT ![j] = "live"]
    /\ jat' = [jat EXCEPT ![j] = at[r]]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, cs, cv, conn, msg, starts, abortedRun, draft, rec, execFails, modal, modals>>

JobEnd(j) ==
    /\ job[j] = "live"
    /\ job' = [job EXCEPT ![j] = "ended"]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, run, stepsLeft, at, jat, cs, cv, conn, msg, starts, abortedRun, draft, rec, execFails, modal, modals>>

Expire(g) ==
    /\ Variant = "today"
    /\ gstate[g] = "draining"
    /\ StepsAt(g) # {}
    /\ abortedRun' = TRUE
    /\ run' = [r \in Runs |-> IF run[r] = "stepping" /\ at[r] = g THEN "queued" ELSE run[r]]
    /\ at' = [r \in Runs |-> IF run[r] = "stepping" /\ at[r] = g THEN 0 ELSE at[r]]
    /\ UNCHANGED <<iv, gstate, ver, nextGen, stepsLeft, job, jat, cs, cv, conn, msg, starts, draft, rec, execFails, modal, modals>>

Holds(g) == IF Variant \in {"today", "killJobs"} THEN StepsAt(g) = {} ELSE Empty(g)

Retire(g) ==
    /\ gstate[g] \in {"retiring", "draining"}
    /\ Holds(g)
    /\ gstate' = [gstate EXCEPT ![g] = "gone"]
    /\ job' = [j \in Jobs |-> IF job[j] = "live" /\ jat[j] = g THEN "killed" ELSE job[j]]
    /\ cs' = [c \in Clients |-> IF cs[c] = "connected" /\ conn[c] = g THEN "starting" ELSE cs[c]]
    /\ conn' = [c \in Clients |-> IF conn[c] = g THEN 0 ELSE conn[c]]
    /\ msg' = [c \in Clients |-> IF cs[c] = "connected" /\ conn[c] = g THEN NoticeFor("reconnecting") ELSE msg[c]]
    /\ UNCHANGED <<iv, ver, nextGen, run, stepsLeft, at, jat, cv, starts, abortedRun, draft, rec, execFails, modal, modals>>

Next ==
    \/ \E c \in Clients : Install(c) \/ StartFirst(c) \/ Evaluate(c) \/ Notified(c) \/ OpenModal(c) \/ CloseModal(c) \/ Exec(c) \/ ExecFail(c) \/ Retry(c) \/ Leave(c) \/ Finish(c) \/ Type(c) \/ Send(c)
    \/ \E c \in Clients, v \in 1..MaxV : StartClient(c, v)
    \/ \E r \in Runs : Submit(r) \/ StepEnd(r) \/ \E g \in Gens : Claim(r, g)
    \/ \E j \in Jobs, r \in Runs : JobStart(j, r)
    \/ \E j \in Jobs : JobEnd(j)
    \/ \E g \in Gens : Expire(g) \/ Retire(g)

Fairness ==
    /\ \A c \in Clients : WF_vars(StartFirst(c)) /\ WF_vars(Evaluate(c)) /\ WF_vars(Retry(c)) /\ WF_vars(Exec(c)) /\ WF_vars(Notified(c)) /\ WF_vars(CloseModal(c))
    /\ \A r \in Runs : WF_vars(StepEnd(r)) /\ \A g \in Gens : WF_vars(Claim(r, g))
    /\ \A j \in Jobs : WF_vars(JobEnd(j))
    /\ \A g \in Gens : WF_vars(Retire(g))

Spec == Init /\ [][Next]_vars /\ Fairness

NoAbortRunning == ~abortedRun

NoKilledJob == \A j \in Jobs : job[j] # "killed"

WorkNeverPaused == Alive # {} => Serving # {}

OneServing == Cardinality(Serving) <= 1

SteppingNeverOrphaned == \A r \in Runs : run[r] = "stepping" => gstate[at[r]] \in {"serving", "retiring", "draining"}

NewerClientNeverWaits == \A c \in Clients : cs[c] # "waiting"

ClientsInformed ==
    \A c \in Clients :
        /\ cs[c] = "waiting" => msg[c] = "pending"
        /\ cs[c] = "refused" => msg[c] \in {"reopen", "handoverFailed"}
        /\ cs[c] = "left" => msg[c] = "stillRunning"
        /\ cs[c] = "handing" => msg[c] = "moving"

HandoffRecordMatches == \A c \in Clients : cs[c] = "handing" => rec[c] = draft[c]

RetiringAddsNoWork ==
    [][\A g \in Gens : gstate[g] = "retiring" => Cardinality(StepsAt(g)') + Cardinality(JobsAt(g)') <= Cardinality(StepsAt(g)) + Cardinality(JobsAt(g))]_vars

DraftKept == [][\A c \in Clients : (cs[c] = "handing" /\ cs'[c] = "starting") => draft'[c] = draft[c]]_vars

HandoverKeepsWork == [][(\E c \in Clients : cs[c] = "handing" /\ cs'[c] # "handing") => (run' = run /\ job' = job /\ at' = at)]_vars

RetiringEnds == \A g \in Gens : (gstate[g] = "retiring") ~> (gstate[g] = "gone")

SessionMoves ==
    \A c \in Sessions :
        (cs[c] \in {"connected", "starting"} /\ Serving # {} /\ cv[c] < ver[Cur])
            ~> (cs[c] = "none" \/ msg[c] = "handoverFailed" \/ Serving = {} \/ cv[c] >= ver[Cur])

=============================================================================
