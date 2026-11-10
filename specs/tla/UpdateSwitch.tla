---------------------------- MODULE UpdateSwitch ----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Runs, Jobs, Clients, Sessions, Lifeline, MaxV, MaxGen, MaxSteps, MaxStarts, MaxExecFails, MaxModals, MaxCrash, MaxOut, MaxCalls, Extended, Gateway, Upkeep, Variant

ASSUME Variant \in {"decided", "today", "pausePending", "defer", "claimRetiring", "killJobs", "noNotice", "noRecord", "refuseOld", "noReqWait", "pinPath", "scanAlloc", "noJoin", "releaseEarly", "failSetsNone", "publishNoCheck", "staleStarter", "claimUnchecked", "killWithoutRequest", "readOwnGenOnly", "reconcileLive", "jobRetiring", "sweepRetiring", "pruneAll", "gwAcceptsWhileRetiring", "gwExitEarly", "gwGraceAbort", "gwSilentRefuse", "killDropped", "gwRefuseNoYield", "userStopNeverEnds", "noReconcile", "noTakeover"}
ASSUME MaxV \in Nat \ {0, 1}
ASSUME MaxGen \in Nat \ {0}
ASSUME MaxSteps \in Nat \ {0}
ASSUME MaxStarts \in Nat \ {0}
ASSUME MaxExecFails \in Nat
ASSUME MaxModals \in Nat
ASSUME MaxCrash \in Nat
ASSUME MaxOut \in Nat \ {0}
ASSUME MaxCalls \in Nat \ {0}
ASSUME Extended \in BOOLEAN
ASSUME Gateway \in BOOLEAN
ASSUME Gateway => Extended
ASSUME Upkeep \in BOOLEAN
ASSUME Upkeep => Extended
ASSUME Sessions \subseteq Clients
ASSUME Lifeline \subseteq Clients

Gens == 1..MaxGen
G0 == 0..MaxGen
Vers == 0..MaxV
GenStates == {"none", "serving", "retiring", "draining", "gone"}
RunStates == {"none", "queued", "stepping", "done", "failed"}
JobStates == {"none", "live", "ended", "killed"}
ClientStates == {"none", "starting", "waiting", "connected", "handing", "refused", "left"}
RequestStates == {"none", "open", "done", "cut"}
Messages == {"none", "pending", "connected", "reopen", "stillRunning", "reconnecting", "moving", "handoverFailed", "startFailed", "pathTooLong"}

VARIABLES iv, nextGen, stopped, crashes, faulted, dir, ver, sup, stl, prom, dr, claimed, know, cur, curv, run, stepsLeft, at, job, jat, cs, cv, conn, msg, pend, starts, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin, kreq, out, gw, gwOpen, gwProbe, gwUnanswered, swept, pb

gvars == <<dir, ver, sup, stl, prom, dr, claimed, know>>
cvars == <<cur, curv>>
rvars == <<run, stepsLeft, at, job, jat>>
tvars == <<iv, nextGen, stopped, crashes, faulted>>
kvars == <<cs, cv, conn, msg, pend, starts, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>
jvars == <<kreq, out>>
gwv == <<gw, gwOpen, gwProbe, gwUnanswered>>
xvars == <<swept, pb>>
vars == <<tvars, gvars, cvars, rvars, kvars, jvars, gwv, xvars>>

Live == {g \in Gens : sup[g]}
Srv == sup[cur] /\ ~dr[cur]
Retiring(g) == prom[g] /\ sup[g] /\ cur # g
StepsAt(g) == {r \in Runs : run[r] = "stepping" /\ at[r] = g}
JobsAt(g) == {j \in Jobs : job[j] = "live" /\ jat[j] = g}

Holder(g) ==
    IF stl[g] \in Clients
    THEN Variant # "releaseEarly" /\ cs[stl[g]] = "starting" /\ pend[stl[g]] = g
    ELSE IF stl[g] \in Gens THEN sup[stl[g]] ELSE FALSE

Starting == {g \in Gens : dir[g] /\ ~prom[g] /\ ~dr[g] /\ ~(cur > g) /\ (sup[g] \/ Holder(g))}

Holds(g) == IF Variant \in {"today", "killJobs"} THEN StepsAt(g) = {} ELSE (StepsAt(g) = {} /\ JobsAt(g) = {})
ReqHolds(g) == Variant = "noReqWait" \/ ~(\E c \in Clients : rq[c] = "open" /\ rqg[c] = g)

