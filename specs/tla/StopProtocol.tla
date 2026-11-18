---------------------------- MODULE StopProtocol ----------------------------
EXTENDS Naturals

CONSTANTS Gens, Vals, MaxT, Variant

ASSUME Variant \in {"decided", "mixed", "noMessage", "noDeadline", "waitsForever",
                    "sigtermAfterFail", "malformed", "malformedNoKill", "noReap", "runtimeLate",
                    "graceConfirm", "failOnUnconfirmed", "unboundedConfirm", "runtimeNoShare",
                    "takeBeforeDrain", "lateApplies", "runtimeSignalAfterFail"}
ASSUME MaxT \in Nat
ASSUME Gens # {}
ASSUME Vals \subseteq Nat \ {0}

FmBound == 2
KILLCONF == 2
REAP == FmBound

CG(v) == v
GW(v) == CG(v) + FmBound
CHILD(v) == GW(v) + KILLCONF + 1
RTK(r) == r + 1
RT(r) == r + KILLCONF + 1
RTSHARE(r) == IF Variant = "runtimeNoShare" THEN RTK(r) ELSE RT(r)
SUP(v, r) == RTSHARE(r) + CHILD(v) + KILLCONF + REAP + 1
DAEMON(v, r) == SUP(v, r) + 1
ABUD(v) == FmBound + KILLCONF + 1

MaxVal == CHOOSE v \in Vals : \A w \in Vals : w <= v

NoValidMessage == Variant \in {"noMessage", "malformed", "malformedNoKill"}
DeadlineKills == Variant \notin {"waitsForever", "malformedNoKill"}
FailKills == Variant \notin {"waitsForever", "sigtermAfterFail"}

VARIABLES file, clock, reqVal,
          sst, sv, sBegin, sent, bvSup, wr, mode, cdl,
          gst, gv, gBegin, gcalls, gphase, ms, rdl,
          cw, cwDL, cwVal, rtv,
          kdl, kat, alive, sfail, rst, rtdl,
          rw, rsig, rpipe, rrecv, rhow, rtaken, rgot, rfile

ChildVars == << rw, rsig, rpipe, rrecv, rhow, rtaken, rgot, rfile >>

vars == << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, ms, rdl, cw, cwDL, cwVal, rtv, kdl, kat, alive, sfail, rst, rtdl, ChildVars >>

ProtoVars == << sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, ms, rdl, cw, cwDL, cwVal, rtv, kdl, kat, alive, sfail, rst, rtdl, ChildVars >>

Init ==
    /\ file \in Vals
    /\ clock = 0
    /\ reqVal = 0
    /\ sst = [g \in Gens |-> "up"]
    /\ sv = [g \in Gens |-> 0]
    /\ sBegin = [g \in Gens |-> 0]
    /\ sent = [g \in Gens |-> FALSE]
    /\ bvSup = [g \in Gens |-> 0]
    /\ wr = [g \in Gens |-> "none"]
    /\ mode = [g \in Gens |-> "term"]
    /\ cdl = [g \in Gens |-> 0]
    /\ gst = [g \in Gens |-> "none"]
    /\ gv = [g \in Gens |-> 0]
    /\ gBegin = [g \in Gens |-> 0]
    /\ gcalls = [g \in Gens |-> FALSE]
    /\ gphase = [g \in Gens |-> "none"]
    /\ ms = [g \in Gens |-> "alive"]
    /\ rdl = [g \in Gens |-> 0]
    /\ cw = [g \in Gens |-> "none"]
    /\ cwDL = [g \in Gens |-> 0]
    /\ cwVal = [g \in Gens |-> 0]
    /\ rtv = [g \in Gens |-> [carry |-> 0, bound |-> 0, applied |-> 0]]
    /\ kdl = [g \in Gens |-> 0]
    /\ kat = [g \in Gens |-> 0]
    /\ alive = [g \in Gens |-> FALSE]
    /\ sfail = [g \in Gens |-> FALSE]
    /\ rst = [g \in Gens |-> "up"]
    /\ rtdl = [g \in Gens |-> 0]
    /\ rw = [g \in Gens |-> "none"]
    /\ rsig = [g \in Gens |-> FALSE]
    /\ rpipe = [g \in Gens |-> FALSE]
    /\ rrecv = [g \in Gens |-> 0]
    /\ rhow = [g \in Gens |-> "none"]
    /\ rtaken = [g \in Gens |-> FALSE]
    /\ rgot = [g \in Gens |-> FALSE]
    /\ rfile = [g \in Gens |-> 0]

SupOverdue(g) == Variant # "waitsForever" /\ sst[g] = "stopping" /\ clock >= sBegin[g] + SUP(bvSup[g], rtv[g].bound)
DeadlineOverdue(g) == DeadlineKills /\ sst[g] = "stopping" /\ rst[g] = "gone" /\ gst[g] \in {"none", "closing"} /\ clock >= cdl[g]
FailOverdue(g) == FailKills /\ sst[g] = "stopping" /\ rst[g] = "gone" /\ wr[g] = "failed" /\ gst[g] \in {"none", "closing"}
GraceOverdue(g) == gst[g] = "closing" /\ gphase[g] = "none" /\ clock >= gBegin[g] + CG(gv[g])
GwOverdue(g) == Variant \notin {"noDeadline", "waitsForever"} /\ gst[g] = "closing" /\ clock >= gBegin[g] + GW(gv[g])
WaiterOverdue(g) == cw[g] = "armed" /\ clock >= cwDL[g]
ReapOverdue(g) == Variant # "noReap" /\ gst[g] = "gone" /\ ms[g] # "gone" /\ clock >= rdl[g]
RtOverdue(g) == rst[g] \in {"closing", "killing"} /\ clock >= rtdl[g]
KillOverdue(g) == Variant # "unboundedConfirm" /\ gst[g] = "killing" /\ clock >= kdl[g]

Overdue ==
    \E g \in Gens :
        SupOverdue(g) \/ RtOverdue(g) \/ DeadlineOverdue(g) \/ FailOverdue(g) \/ GraceOverdue(g) \/ GwOverdue(g) \/ WaiterOverdue(g) \/ ReapOverdue(g) \/ KillOverdue(g)

Tick ==
    /\ clock < MaxT
    /\ ~Overdue
    /\ clock' = clock + 1
    /\ UNCHANGED << file, reqVal, ProtoVars >>

ChangeFile ==
    /\ \E v \in Vals : file' = v
    /\ UNCHANGED << clock, reqVal, ProtoVars >>

CliStop ==
    /\ reqVal = 0
    /\ clock + DAEMON(MaxVal, MaxVal) <= MaxT
    /\ \A g \in Gens : sst[g] = "up"
    /\ reqVal' = file
    /\ sst' = [g \in Gens |-> "stopping"]
    /\ sv' = [g \in Gens |-> file]
    /\ sBegin' = [g \in Gens |-> clock]
    /\ bvSup' = [g \in Gens |-> file]
    /\ wr' = [g \in Gens |-> "writing"]
    /\ mode' = [g \in Gens |-> "term"]
    /\ cdl' = [g \in Gens |-> 0]
    /\ rst' = [g \in Gens |-> "closing"]
    /\ rtdl' = [g \in Gens |-> clock + RTK(file)]
    /\ cw' = [g \in Gens |-> "armed"]
    /\ cwVal' = [g \in Gens |-> file]
    /\ rtv' = [g \in Gens |-> [rtv[g] EXCEPT !.carry = file, !.bound = file]]
    /\ cwDL' = [g \in Gens |-> clock + DAEMON(file, file)]
    /\ rw' = [g \in Gens |-> "writing"]
    /\ rsig' = [g \in Gens |-> Variant = "runtimeLate"]
    /\ UNCHANGED << kdl, kat, alive, sfail, file, clock, sent, gst, gv, gBegin, gcalls, gphase, ms, rdl, rpipe, rrecv, rhow, rtaken, rgot, rfile >>