StopWanted(g) == (prom[g] /\ cur # g) \/ dr[g] \/ (~prom[g] /\ cur > g)

Target(c) == IF Variant = "pinPath" /\ pin[c] # 0 THEN pin[c] ELSE cur

Claimers ==
    IF Variant = "claimRetiring"
    THEN {g \in Gens : prom[g] /\ sup[g] /\ ~dr[g]}
    ELSE (IF Srv THEN {cur} ELSE {}) \cup {g \in Gens : Retiring(g) /\ ~know[g] /\ ~dr[g]}

NoticeFor(text) == IF Variant = "noNotice" THEN "none" ELSE text

JoinOK(c) == Variant # "noJoin" /\ \E g \in Starting : ver[g] >= cv[c]

AllocNo == IF Variant = "scanAlloc" THEN (IF \E g \in Gens : dir[g] THEN (CHOOSE g \in Gens : dir[g] /\ \A h \in Gens : dir[h] => h <= g) + 1 ELSE 1) ELSE nextGen

AllocVariantOK ==
    IF Variant \in {"today", "pausePending"} THEN ~Srv
    ELSE IF Variant = "defer" THEN (~Srv \/ Holds(cur))
    ELSE TRUE

SettledClient(c) == Srv /\ cv[c] = curv

TypeOK ==
    /\ iv \in 1..MaxV
    /\ nextGen \in 1..(MaxGen + MaxStarts + 2)
    /\ stopped \in BOOLEAN
    /\ crashes \in 0..MaxCrash
    /\ faulted \in BOOLEAN
    /\ dir \in [G0 -> BOOLEAN]
    /\ ver \in [G0 -> Vers]
    /\ sup \in [G0 -> BOOLEAN]
    /\ stl \in [G0 -> (Clients \cup G0)]
    /\ prom \in [G0 -> BOOLEAN]
    /\ dr \in [G0 -> BOOLEAN]
    /\ claimed \in [G0 -> BOOLEAN]
    /\ know \in [G0 -> BOOLEAN]
    /\ cur \in G0
    /\ curv \in Vers
    /\ run \in [Runs -> RunStates]
    /\ stepsLeft \in [Runs -> 0..MaxSteps]
    /\ at \in [Runs -> G0]
    /\ job \in [Jobs -> JobStates]
    /\ jat \in [Jobs -> G0]
    /\ cs \in [Clients -> ClientStates]
    /\ cv \in [Clients -> Vers]
    /\ conn \in [Clients -> G0]
    /\ msg \in [Clients -> Messages]
    /\ pend \in [Clients -> G0]
    /\ starts \in 0..MaxStarts
    /\ abortedRun \in BOOLEAN
    /\ draft \in [Clients -> 0..1]
    /\ rec \in [Clients -> 0..1]
    /\ execFails \in 0..MaxExecFails
    /\ modal \in [Clients -> BOOLEAN]
    /\ modals \in 0..MaxModals
    /\ rq \in [Clients -> RequestStates]
    /\ rqg \in [Clients -> G0]
    /\ pin \in [Clients -> G0]
    /\ kreq \in [Jobs -> BOOLEAN]
    /\ out \in [Jobs -> 0..MaxOut]
    /\ gw \in [G0 -> {"none", "serving", "retiring", "gone"}]
    /\ gwOpen \in [G0 -> 0..MaxCalls]
    /\ gwProbe \in [G0 -> 0..1]
    /\ gwUnanswered \in 0..(MaxCalls * MaxGen)
    /\ swept \in {"none", "serving", "retiring"}
    /\ pb \in 0..(MaxV + 1)

Init ==
    /\ iv = 1
    /\ nextGen = 1
    /\ stopped = FALSE
    /\ crashes = 0
    /\ faulted = FALSE
    /\ dir = [g \in G0 |-> FALSE]
    /\ ver = [g \in G0 |-> 0]
    /\ sup = [g \in G0 |-> FALSE]
    /\ stl = [g \in G0 |-> 0]
    /\ prom = [g \in G0 |-> FALSE]
    /\ dr = [g \in G0 |-> FALSE]
    /\ claimed = [g \in G0 |-> FALSE]
    /\ know = [g \in G0 |-> FALSE]
    /\ cur = 0
    /\ curv = 0
    /\ run = [r \in Runs |-> "none"]
    /\ stepsLeft = [r \in Runs |-> 0]
    /\ at = [r \in Runs |-> 0]
    /\ job = [j \in Jobs |-> "none"]
    /\ jat = [j \in Jobs |-> 0]
    /\ cs = [c \in Clients |-> "none"]
    /\ cv = [c \in Clients |-> 0]
    /\ conn = [c \in Clients |-> 0]
    /\ msg = [c \in Clients |-> "none"]
    /\ pend = [c \in Clients |-> 0]
    /\ starts = 0
    /\ abortedRun = FALSE
    /\ draft = [c \in Clients |-> 0]
    /\ rec = [c \in Clients |-> 0]
    /\ execFails = 0
    /\ modal = [c \in Clients |-> FALSE]
    /\ modals = 0
    /\ rq = [c \in Clients |-> "none"]
    /\ rqg = [c \in Clients |-> 0]
    /\ pin = [c \in Clients |-> 0]
    /\ kreq = [j \in Jobs |-> FALSE]
    /\ out = [j \in Jobs |-> 0]
    /\ gw = [g \in G0 |-> "none"]
    /\ gwOpen = [g \in G0 |-> 0]
    /\ gwProbe = [g \in G0 |-> 0]
    /\ gwUnanswered = 0
    /\ swept = "none"
    /\ pb = 0

Install(c) ==
    /\ cs[c] = "none"
    /\ iv < MaxV
    /\ starts < MaxStarts
    /\ iv' = iv + 1
    /\ cs' = [cs EXCEPT ![c] = "starting"]
    /\ cv' = [cv EXCEPT ![c] = iv + 1]
    /\ msg' = [msg EXCEPT ![c] = "none"]
    /\ pend' = [pend EXCEPT ![c] = 0]
    /\ starts' = starts + 1
    /\ pin' = [pin EXCEPT ![c] = 0]
    /\ UNCHANGED <<jvars, gwv, xvars, nextGen, stopped, crashes, faulted, gvars, cvars, rvars, conn, abortedRun, draft, rec, execFails, modal, modals, rq, rqg>>

StartClient(c, v) ==
    /\ cs[c] = "none"
    /\ starts < MaxStarts
    /\ v \in 1..iv
    /\ cs' = [cs EXCEPT ![c] = "starting"]
    /\ cv' = [cv EXCEPT ![c] = v]
    /\ msg' = [msg EXCEPT ![c] = "none"]
    /\ pend' = [pend EXCEPT ![c] = 0]
    /\ starts' = starts + 1
    /\ pin' = [pin EXCEPT ![c] = 0]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, conn, abortedRun, draft, rec, execFails, modal, modals, rq, rqg>>

ConnectNow(c) ==
    /\ cs[c] = "starting"
    /\ pend[c] = 0
    /\ SettledClient(c)
    /\ cs' = [cs EXCEPT ![c] = "connected"]
    /\ conn' = [conn EXCEPT ![c] = cur]
    /\ msg' = [msg EXCEPT ![c] = "connected"]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cv, starts, pend, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>

MoveNow(c) ==
    /\ c \in Sessions
    /\ Variant # "refuseOld"
    /\ cs[c] = "starting"
    /\ pend[c] = 0
    /\ Srv
    /\ cv[c] < curv
    /\ cs' = [cs EXCEPT ![c] = "handing"]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("moving")]
    /\ rec' = [rec EXCEPT ![c] = IF Variant = "noRecord" THEN 0 ELSE draft[c]]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cv, conn, starts, pend, abortedRun, draft, execFails, modal, modals, rq, rqg, pin>>

RefuseOlder(c) ==
    /\ \/ c \notin Sessions
       \/ Variant = "refuseOld"
    /\ cs[c] = "starting"
    /\ pend[c] = 0
    /\ Srv
    /\ cv[c] < curv
    /\ cs' = [cs EXCEPT ![c] = "refused"]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("reopen")]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cv, conn, starts, pend, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>

FloorNow(c) ==
    /\ cs[c] = "starting"
    /\ pend[c] = 0
    /\ ~Srv
    /\ cv[c] < curv
    /\ cs' = [cs EXCEPT ![c] = "refused"]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("reopen")]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cv, conn, starts, pend, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>

JoinNow(c) ==
    /\ cs[c] = "starting"
    /\ pend[c] = 0
    /\ cv[c] >= curv
    /\ ~SettledClient(c)
    /\ \E g \in Starting : ver[g] >= cv[c] /\ JoinOK(c) /\ pend' = [pend EXCEPT ![c] = g]
    /\ msg' = [msg EXCEPT ![c] = "pending"]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cs, cv, conn, starts, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>

AllocNow(c) ==
    /\ cs[c] = "starting"
    /\ pend[c] = 0
    /\ cv[c] >= curv
    /\ ~SettledClient(c)
    /\ ~JoinOK(c)
    /\ AllocVariantOK
    /\ AllocNo <= MaxGen
    /\ nextGen' = nextGen + 1
    /\ dir' = [dir EXCEPT ![AllocNo] = TRUE]
    /\ ver' = [ver EXCEPT ![AllocNo] = cv[c]]
    /\ stl' = [stl EXCEPT ![AllocNo] = c]
    /\ pend' = [pend EXCEPT ![c] = AllocNo]
    /\ msg' = [msg EXCEPT ![c] = "pending"]
    /\ UNCHANGED <<jvars, gwv, xvars, iv, stopped, crashes, faulted, sup, prom, dr, claimed, know, cvars, rvars, cs, cv, conn, starts, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>

PathFullNow(c) ==
    /\ cs[c] = "starting"
    /\ pend[c] = 0
    /\ cv[c] >= curv
    /\ ~SettledClient(c)
    /\ ~JoinOK(c)
    /\ AllocVariantOK
    /\ AllocNo > MaxGen
    /\ cs' = [cs EXCEPT ![c] = "refused"]
    /\ msg' = [msg EXCEPT ![c] = "pathTooLong"]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cv, conn, starts, pend, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>

WaitNow(c) ==
    /\ Variant = "defer"
    /\ cs[c] = "starting"
    /\ pend[c] = 0
    /\ Srv
    /\ cv[c] > curv
    /\ ~Holds(cur)
    /\ cs' = [cs EXCEPT ![c] = "waiting"]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("pending")]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cv, conn, starts, pend, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>

DrainNow(c) ==
    /\ Variant \in {"today", "pausePending"}
    /\ cs[c] = "starting"
    /\ pend[c] = 0
    /\ Srv
    /\ cv[c] > curv
    /\ dr' = [dr EXCEPT ![cur] = TRUE]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("pending")]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, dir, ver, sup, stl, prom, claimed, know, cvars, rvars, cs, cv, conn, starts, pend, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>

Retry(c) ==
    /\ cs[c] = "waiting"
    /\ Srv
    /\ cs' = [cs EXCEPT ![c] = "starting"]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cv, conn, msg, pend, starts, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>

Leave(c) ==
    /\ cs[c] = "waiting"
    /\ cs' = [cs EXCEPT ![c] = "left"]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("stillRunning")]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cv, conn, pend, starts, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>

ConnectStarter(c) ==
    /\ cs[c] = "starting"
    /\ pend[c] # 0
    /\ cur # 0
    /\ cur >= pend[c]
    /\ cv[c] <= curv
    /\ (Srv \/ Variant = "staleStarter")
    /\ cs' = [cs EXCEPT ![c] = "connected"]
    /\ conn' = [conn EXCEPT ![c] = cur]
    /\ msg' = [msg EXCEPT ![c] = "connected"]
    /\ pend' = [pend EXCEPT ![c] = 0]
    /\ stl' = [g \in G0 |-> IF g = pend[c] /\ stl[g] = c THEN 0 ELSE stl[g]]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, dir, ver, sup, prom, dr, claimed, know, cvars, rvars, cv, starts, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>

FailStarter(c) ==
    /\ cs[c] = "starting"
    /\ pend[c] # 0
    /\ ~Holder(pend[c])
    /\ ~sup[pend[c]]
    /\ ~(Srv /\ cur >= pend[c] /\ cv[c] <= curv)
    /\ cs' = [cs EXCEPT ![c] = "refused"]
    /\ msg' = [msg EXCEPT ![c] = "startFailed"]
    /\ pend' = [pend EXCEPT ![c] = 0]
    /\ stl' = [g \in G0 |-> IF g = pend[c] /\ stl[g] = c THEN 0 ELSE stl[g]]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, dir, ver, sup, prom, dr, claimed, know, cvars, rvars, cv, conn, starts, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>

GiveUp(c) ==
    /\ cs[c] = "starting"
    /\ pend[c] # 0
    /\ cs' = [cs EXCEPT ![c] = "refused"]
    /\ msg' = [msg EXCEPT ![c] = "startFailed"]
    /\ pend' = [pend EXCEPT ![c] = 0]
    /\ stl' = [g \in G0 |-> IF g = pend[c] /\ stl[g] = c THEN 0 ELSE stl[g]]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, dir, ver, sup, prom, dr, claimed, know, cvars, rvars, cv, conn, starts, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>

StarterCrash(c) ==
    /\ crashes < MaxCrash
    /\ cs[c] = "starting"
    /\ rq[c] # "open"
    /\ crashes' = crashes + 1
    /\ faulted' = (faulted \/ (pend[c] # 0 /\ c \in Lifeline /\ stl[pend[c]] = c /\ sup[pend[c]]))
    /\ sup' = IF pend[c] # 0 /\ c \in Lifeline /\ stl[pend[c]] = c THEN [sup EXCEPT ![pend[c]] = FALSE] ELSE sup
    /\ stl' = [g \in G0 |-> IF stl[g] = c THEN 0 ELSE stl[g]]
    /\ cs' = [cs EXCEPT ![c] = "none"]
    /\ pend' = [pend EXCEPT ![c] = 0]
    /\ msg' = [msg EXCEPT ![c] = "none"]
    /\ conn' = [conn EXCEPT ![c] = 0]
    /\ UNCHANGED <<jvars, gwv, xvars, iv, nextGen, stopped, dir, ver, prom, dr, claimed, know, cvars, rvars, cv, starts, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>

SupCrash(g) ==
    /\ crashes < MaxCrash
    /\ g \in Gens
    /\ sup[g]
    /\ ~prom[g]
    /\ crashes' = crashes + 1
    /\ faulted' = TRUE
    /\ sup' = [sup EXCEPT ![g] = FALSE]
    /\ stl' = [stl EXCEPT ![g] = IF stl[g] \in Gens THEN 0 ELSE stl[g]]
    /\ cur' = IF Variant = "failSetsNone" THEN 0 ELSE cur
    /\ UNCHANGED <<jvars, gwv, xvars, iv, nextGen, stopped, dir, ver, prom, dr, claimed, know, curv, rvars, kvars>>

SupClaim(g) ==
    /\ g \in Gens
    /\ ~sup[g]
    /\ ~claimed[g]
    /\ (IF Variant = "claimUnchecked" THEN g < nextGen ELSE (dir[g] /\ ver[g] = iv))
    /\ sup' = [sup EXCEPT ![g] = TRUE]
    /\ claimed' = [claimed EXCEPT ![g] = TRUE]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, dir, ver, stl, prom, dr, know, cvars, rvars, kvars>>

Promote(g) ==
    /\ g \in Gens
    /\ sup[g]
    /\ ~dr[g]
    /\ ~prom[g]
    /\ IF Variant = "publishNoCheck" THEN TRUE ELSE g > cur
    /\ cur' = g
    /\ curv' = ver[g]
    /\ prom' = [prom EXCEPT ![g] = TRUE]
    /\ stl' = [stl EXCEPT ![g] = IF stl[g] \in Gens THEN 0 ELSE stl[g]]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, dir, ver, sup, dr, claimed, know, rvars, kvars>>

Notify(g) ==
    /\ g \in Gens
    /\ Retiring(g)
    /\ ~know[g]
    /\ know' = [know EXCEPT ![g] = TRUE]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, dir, ver, sup, stl, prom, dr, claimed, cvars, rvars, kvars>>

Exit(g) ==
    /\ g \in Gens
    /\ sup[g]
    /\ StopWanted(g)
    /\ Holds(g)
    /\ ReqHolds(g)
    /\ gw[g] \in {"none", "gone"} \/ (gw[g] = "retiring" /\ gwOpen[g] = 0 /\ gwProbe[g] = 0)
    /\ sup' = [sup EXCEPT ![g] = FALSE]
    /\ cs' = [c \in Clients |-> IF cs[c] = "connected" /\ conn[c] = g THEN "starting" ELSE cs[c]]
    /\ msg' = [c \in Clients |-> IF cs[c] = "connected" /\ conn[c] = g THEN NoticeFor("reconnecting") ELSE msg[c]]
    /\ conn' = [c \in Clients |-> IF conn[c] = g THEN 0 ELSE conn[c]]
    /\ job' = [j \in Jobs |-> IF job[j] = "live" /\ jat[j] = g THEN "killed" ELSE job[j]]
    /\ rq' = [c \in Clients |-> IF rq[c] = "open" /\ rqg[c] = g THEN "cut" ELSE rq[c]]
    /\ rqg' = [c \in Clients |-> IF rq[c] = "open" /\ rqg[c] = g THEN 0 ELSE rqg[c]]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, dir, ver, stl, prom, dr, claimed, know, cvars, run, stepsLeft, at, jat, cv, pend, starts, abortedRun, draft, rec, execFails, modal, modals, pin>>

Reap(g) ==
    /\ g \in Gens
    /\ dir[g]
    /\ ~sup[g]
    /\ ~Holder(g)
    /\ dir' = [dir EXCEPT ![g] = FALSE]
    /\ ver' = [ver EXCEPT ![g] = 0]
    /\ prom' = [prom EXCEPT ![g] = FALSE]
    /\ dr' = [dr EXCEPT ![g] = FALSE]
    /\ claimed' = [claimed EXCEPT ![g] = FALSE]
    /\ know' = [know EXCEPT ![g] = FALSE]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, sup, stl, cvars, rvars, kvars>>

RestartNow(c) ==
    /\ cs[c] = "starting"
    /\ pend[c] = 0
    /\ Srv
    /\ cv[c] = curv
    /\ AllocVariantOK
    /\ AllocNo <= MaxGen
    /\ nextGen' = nextGen + 1
    /\ dir' = [dir EXCEPT ![AllocNo] = TRUE]
    /\ ver' = [ver EXCEPT ![AllocNo] = curv]
    /\ stl' = [stl EXCEPT ![AllocNo] = c]
    /\ pend' = [pend EXCEPT ![c] = AllocNo]
    /\ msg' = [msg EXCEPT ![c] = "pending"]
    /\ UNCHANGED <<jvars, gwv, xvars, iv, stopped, crashes, faulted, sup, prom, dr, claimed, know, cvars, rvars, cs, cv, conn, starts, abortedRun, draft, rec, execFails, modal, modals, rq, rqg, pin>>

GiveUpPromotion(g) ==
    /\ g \in Gens
    /\ sup[g] /\ ~prom[g] /\ ~dr[g]
    /\ sup' = [sup EXCEPT ![g] = FALSE]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, dir, ver, stl, prom, dr, claimed, know, cvars, rvars, kvars>>

PromotedCrash(g) ==
    /\ crashes < MaxCrash
    /\ g \in Gens
    /\ sup[g]
    /\ prom[g]
    /\ crashes' = crashes + 1
    /\ faulted' = TRUE
    /\ sup' = [sup EXCEPT ![g] = FALSE]
    /\ cs' = [c \in Clients |-> IF cs[c] = "connected" /\ conn[c] = g THEN "starting" ELSE cs[c]]
    /\ msg' = [c \in Clients |-> IF cs[c] = "connected" /\ conn[c] = g THEN NoticeFor("reconnecting") ELSE msg[c]]
    /\ conn' = [c \in Clients |-> IF conn[c] = g THEN 0 ELSE conn[c]]
    /\ rq' = [c \in Clients |-> IF rq[c] = "open" /\ rqg[c] = g THEN "cut" ELSE rq[c]]
    /\ rqg' = [c \in Clients |-> IF rq[c] = "open" /\ rqg[c] = g THEN 0 ELSE rqg[c]]
    /\ gw' = [gw EXCEPT ![g] = IF gw[g] = "none" THEN "none" ELSE "gone"]
    /\ gwOpen' = [gwOpen EXCEPT ![g] = 0]
    /\ gwProbe' = [gwProbe EXCEPT ![g] = 0]
    /\ UNCHANGED <<jvars, xvars, rvars, iv, nextGen, stopped, dir, ver, stl, prom, dr, claimed, know, cvars, cv, pend, starts, abortedRun, draft, rec, execFails, modal, modals, pin, gwUnanswered>>

Takeover(r) ==
    /\ Variant # "noTakeover"
    /\ run[r] = "stepping"
    /\ ~sup[at[r]]
    /\ run' = [run EXCEPT ![r] = "queued"]
    /\ at' = [at EXCEPT ![r] = 0]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, stepsLeft, job, jat, kvars>>

ChildMismatch(g) ==
    /\ g \in Gens
    /\ g = cur
    /\ Srv
    /\ iv > curv
    /\ ~(\E h \in Starting : ver[h] >= iv)
    /\ AllocNo <= MaxGen
    /\ nextGen' = nextGen + 1
    /\ dir' = [dir EXCEPT ![AllocNo] = TRUE]
    /\ ver' = [ver EXCEPT ![AllocNo] = iv]
    /\ stl' = [stl EXCEPT ![AllocNo] = g]
    /\ UNCHANGED <<jvars, gwv, xvars, iv, stopped, crashes, faulted, sup, prom, dr, claimed, know, cvars, rvars, kvars>>

UserStop ==
    /\ ~stopped
    /\ \E g \in Gens : sup[g]
    /\ stopped' = TRUE
    /\ dr' = [g \in G0 |-> dr[g] \/ sup[g]]
    /\ UNCHANGED <<jvars, gwv, xvars, iv, nextGen, crashes, faulted, dir, ver, sup, stl, prom, claimed, know, cvars, rvars, kvars>>

Submit(r) ==
    /\ run[r] = "none"
    /\ \E c \in Clients : cs[c] = "connected"
    /\ run' = [run EXCEPT ![r] = "queued"]
    /\ \E n \in 1..MaxSteps : stepsLeft' = [stepsLeft EXCEPT ![r] = n]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, at, job, jat, kvars>>

Claim(r, g) ==
    /\ run[r] = "queued"
    /\ g \in Claimers
    /\ run' = [run EXCEPT ![r] = "stepping"]
    /\ at' = [at EXCEPT ![r] = g]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, stepsLeft, job, jat, kvars>>

StepEnd(r) ==
    /\ run[r] = "stepping"
    /\ sup[at[r]]
    /\ stepsLeft' = [stepsLeft EXCEPT ![r] = stepsLeft[r] - 1]
    /\ run' = [run EXCEPT ![r] = IF stepsLeft[r] = 1 THEN "done" ELSE "queued"]
    /\ at' = [at EXCEPT ![r] = 0]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, job, jat, kvars>>

JobStart(j, r) ==
    /\ job[j] = "none"
    /\ run[r] = "stepping"
    /\ (at[r] \in Claimers \/ (Variant = "jobRetiring" /\ Retiring(at[r])))
    /\ job' = [job EXCEPT ![j] = "live"]
    /\ jat' = [jat EXCEPT ![j] = at[r]]
    /\ kreq' = [kreq EXCEPT ![j] = FALSE]
    /\ out' = [out EXCEPT ![j] = 0]
    /\ UNCHANGED <<tvars, gvars, cvars, run, stepsLeft, at, kvars, gwv, xvars>>

JobEnd(j) ==
    /\ job[j] = "live"
    /\ sup[jat[j]]
    /\ job' = [job EXCEPT ![j] = "ended"]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, run, stepsLeft, at, jat, kvars>>

Expire(g) ==
    /\ Variant = "today"
    /\ dr[g]
    /\ StepsAt(g) # {}
    /\ abortedRun' = TRUE
    /\ run' = [r \in Runs |-> IF run[r] = "stepping" /\ at[r] = g THEN "queued" ELSE run[r]]
    /\ at' = [r \in Runs |-> IF run[r] = "stepping" /\ at[r] = g THEN 0 ELSE at[r]]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, stepsLeft, job, jat, cs, cv, conn, msg, pend, starts, draft, rec, execFails, modal, modals, rq, rqg, pin>>

SendRead(c) ==
    /\ rq[c] \in {"none", "done"}
    /\ cs[c] \in {"connected", "starting"}
    /\ Srv
    /\ rq' = [rq EXCEPT ![c] = IF Target(c) \in Live THEN "open" ELSE "cut"]
    /\ rqg' = [rqg EXCEPT ![c] = IF Target(c) \in Live THEN Target(c) ELSE 0]
    /\ pin' = [pin EXCEPT ![c] = IF Variant = "pinPath" THEN IF pin[c] = 0 THEN cur ELSE pin[c] ELSE 0]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cs, cv, conn, msg, pend, starts, abortedRun, draft, rec, execFails, modal, modals>>

AnswerRead(c) ==
    /\ rq[c] = "open"
    /\ rqg[c] \in Live
    /\ rq' = [rq EXCEPT ![c] = "done"]
    /\ rqg' = [rqg EXCEPT ![c] = 0]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cs, cv, conn, msg, pend, starts, abortedRun, draft, rec, execFails, modal, modals, pin>>

Notified(c) ==
    /\ c \in Sessions
    /\ Variant # "refuseOld"
    /\ cs[c] = "connected"
    /\ ~modal[c]
    /\ Srv
    /\ curv > cv[c]
    /\ cs' = [cs EXCEPT ![c] = "handing"]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("moving")]
    /\ rec' = [rec EXCEPT ![c] = IF Variant = "noRecord" THEN 0 ELSE draft[c]]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cv, conn, pend, starts, abortedRun, draft, execFails, modal, modals, rq, rqg, pin>>

OpenModal(c) ==
    /\ c \in Sessions
    /\ cs[c] = "connected"
    /\ ~modal[c]
    /\ modals < MaxModals
    /\ modal' = [modal EXCEPT ![c] = TRUE]
    /\ modals' = modals + 1
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cs, cv, conn, msg, pend, starts, abortedRun, draft, rec, execFails, rq, rqg, pin>>

CloseModal(c) ==
    /\ modal[c]
    /\ modal' = [modal EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cs, cv, conn, msg, pend, starts, abortedRun, draft, rec, execFails, modals, rq, rqg, pin>>

Exec(c) ==
    /\ cs[c] = "handing"
    /\ cs' = [cs EXCEPT ![c] = "starting"]
    /\ cv' = [cv EXCEPT ![c] = iv]
    /\ conn' = [conn EXCEPT ![c] = 0]
    /\ msg' = [msg EXCEPT ![c] = "none"]
    /\ draft' = [draft EXCEPT ![c] = rec[c]]
    /\ rec' = [rec EXCEPT ![c] = 0]
    /\ modal' = [modal EXCEPT ![c] = FALSE]
    /\ pin' = [pin EXCEPT ![c] = 0]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, pend, starts, abortedRun, execFails, modals, rq, rqg>>

ExecFail(c) ==
    /\ cs[c] = "handing"
    /\ execFails < MaxExecFails
    /\ execFails' = execFails + 1
    /\ cs' = [cs EXCEPT ![c] = "refused"]
    /\ msg' = [msg EXCEPT ![c] = NoticeFor("handoverFailed")]
    /\ rec' = [rec EXCEPT ![c] = 0]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cv, conn, draft, pend, starts, abortedRun, modal, modals, rq, rqg, pin>>

Finish(c) ==
    /\ cs[c] \in {"connected", "refused", "left"}
    /\ rq[c] # "open"
    /\ cs' = [cs EXCEPT ![c] = "none"]
    /\ cv' = [cv EXCEPT ![c] = 0]
    /\ conn' = [conn EXCEPT ![c] = 0]
    /\ msg' = [msg EXCEPT ![c] = "none"]
    /\ draft' = [draft EXCEPT ![c] = 0]
    /\ modal' = [modal EXCEPT ![c] = FALSE]
    /\ rq' = [rq EXCEPT ![c] = "none"]
    /\ rqg' = [rqg EXCEPT ![c] = 0]
    /\ pin' = [pin EXCEPT ![c] = 0]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, pend, starts, abortedRun, rec, execFails, modals>>

Type(c) ==
    /\ c \in Sessions
    /\ cs[c] \in {"connected", "starting", "waiting"}
    /\ draft[c] = 0
    /\ draft' = [draft EXCEPT ![c] = 1]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cs, cv, conn, msg, pend, starts, abortedRun, rec, execFails, modal, modals, rq, rqg, pin>>

Send(c) ==
    /\ c \in Sessions
    /\ cs[c] = "connected"
    /\ draft[c] = 1
    /\ draft' = [draft EXCEPT ![c] = 0]
    /\ UNCHANGED <<jvars, gwv, xvars, tvars, gvars, cvars, rvars, cs, cv, conn, msg, pend, starts, abortedRun, rec, execFails, modal, modals, rq, rqg, pin>>

GwStart(g) ==
    /\ g \in Gens /\ gw[g] = "none" /\ sup[g]
    /\ gw' = [gw EXCEPT ![g] = "serving"]
    /\ UNCHANGED <<tvars, gvars, cvars, rvars, kvars, jvars, gwOpen, gwProbe, gwUnanswered, xvars>>

GwCallStart(g) ==
    /\ g \in Gens /\ sup[g] /\ StepsAt(g) # {}
    /\ (gw[g] = "serving" \/ (Variant = "gwAcceptsWhileRetiring" /\ gw[g] = "retiring"))
    /\ gwOpen[g] < MaxCalls
    /\ gwOpen' = [gwOpen EXCEPT ![g] = @ + 1]
    /\ UNCHANGED <<tvars, gvars, cvars, rvars, kvars, jvars, gw, gwProbe, gwUnanswered, xvars>>

GwCallEnd(g) ==
    /\ g \in Gens /\ gwOpen[g] > 0
    /\ gwOpen' = [gwOpen EXCEPT ![g] = @ - 1]
    /\ UNCHANGED <<tvars, gvars, cvars, rvars, kvars, jvars, gw, gwProbe, gwUnanswered, xvars>>

GwFlightStart(g) ==
    /\ g \in Gens /\ gw[g] = "serving" /\ ~dr[g] /\ gwProbe[g] = 0
    /\ gwProbe' = [gwProbe EXCEPT ![g] = 1]
    /\ UNCHANGED <<tvars, gvars, cvars, rvars, kvars, jvars, gw, gwOpen, gwUnanswered, xvars>>

GwFlightEnd(g) ==
    /\ g \in Gens /\ gwProbe[g] = 1
    /\ gwProbe' = [gwProbe EXCEPT ![g] = 0]
    /\ UNCHANGED <<tvars, gvars, cvars, rvars, kvars, jvars, gw, gwOpen, gwUnanswered, xvars>>

GwRetire(g) ==
    /\ g \in Gens /\ gw[g] = "serving" /\ Retiring(g)
    /\ gw' = [gw EXCEPT ![g] = "retiring"]
    /\ UNCHANGED <<tvars, gvars, cvars, rvars, kvars, jvars, gwOpen, gwProbe, gwUnanswered, xvars>>

GwExit(g) ==
    /\ g \in Gens /\ gw[g] = "retiring" /\ gwProbe[g] = 0
    /\ (gwOpen[g] = 0 \/ Variant \in {"gwExitEarly", "gwGraceAbort"})
    /\ gw' = [gw EXCEPT ![g] = "gone"]
    /\ gwOpen' = [gwOpen EXCEPT ![g] = IF Variant = "gwGraceAbort" THEN 0 ELSE @]
    /\ gwUnanswered' = IF Variant = "gwGraceAbort" THEN gwUnanswered + gwOpen[g] ELSE gwUnanswered
    /\ UNCHANGED <<tvars, gvars, cvars, rvars, kvars, jvars, gwProbe, xvars>>

GwClose(g) ==
    /\ g \in Gens /\ gw[g] = "serving" /\ dr[g] /\ sup[g]
    /\ Variant # "userStopNeverEnds"
    /\ gwOpen[g] = 0 /\ gwProbe[g] = 0
    /\ gw' = [gw EXCEPT ![g] = "gone"]
    /\ UNCHANGED <<tvars, gvars, cvars, rvars, kvars, jvars, gwOpen, gwProbe, gwUnanswered, xvars>>

GwRefuse(r) ==
    /\ run[r] = "stepping"
    /\ gw[at[r]] = "retiring"
    /\ (Variant # "gwSilentRefuse" \/ gwUnanswered < MaxCalls * MaxGen)
    /\ run' = [run EXCEPT ![r] = IF Variant = "gwRefuseNoYield" THEN "failed" ELSE "queued"]
    /\ at' = [at EXCEPT ![r] = 0]
    /\ gwUnanswered' = IF Variant = "gwSilentRefuse" THEN gwUnanswered + 1 ELSE gwUnanswered
    /\ UNCHANGED <<tvars, gvars, cvars, stepsLeft, job, jat, kvars, jvars, gw, gwOpen, gwProbe, xvars>>

OutWrite(j) ==
    /\ job[j] = "live" /\ sup[jat[j]] /\ out[j] < MaxOut
    /\ out' = [out EXCEPT ![j] = @ + 1]
    /\ UNCHANGED <<tvars, gvars, cvars, rvars, kvars, kreq, gwv, xvars>>

Readable(j) == (job[j] = "live" /\ out[j] > 0) \/ job[j] \in {"ended", "killed"}

ReadEnabled(j, g) == Readable(j) /\ (Variant # "readOwnGenOnly" \/ g = jat[j])

OutputRead(j, g) ==
    /\ g \in Gens /\ ReadEnabled(j, g)
    /\ UNCHANGED vars

KillReq(j, g) ==
    /\ g \in Gens /\ job[j] = "live" /\ sup[jat[j]]
    /\ kreq' = [kreq EXCEPT ![j] = TRUE]
    /\ UNCHANGED <<tvars, gvars, cvars, rvars, kvars, out, gwv, xvars>>

OwnerStop(j) ==
    /\ job[j] = "live" /\ sup[jat[j]]
    /\ (kreq[j] \/ Variant = "killWithoutRequest")
    /\ job' = [job EXCEPT ![j] = "killed"]
    /\ UNCHANGED <<tvars, gvars, cvars, run, stepsLeft, at, jat, kvars, jvars, gwv, xvars>>

Reconcile(j) ==
    /\ Variant # "noReconcile"
    /\ job[j] = "live" /\ (~sup[jat[j]] \/ Variant = "reconcileLive")
    /\ job' = [job EXCEPT ![j] = "killed"]
    /\ UNCHANGED <<tvars, gvars, cvars, run, stepsLeft, at, jat, kvars, jvars, gwv, xvars>>

ServingRole(g) == g = cur /\ Srv
RetiringRole(g) == Retiring(g) /\ know[g]

Sweep(g) ==
    /\ g \in Gens /\ sup[g]
    /\ (ServingRole(g) \/ (Variant = "sweepRetiring" /\ RetiringRole(g)))
    /\ swept' = IF ServingRole(g) THEN "serving" ELSE "retiring"
    /\ UNCHANGED <<tvars, gvars, cvars, rvars, kvars, jvars, gwv, pb>>

MinLiveVer == CHOOSE v \in Vers : (\E g \in Gens : sup[g] /\ ver[g] = v) /\ (\A h \in Gens : sup[h] => ver[h] >= v)

Prune(g) ==
    /\ ServingRole(g)
    /\ pb' = IF Variant = "pruneAll" THEN curv + 1 ELSE MinLiveVer
    /\ UNCHANGED <<tvars, gvars, cvars, rvars, kvars, jvars, gwv, swept>>

Next ==
    \/ \E c \in Clients :
        Install(c) \/ ConnectNow(c) \/ MoveNow(c) \/ RefuseOlder(c) \/ FloorNow(c) \/ JoinNow(c) \/ AllocNow(c) \/ RestartNow(c)
        \/ PathFullNow(c) \/ WaitNow(c) \/ DrainNow(c) \/ Retry(c) \/ Leave(c) \/ ConnectStarter(c) \/ FailStarter(c)
        \/ GiveUp(c) \/ StarterCrash(c) \/ OpenModal(c) \/ CloseModal(c) \/ Exec(c) \/ ExecFail(c) \/ Finish(c)
        \/ Type(c) \/ Send(c) \/ SendRead(c) \/ AnswerRead(c) \/ Notified(c)
    \/ \E c \in Clients, v \in 1..MaxV : StartClient(c, v)
    \/ \E g \in Gens : SupCrash(g) \/ SupClaim(g) \/ Promote(g) \/ Notify(g) \/ Exit(g) \/ Reap(g) \/ GiveUpPromotion(g) \/ PromotedCrash(g) \/ ChildMismatch(g)
    \/ UserStop
    \/ \E r \in Runs : Submit(r) \/ StepEnd(r) \/ Takeover(r) \/ \E g \in Gens : Claim(r, g)
    \/ \E j \in Jobs, r \in Runs : JobStart(j, r)
    \/ \E j \in Jobs : JobEnd(j)
    \/ \E g \in Gens : Expire(g)
    \/ Gateway /\ (\E g \in Gens : GwStart(g) \/ GwCallStart(g) \/ GwCallEnd(g) \/ GwFlightStart(g) \/ GwFlightEnd(g)
                       \/ GwRetire(g) \/ GwExit(g) \/ GwClose(g))
    \/ Upkeep /\ (\E g \in Gens : Sweep(g) \/ Prune(g))
    \/ Gateway /\ (\E r \in Runs : GwRefuse(r))
    \/ Extended /\ (\E j \in Jobs : OwnerStop(j) \/ Reconcile(j) \/ OutWrite(j))
    \/ Extended /\ (\E j \in Jobs, g \in Gens : KillReq(j, g) \/ OutputRead(j, g))

Fairness ==
    /\ \A g \in Gens : WF_vars(GwRetire(g)) /\ WF_vars(GwCallEnd(g)) /\ WF_vars(GwFlightEnd(g)) /\ WF_vars(GwExit(g)) /\ WF_vars(GwClose(g))
    /\ (Variant # "killDropped" => \A j \in Jobs : WF_vars(OwnerStop(j)))
    /\ \A c \in Clients : WF_vars(ConnectNow(c)) /\ WF_vars(MoveNow(c)) /\ WF_vars(RefuseOlder(c)) /\ WF_vars(FloorNow(c)) /\ WF_vars(JoinNow(c)) /\ WF_vars(AllocNow(c))
    /\ \A c \in Clients : WF_vars(Retry(c)) /\ WF_vars(GiveUp(c)) /\ WF_vars(ConnectStarter(c)) /\ WF_vars(Exec(c)) /\ WF_vars(Notified(c)) /\ WF_vars(CloseModal(c)) /\ WF_vars(AnswerRead(c))
    /\ \A g \in Gens : WF_vars(SupClaim(g)) /\ WF_vars(Promote(g)) /\ WF_vars(Notify(g)) /\ WF_vars(Exit(g)) /\ WF_vars(Reap(g))
    /\ \A r \in Runs : WF_vars(StepEnd(r)) /\ \A g \in Gens : WF_vars(Claim(r, g))
    /\ (Variant # "killDropped" => \A j \in Jobs : WF_vars(JobEnd(j)))
    /\ \A j \in Jobs : WF_vars(Reconcile(j))
    /\ \A r \in Runs : WF_vars(Takeover(r))

Spec == Init /\ [][Next]_vars /\ Fairness

NoAbortRunning == ~abortedRun

NoRequestCut == (\A c \in Clients : rq[c] # "cut") /\ gwUnanswered = 0 /\ (\A g \in Gens : gw[g] = "gone" => gwOpen[g] = 0)

GwNoExitWhileOwned == \A g \in Gens : gw[g] = "gone" => gwOpen[g] = 0 /\ gwProbe[g] = 0

GwExitOnlyRetiring == \A g \in Gens : gw[g] = "gone" => (~sup[g] \/ Retiring(g) \/ dr[g])

OutputReadableAnyGen == \A j \in Jobs, g \in Gens : Readable(j) => ReadEnabled(j, g)

NoKillByUpdate == [][\A j \in Jobs : (job[j] = "live" /\ job'[j] = "killed") => (kreq[j] \/ ~sup[jat[j]])]_vars

ReconcileOwnerDead == [][\A j \in Jobs : (job[j] = "live" /\ job'[j] = "killed" /\ ~kreq[j]) => ~sup[jat[j]]]_vars

KillReachesOwner == \A j \in Jobs : (kreq[j] /\ job[j] = "live") ~> (job[j] # "live")

NoNewJobWhileRetiring == [][\A j \in Jobs : (job[j] = "none" /\ job'[j] = "live") => ~RetiringRole(jat'[j])]_vars

SweepServingOnly == [][swept' # "retiring"]_vars

PruneBelowLive == [][pb' # pb => (\A h \in Gens : sup[h] => ver[h] >= pb')]_vars

GwNoNewCallWhileRetiring == [][\A g \in Gens : gwOpen'[g] > gwOpen[g] => gw[g] = "serving"]_vars

GwEnds == \A g \in Gens : gw[g] = "retiring" ~> gw[g] = "gone"

OrphanJobEnds == \A j \in Jobs : (job[j] = "live" /\ ~sup[jat[j]]) ~> job[j] # "live"

OrphanRunYields == \A r \in Runs : (run[r] = "stepping" /\ ~sup[at[r]]) ~> run[r] # "stepping"

StopEnds == \A g \in Gens : (dr[g] /\ sup[g]) ~> ~sup[g]

RefusalYields == \A r \in Runs : run[r] # "failed"

NoKilledJob == \A j \in Jobs : job[j] # "killed"

WorkNeverPaused == stopped \/ faulted \/ ((\E g \in Gens : prom[g] /\ sup[g]) => Srv)

OneServing == Cardinality({g \in Gens : g = cur /\ sup[g] /\ ~dr[g]}) <= 1

SteppingNeverOrphaned == faulted \/ (\A r \in Runs : run[r] = "stepping" => sup[at[r]])

NewerClientNeverWaits == \A c \in Clients : cs[c] # "waiting"

ClientsInformed ==
    \A c \in Clients :
        /\ cs[c] = "waiting" => msg[c] = "pending"
        /\ cs[c] = "refused" => msg[c] \in {"reopen", "handoverFailed", "startFailed", "pathTooLong"}
        /\ cs[c] = "left" => msg[c] = "stillRunning"
        /\ cs[c] = "handing" => msg[c] = "moving"

HandoffRecordMatches == \A c \in Clients : cs[c] = "handing" => rec[c] = draft[c]

NoLiveRemoved == \A g \in Gens : sup[g] => dir[g]

NumbersOnlyAllocated == \A g \in Gens : g >= nextGen => ~dir[g] /\ ~sup[g] /\ ~claimed[g] /\ ver[g] = 0

StarterKeepsDir == \A c \in Clients : (cs[c] = "starting" /\ pend[c] # 0 /\ stl[pend[c]] = c) => dir[pend[c]]

NoNumberReuse == [][\A g \in Gens : (dir'[g] /\ ~dir[g]) => g >= nextGen]_vars /\ [][nextGen' >= nextGen]_vars

NoDuplicateStart == [][\A g \in Gens : (dir'[g] /\ ~dir[g]) => ~(\E h \in Starting : ver[h] >= ver'[g])]_vars

CurrentOnlyByPromotion == [][cur' = cur \/ (cur' > cur /\ prom'[cur'])]_vars

CurVersionMonotone == [][curv' >= curv]_vars

StarterSucceedsCurrent ==
    [][\A c \in Clients :
        (cs[c] = "starting" /\ cs'[c] = "connected" /\ pend[c] # 0) => (conn'[c] = cur' /\ sup'[cur'] /\ ~dr'[cur'])]_vars

RetiringAddsNoWork ==
    [][\A g \in Gens :
        (Retiring(g) /\ know[g]) => Cardinality(StepsAt(g)') + Cardinality(JobsAt(g)') <= Cardinality(StepsAt(g)) + Cardinality(JobsAt(g))]_vars

DraftKept == [][\A c \in Clients : (cs[c] = "handing" /\ cs'[c] = "starting") => draft'[c] = draft[c]]_vars

HandoverKeepsWork == [][(\E c \in Clients : cs[c] = "handing" /\ cs'[c] # "handing") => (run' = run /\ job' = job /\ at' = at)]_vars

RetiringEnds == \A g \in Gens : Retiring(g) ~> ~sup[g]

SessionMoves ==
    \A c \in Sessions :
        (cs[c] \in {"connected", "starting"} /\ Srv /\ cv[c] < curv)
            ~> (cs[c] \in {"none", "refused"} \/ msg[c] = "handoverFailed" \/ ~Srv \/ cv[c] >= curv)

=============================================================================