SelfBegin(g) ==
    /\ sst[g] = "up"
    /\ clock + DAEMON(MaxVal, MaxVal) <= MaxT
    /\ sst' = [sst EXCEPT ![g] = "stopping"]
    /\ sv' = [sv EXCEPT ![g] = file]
    /\ sBegin' = [sBegin EXCEPT ![g] = clock]
    /\ bvSup' = [bvSup EXCEPT ![g] = file]
    /\ rtv' = [rtv EXCEPT ![g].carry = file, ![g].bound = file]
    /\ wr' = [wr EXCEPT ![g] = "writing"]
    /\ mode' = [mode EXCEPT ![g] = "term"]
    /\ cdl' = [cdl EXCEPT ![g] = 0]
    /\ rst' = [rst EXCEPT ![g] = "closing"]
    /\ rtdl' = [rtdl EXCEPT ![g] = clock + RTK(file)]
    /\ rw' = [rw EXCEPT ![g] = "writing"]
    /\ rsig' = [rsig EXCEPT ![g] = Variant = "runtimeLate"]
    /\ UNCHANGED << kdl, kat, alive, sfail, file, clock, reqVal, sent, gst, gv, gBegin, gcalls, gphase, ms, rdl, cw, cwDL, cwVal, rpipe, rrecv, rhow, rtaken, rgot, rfile >>

Escalate(g) ==
    /\ sst[g] = "stopping"
    /\ mode[g] = "term"
    /\ gst[g] # "gone"
    /\ mode' = [mode EXCEPT ![g] = "int"]
    /\ cdl' = [cdl EXCEPT ![g] = IF rst[g] = "gone" /\ clock + ABUD(bvSup[g]) < cdl[g] THEN clock + ABUD(bvSup[g]) ELSE cdl[g]]
    /\ gphase' = [gphase EXCEPT ![g] = IF gst[g] = "closing" /\ gphase[g] = "none" THEN "fm" ELSE gphase[g]]
    /\ ms' = [ms EXCEPT ![g] = IF gst[g] = "closing" /\ gphase[g] = "none" THEN "stopping" ELSE ms[g]]
    /\ UNCHANGED << kdl, kat, alive, sfail, rtv, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, gst, gv, gBegin, gcalls, rdl, cw, cwDL, cwVal, rst, rtdl, ChildVars >>

SendStop(g) ==
    /\ sst[g] = "stopping"
    /\ rst[g] = "gone"
    /\ wr[g] = "writing"
    /\ gst[g] = "none"
    /\ (Variant = "waitsForever" \/ clock < cdl[g])
    /\ wr' = [wr EXCEPT ![g] = "written"]
    /\ sent' = [sent EXCEPT ![g] = TRUE]
    /\ gst' = [gst EXCEPT ![g] = "closing"]
    /\ gBegin' = [gBegin EXCEPT ![g] = clock]
    /\ gcalls' = [gcalls EXCEPT ![g] = TRUE]
    /\ gphase' = [gphase EXCEPT ![g] = IF mode[g] = "int" THEN "fm" ELSE "none"]
    /\ ms' = [ms EXCEPT ![g] = IF mode[g] = "int" THEN "stopping" ELSE ms[g]]
    /\ gv' = [gv EXCEPT ![g] = IF NoValidMessage THEN file ELSE sv[g]]
    /\ bvSup' = [bvSup EXCEPT ![g] = IF Variant = "mixed" THEN file ELSE bvSup[g]]
    /\ rtv' = [rtv EXCEPT ![g].bound = IF Variant = "mixed" THEN file ELSE rtv[g].bound]
    /\ UNCHANGED << kdl, kat, alive, sfail, file, clock, reqVal, sst, sv, sBegin, mode, cdl, rdl, cw, cwDL, cwVal, rst, rtdl, ChildVars >>

WriteFailed(g) ==
    /\ sst[g] = "stopping"
    /\ rst[g] = "gone"
    /\ wr[g] = "writing"
    /\ gst[g] = "none"
    /\ wr' = [wr EXCEPT ![g] = "failed"]
    /\ sent' = [sent EXCEPT ![g] = (Variant = "sigtermAfterFail") \/ sent[g]]
    /\ gst' = [gst EXCEPT ![g] = IF Variant = "sigtermAfterFail" THEN "closing" ELSE gst[g]]
    /\ gBegin' = [gBegin EXCEPT ![g] = IF Variant = "sigtermAfterFail" THEN clock ELSE gBegin[g]]
    /\ gcalls' = [gcalls EXCEPT ![g] = IF Variant = "sigtermAfterFail" THEN TRUE ELSE gcalls[g]]
    /\ gv' = [gv EXCEPT ![g] = IF Variant = "sigtermAfterFail" THEN file ELSE gv[g]]
    /\ UNCHANGED rtv
    /\ gphase' = [gphase EXCEPT ![g] = IF Variant = "sigtermAfterFail" /\ mode[g] = "int" THEN "fm" ELSE gphase[g]]
    /\ UNCHANGED << kdl, kat, alive, sfail, file, clock, reqVal, sst, sv, sBegin, bvSup, mode, cdl, ms, rdl, cw, cwDL, cwVal, rst, rtdl, ChildVars >>

KillNow(g) ==
    /\ gst' = [gst EXCEPT ![g] = "killing"]
    /\ alive' = [alive EXCEPT ![g] = TRUE]
    /\ kat' = [kat EXCEPT ![g] = clock]
    /\ kdl' = [kdl EXCEPT ![g] = clock + IF Variant = "graceConfirm" THEN CG(gv[g]) ELSE KILLCONF]
    /\ cdl' = [cdl EXCEPT ![g] = 0]
    /\ wr' = [wr EXCEPT ![g] = "none"]
    /\ mode' = [mode EXCEPT ![g] = "term"]
    /\ gBegin' = [gBegin EXCEPT ![g] = 0]
    /\ gcalls' = [gcalls EXCEPT ![g] = FALSE]
    /\ gphase' = [gphase EXCEPT ![g] = "none"]
    /\ UNCHANGED << rtv, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, gv, ms, rdl, cw, cwDL, cwVal, sfail, rst, rtdl, ChildVars >>

DeadlineKill(g) ==
    /\ DeadlineOverdue(g)
    /\ KillNow(g)

FailKill(g) ==
    /\ FailOverdue(g)
    /\ KillNow(g)

CallEnds(g) ==
    /\ gst[g] = "closing"
    /\ gphase[g] = "none"
    /\ gcalls[g]
    /\ gcalls' = [gcalls EXCEPT ![g] = FALSE]
    /\ UNCHANGED << kdl, kat, alive, sfail, rtv, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gphase, ms, rdl, cw, cwDL, cwVal, rst, rtdl, ChildVars >>

GraceEnd(g) ==
    /\ gst[g] = "closing"
    /\ gphase[g] = "none"
    /\ clock >= gBegin[g] + CG(gv[g])
    /\ gcalls' = [gcalls EXCEPT ![g] = FALSE]
    /\ gphase' = [gphase EXCEPT ![g] = "fm"]
    /\ ms' = [ms EXCEPT ![g] = "stopping"]
    /\ UNCHANGED << kdl, kat, alive, sfail, rtv, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, rdl, cw, cwDL, cwVal, rst, rtdl, ChildVars >>

FmDone(g) ==
    /\ Variant # "waitsForever"
    /\ gst[g] = "closing"
    /\ gphase[g] = "fm"
    /\ gst' = [gst EXCEPT ![g] = "gone"]
    /\ ms' = [ms EXCEPT ![g] = "gone"]
    /\ rdl' = [rdl EXCEPT ![g] = 0]
    /\ cdl' = [cdl EXCEPT ![g] = 0]
    /\ wr' = [wr EXCEPT ![g] = "none"]
    /\ mode' = [mode EXCEPT ![g] = "term"]
    /\ gBegin' = [gBegin EXCEPT ![g] = 0]
    /\ gcalls' = [gcalls EXCEPT ![g] = FALSE]
    /\ gphase' = [gphase EXCEPT ![g] = "none"]
    /\ UNCHANGED << kdl, kat, alive, sfail, rtv, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, gv, cw, cwDL, cwVal, rst, rtdl, ChildVars >>

GwForcedGone(g) ==
    /\ GwOverdue(g)
    /\ KillNow(g)

KernelGone(g) ==
    /\ alive[g]
    /\ alive' = [alive EXCEPT ![g] = FALSE]
    /\ kat' = [kat EXCEPT ![g] = 0]
    /\ gst' = [gst EXCEPT ![g] = IF gst[g] = "killing" THEN "gone" ELSE gst[g]]
    /\ rdl' = [rdl EXCEPT ![g] = IF gst[g] = "killing" THEN clock + REAP ELSE rdl[g]]
    /\ kdl' = [kdl EXCEPT ![g] = IF gst[g] = "killing" THEN 0 ELSE kdl[g]]
    /\ UNCHANGED << rtv, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gv, gBegin, gcalls, gphase, ms, cw, cwDL, cwVal, sfail, rst, rtdl, ChildVars >>

Unconfirmed(g) ==
    /\ Variant # "unboundedConfirm"
    /\ KillOverdue(g)
    /\ gst' = [gst EXCEPT ![g] = "gone"]
    /\ rdl' = [rdl EXCEPT ![g] = clock + REAP]
    /\ kdl' = [kdl EXCEPT ![g] = 0]
    /\ sfail' = [sfail EXCEPT ![g] = sfail[g] \/ Variant = "failOnUnconfirmed"]
    /\ UNCHANGED << rtv, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gv, gBegin, gcalls, gphase, ms, cw, cwDL, cwVal, alive, kat, rst, rtdl, ChildVars >>

Reap(g) ==
    /\ Variant # "noReap"
    /\ gst[g] = "gone"
    /\ ms[g] # "gone"
    /\ ms' = [ms EXCEPT ![g] = "gone"]
    /\ rdl' = [rdl EXCEPT ![g] = 0]
    /\ UNCHANGED << kdl, kat, alive, sfail, rtv, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, cw, cwDL, cwVal, rst, rtdl, ChildVars >>

SupGone(g) ==
    /\ sst[g] = "stopping"
    /\ \/ /\ gst[g] = "gone"
          /\ (Variant = "noReap" \/ ms[g] = "gone")
       \/ (Variant # "waitsForever" /\ clock >= sBegin[g] + SUP(bvSup[g], rtv[g].bound))
    /\ sst' = [sst EXCEPT ![g] = "gone"]
    /\ cdl' = [cdl EXCEPT ![g] = 0]
    /\ wr' = [wr EXCEPT ![g] = "none"]
    /\ mode' = [mode EXCEPT ![g] = "term"]
    /\ UNCHANGED << kdl, kat, alive, sfail, rtv, file, clock, reqVal, sv, sBegin, sent, bvSup, gst, gv, gBegin, gcalls, gphase, ms, rdl, cw, cwDL, cwVal, rst, rtdl, ChildVars >>

RtEnded(g) ==
    /\ rst' = [rst EXCEPT ![g] = "gone"]
    /\ rtdl' = [rtdl EXCEPT ![g] = 0]
    /\ cdl' = [cdl EXCEPT ![g] = clock + IF mode[g] = "int" THEN ABUD(bvSup[g]) ELSE CHILD(bvSup[g])]
    /\ UNCHANGED << kdl, kat, alive, sfail, rtv, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, gst, gv, gBegin, gcalls, gphase, ms, rdl, cw, cwDL, cwVal, ChildVars >>

RtDone(g) ==
    /\ rst[g] = "closing"
    /\ rtaken[g]
    /\ RtEnded(g)

RtKill(g) ==
    /\ rst[g] = "closing"
    /\ clock >= rtdl[g]
    /\ rst' = [rst EXCEPT ![g] = "killing"]
    /\ rtdl' = [rtdl EXCEPT ![g] = clock + KILLCONF]
    /\ UNCHANGED << kdl, kat, alive, sfail, rtv, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, ms, rdl, cw, cwDL, cwVal, ChildVars >>

RtGone(g) ==
    /\ rst[g] = "killing"
    /\ RtEnded(g)

RtWriteDone(g) ==
    /\ rw[g] = "writing"
    /\ rst[g] = "closing"
    /\ rw' = [rw EXCEPT ![g] = "written"]
    /\ rpipe' = [rpipe EXCEPT ![g] = ~NoValidMessage]
    /\ rsig' = [rsig EXCEPT ![g] = TRUE]
    /\ UNCHANGED << kdl, kat, alive, sfail, rtv, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, ms, rdl, cw, cwDL, cwVal, rst, rtdl, rrecv, rhow, rtaken, rgot, rfile >>

RtWriteFailed(g) ==
    /\ rw[g] = "writing"
    /\ rst[g] = "closing"
    /\ rw' = [rw EXCEPT ![g] = "failed"]
    /\ rsig' = [rsig EXCEPT ![g] = rsig[g] \/ Variant = "runtimeSignalAfterFail"]
    /\ rst' = [rst EXCEPT ![g] = IF Variant = "runtimeSignalAfterFail" THEN "closing" ELSE "killing"]
    /\ rtdl' = [rtdl EXCEPT ![g] = IF Variant = "runtimeSignalAfterFail" THEN rtdl[g] ELSE clock + KILLCONF]
    /\ UNCHANGED << kdl, kat, alive, sfail, rtv, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, ms, rdl, cw, cwDL, cwVal, rpipe, rrecv, rhow, rtaken, rgot, rfile >>

ChildBegin(g, how) ==
    /\ rhow[g] = "none"
    /\ rst[g] # "gone"
    /\ (how = "self" \/ rsig[g])
    /\ rhow' = [rhow EXCEPT ![g] = how]
    /\ UNCHANGED << kdl, kat, alive, sfail, rtv, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, ms, rdl, cw, cwDL, cwVal, rst, rtdl, rw, rsig, rpipe, rrecv, rtaken, rgot, rfile >>

ChildRead(g) ==
    /\ rpipe[g]
    /\ rst[g] # "gone"
    /\ rpipe' = [rpipe EXCEPT ![g] = FALSE]
    /\ rrecv' = [rrecv EXCEPT ![g] = IF rtaken[g] \/ rrecv[g] # 0 THEN rrecv[g] ELSE rtv[g].carry]
    /\ rtv' = [rtv EXCEPT ![g].applied = IF rtaken[g] /\ Variant = "lateApplies" THEN rtv[g].carry ELSE rtv[g].applied]
    /\ UNCHANGED << kdl, kat, alive, sfail, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, ms, rdl, cw, cwDL, cwVal, rst, rtdl, rw, rsig, rhow, rtaken, rgot, rfile >>

Drains(g) == rpipe[g] /\ Variant # "takeBeforeDrain"

ChildTake(g) ==
    /\ rhow[g] # "none"
    /\ ~rtaken[g]
    /\ rst[g] # "gone"
    /\ rtaken' = [rtaken EXCEPT ![g] = TRUE]
    /\ rpipe' = [rpipe EXCEPT ![g] = IF Drains(g) THEN FALSE ELSE rpipe[g]]
    /\ rrecv' = [rrecv EXCEPT ![g] = IF Drains(g) /\ rrecv[g] = 0 THEN rtv[g].carry ELSE rrecv[g]]
    /\ rgot' = [rgot EXCEPT ![g] = rrecv[g] # 0 \/ Drains(g)]
    /\ rfile' = [rfile EXCEPT ![g] = file]
    /\ rtv' = [rtv EXCEPT ![g].applied = IF rrecv[g] # 0 THEN rrecv[g] ELSE IF Drains(g) THEN rtv[g].carry ELSE file]
    /\ UNCHANGED << kdl, kat, alive, sfail, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, ms, rdl, cw, cwDL, cwVal, rst, rtdl, rw, rsig, rhow >>

Give(g) ==
    /\ cw[g] = "armed"
    /\ clock >= cwDL[g]
    /\ cw' = [cw EXCEPT ![g] = "gaveUp"]
    /\ UNCHANGED << kdl, kat, alive, sfail, rtv, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, ms, rdl, cwDL, cwVal, rst, rtdl, ChildVars >>

Done(g) ==
    /\ cw[g] = "armed"
    /\ sst[g] = "gone"
    /\ cw' = [cw EXCEPT ![g] = "done"]
    /\ UNCHANGED << kdl, kat, alive, sfail, rtv, file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, ms, rdl, cwDL, cwVal, rst, rtdl, ChildVars >>

GenStep(g) ==
    \/ SelfBegin(g)
    \/ RtDone(g)
    \/ RtKill(g)
    \/ RtGone(g)
    \/ RtWriteDone(g)
    \/ RtWriteFailed(g)
    \/ ChildBegin(g, "signal")
    \/ ChildBegin(g, "self")
    \/ ChildRead(g)
    \/ ChildTake(g)
    \/ Escalate(g)
    \/ SendStop(g)
    \/ WriteFailed(g)
    \/ DeadlineKill(g)
    \/ FailKill(g)
    \/ CallEnds(g)
    \/ GraceEnd(g)
    \/ FmDone(g)
    \/ GwForcedGone(g)
    \/ KernelGone(g)
    \/ Unconfirmed(g)
    \/ Reap(g)
    \/ SupGone(g)
    \/ Give(g)
    \/ Done(g)

Next ==
    \/ Tick
    \/ ChangeFile
    \/ CliStop
    \/ \E g \in Gens : GenStep(g)

Fairness == WF_vars(Tick) /\ \A g \in Gens : WF_vars(GenStep(g))

Spec == Init /\ [][Next]_vars /\ Fairness


TypeOK ==
    /\ file \in Vals
    /\ clock \in 0..MaxT
    /\ sst \in [Gens -> {"up", "stopping", "gone"}]
    /\ wr \in [Gens -> {"none", "writing", "written", "failed"}]
    /\ mode \in [Gens -> {"term", "int"}]
    /\ cdl \in [Gens -> 0..(MaxT + CHILD(MaxVal))]
    /\ gphase \in [Gens -> {"none", "fm"}]
    /\ ms \in [Gens -> {"alive", "stopping", "gone"}]
    /\ rdl \in [Gens -> 0..(MaxT + REAP)]
    /\ cw \in [Gens -> {"none", "armed", "gaveUp", "done"}]
    /\ rtv \in [Gens -> [carry : Vals \cup {0}, bound : Vals \cup {0}, applied : Vals \cup {0}]]
    /\ gst \in [Gens -> {"none", "closing", "killing", "gone"}]
    /\ kdl \in [Gens -> 0..(MaxT + MaxVal)]
    /\ kat \in [Gens -> 0..MaxT]
    /\ alive \in [Gens -> BOOLEAN]
    /\ sfail \in [Gens -> BOOLEAN]
    /\ rst \in [Gens -> {"up", "closing", "killing", "gone"}]
    /\ rtdl \in [Gens -> 0..(MaxT + RTK(MaxVal))]
    /\ rw \in [Gens -> {"none", "writing", "written", "failed"}]
    /\ rsig \in [Gens -> BOOLEAN]
    /\ rpipe \in [Gens -> BOOLEAN]
    /\ rrecv \in [Gens -> Vals \cup {0}]
    /\ rhow \in [Gens -> {"none", "signal", "self"}]
    /\ rtaken \in [Gens -> BOOLEAN]
    /\ rgot \in [Gens -> BOOLEAN]
    /\ rfile \in [Gens -> Vals \cup {0}]

SameValues ==
    \A g \in Gens :
        /\ sst[g] # "up" => bvSup[g] = sv[g]
        /\ sent[g] => gv[g] = sv[g]
        /\ cw[g] \in {"armed", "gaveUp", "done"} => cwVal[g] = sv[g]
        /\ sst[g] # "up" => rtv[g].bound = sv[g]
        /\ (rtaken[g] /\ rhow[g] = "signal") => rtv[g].applied = sv[g]

ChildValues == \A g \in Gens : rtaken[g] => rtv[g].applied = IF rgot[g] THEN rrecv[g] ELSE rfile[g]

ValuesFixed == [][\A g \in Gens : rtaken[g] => rtv'[g].applied = rtv[g].applied]_vars

NoOutlast == \A g \in Gens : cw[g] = "gaveUp" => sst[g] = "gone"

StopEnds == \A g \in Gens : (sst[g] = "stopping") ~> (sst[g] = "gone")

WithinBound ==
    /\ \A g \in Gens : gst[g] = "closing" => clock <= gBegin[g] + GW(gv[g])
    /\ \A g \in Gens : (sst[g] = "stopping" /\ rst[g] = "gone" /\ gst[g] \in {"none", "closing"}) => clock <= cdl[g]
    /\ \A g \in Gens : gst[g] = "killing" => clock <= kdl[g]
    /\ \A g \in Gens : rst[g] \in {"closing", "killing"} => clock <= rtdl[g]
    /\ \A g \in Gens : (gst[g] = "gone" /\ ms[g] # "gone") => clock <= rdl[g]
    /\ \A g \in Gens : sst[g] = "stopping" => clock <= sBegin[g] + SUP(bvSup[g], rtv[g].bound)

GatewayEndsWithStop == \A g \in Gens : sst[g] = "gone" => gst[g] = "gone"

NoManagedOutlives == \A g \in Gens : sst[g] = "gone" => ms[g] = "gone"

KillWindowIsShare == \A g \in Gens : gst[g] = "killing" => kdl[g] = kat[g] + KILLCONF

NoEarlyUnconfirmed == \A g \in Gens : (gst[g] = "gone" /\ alive[g]) => clock >= kat[g] + KILLCONF

NoStopFailure == \A g \in Gens : ~sfail[g]

EventuallyGone == \A g \in Gens : alive[g] ~> ~alive[g]

=============================================================================
