---------------------------- MODULE StopProtocol ----------------------------
EXTENDS Naturals

CONSTANTS Gens, Vals, MaxT, Variant

ASSUME Variant \in {"decided", "mixed", "noMessage", "lateWaiter", "noDeadline", "waitsForever",
                    "sigtermAfterFail", "malformed", "malformedNoKill", "noReap"}
ASSUME MaxT \in Nat
ASSUME Gens # {}
ASSUME Vals \subseteq Nat \ {0}

FmBound == 2
REAP == FmBound

CG(v) == v
GW(v) == CG(v) + FmBound
CHILD(v) == GW(v) + 1
SUP(v) == CHILD(v) + REAP + 1
DAEMON(v) == SUP(v) + 1
ABUD(v) == FmBound + 1

MaxVal == CHOOSE v \in Vals : \A w \in Vals : w <= v

NoValidMessage == Variant \in {"noMessage", "malformed", "malformedNoKill"}
DeadlineKills == Variant \notin {"waitsForever", "malformedNoKill"}
FailKills == Variant \notin {"waitsForever", "sigtermAfterFail"}

VARIABLES file, clock, reqVal,
          sst, sv, sBegin, sent, bvSup, wr, mode, cdl,
          gst, gv, gBegin, gcalls, gphase, ms, rdl,
          cw, cwDL, cwVal

vars == << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, ms, rdl, cw, cwDL, cwVal >>

ProtoVars == << sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, ms, rdl, cw, cwDL, cwVal >>

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

SupOverdue(g) == Variant # "waitsForever" /\ sst[g] = "stopping" /\ clock >= sBegin[g] + SUP(bvSup[g])
DeadlineOverdue(g) == DeadlineKills /\ sst[g] = "stopping" /\ gst[g] # "gone" /\ clock >= cdl[g]
FailOverdue(g) == FailKills /\ sst[g] = "stopping" /\ wr[g] = "failed" /\ gst[g] # "gone"
GraceOverdue(g) == gst[g] = "closing" /\ gphase[g] = "none" /\ clock >= gBegin[g] + CG(gv[g])
GwOverdue(g) == Variant \notin {"noDeadline", "waitsForever"} /\ gst[g] = "closing" /\ clock >= gBegin[g] + GW(gv[g])
WaiterOverdue(g) == cw[g] = "armed" /\ clock >= cwDL[g]
ReapOverdue(g) == Variant # "noReap" /\ gst[g] = "gone" /\ ms[g] # "gone" /\ clock >= rdl[g]

Overdue ==
    \E g \in Gens :
        SupOverdue(g) \/ DeadlineOverdue(g) \/ FailOverdue(g) \/ GraceOverdue(g) \/ GwOverdue(g) \/ WaiterOverdue(g) \/ ReapOverdue(g)

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
    /\ clock + DAEMON(MaxVal) <= MaxT
    /\ \A g \in Gens : sst[g] = "up"
    /\ reqVal' = file
    /\ sst' = [g \in Gens |-> "stopping"]
    /\ sv' = [g \in Gens |-> file]
    /\ sBegin' = [g \in Gens |-> clock]
    /\ bvSup' = [g \in Gens |-> file]
    /\ wr' = [g \in Gens |-> "writing"]
    /\ mode' = [g \in Gens |-> "term"]
    /\ cdl' = [g \in Gens |-> clock + CHILD(file)]
    /\ cw' = [g \in Gens |-> IF Variant = "lateWaiter" THEN "pending" ELSE "armed"]
    /\ cwVal' = [g \in Gens |-> IF Variant = "lateWaiter" THEN 0 ELSE file]
    /\ cwDL' = [g \in Gens |-> IF Variant = "lateWaiter" THEN 0 ELSE clock + DAEMON(file)]
    /\ UNCHANGED << file, clock, sent, gst, gv, gBegin, gcalls, gphase, ms, rdl >>

SelfBegin(g) ==
    /\ sst[g] = "up"
    /\ clock + DAEMON(MaxVal) <= MaxT
    /\ sst' = [sst EXCEPT ![g] = "stopping"]
    /\ sv' = [sv EXCEPT ![g] = file]
    /\ sBegin' = [sBegin EXCEPT ![g] = clock]
    /\ bvSup' = [bvSup EXCEPT ![g] = file]
    /\ wr' = [wr EXCEPT ![g] = "writing"]
    /\ mode' = [mode EXCEPT ![g] = "term"]
    /\ cdl' = [cdl EXCEPT ![g] = clock + CHILD(file)]
    /\ UNCHANGED << file, clock, reqVal, sent, gst, gv, gBegin, gcalls, gphase, ms, rdl, cw, cwDL, cwVal >>

Escalate(g) ==
    /\ sst[g] = "stopping"
    /\ mode[g] = "term"
    /\ gst[g] # "gone"
    /\ mode' = [mode EXCEPT ![g] = "int"]
    /\ cdl' = [cdl EXCEPT ![g] = IF clock + ABUD(bvSup[g]) < cdl[g] THEN clock + ABUD(bvSup[g]) ELSE cdl[g]]
    /\ gphase' = [gphase EXCEPT ![g] = IF gst[g] = "closing" /\ gphase[g] = "none" THEN "fm" ELSE gphase[g]]
    /\ ms' = [ms EXCEPT ![g] = IF gst[g] = "closing" /\ gphase[g] = "none" THEN "stopping" ELSE ms[g]]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, gst, gv, gBegin, gcalls, rdl, cw, cwDL, cwVal >>

ArmWaiter(g) ==
    /\ Variant = "lateWaiter"
    /\ cw[g] = "pending"
    /\ clock >= sBegin[g]
    /\ cw' = [cw EXCEPT ![g] = "armed"]
    /\ cwVal' = [cwVal EXCEPT ![g] = file]
    /\ cwDL' = [cwDL EXCEPT ![g] = clock + DAEMON(file)]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, ms, rdl >>

SendStop(g) ==
    /\ sst[g] = "stopping"
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
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, mode, cdl, rdl, cw, cwDL, cwVal >>

WriteFailed(g) ==
    /\ sst[g] = "stopping"
    /\ wr[g] = "writing"
    /\ gst[g] = "none"
    /\ wr' = [wr EXCEPT ![g] = "failed"]
    /\ sent' = [sent EXCEPT ![g] = (Variant = "sigtermAfterFail") \/ sent[g]]
    /\ gst' = [gst EXCEPT ![g] = IF Variant = "sigtermAfterFail" THEN "closing" ELSE gst[g]]
    /\ gBegin' = [gBegin EXCEPT ![g] = IF Variant = "sigtermAfterFail" THEN clock ELSE gBegin[g]]
    /\ gcalls' = [gcalls EXCEPT ![g] = IF Variant = "sigtermAfterFail" THEN TRUE ELSE gcalls[g]]
    /\ gv' = [gv EXCEPT ![g] = IF Variant = "sigtermAfterFail" THEN file ELSE gv[g]]
    /\ gphase' = [gphase EXCEPT ![g] = IF Variant = "sigtermAfterFail" /\ mode[g] = "int" THEN "fm" ELSE gphase[g]]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, bvSup, mode, cdl, ms, rdl, cw, cwDL, cwVal >>

GoneNow(g) ==
    /\ gst' = [gst EXCEPT ![g] = "gone"]
    /\ rdl' = [rdl EXCEPT ![g] = clock + REAP]
    /\ cdl' = [cdl EXCEPT ![g] = 0]
    /\ wr' = [wr EXCEPT ![g] = "none"]
    /\ mode' = [mode EXCEPT ![g] = "term"]
    /\ gBegin' = [gBegin EXCEPT ![g] = 0]
    /\ gcalls' = [gcalls EXCEPT ![g] = FALSE]
    /\ gphase' = [gphase EXCEPT ![g] = "none"]

DeadlineKill(g) ==
    /\ DeadlineOverdue(g)
    /\ GoneNow(g)
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, gv, ms, cw, cwDL, cwVal >>

FailKill(g) ==
    /\ FailOverdue(g)
    /\ GoneNow(g)
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, gv, ms, cw, cwDL, cwVal >>

CallEnds(g) ==
    /\ gst[g] = "closing"
    /\ gphase[g] = "none"
    /\ gcalls[g]
    /\ gcalls' = [gcalls EXCEPT ![g] = FALSE]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gphase, ms, rdl, cw, cwDL, cwVal >>

GraceEnd(g) ==
    /\ gst[g] = "closing"
    /\ gphase[g] = "none"
    /\ clock >= gBegin[g] + CG(gv[g])
    /\ gcalls' = [gcalls EXCEPT ![g] = FALSE]
    /\ gphase' = [gphase EXCEPT ![g] = "fm"]
    /\ ms' = [ms EXCEPT ![g] = "stopping"]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, rdl, cw, cwDL, cwVal >>

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
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, gv, cw, cwDL, cwVal >>

GwForcedGone(g) ==
    /\ GwOverdue(g)
    /\ GoneNow(g)
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, gv, ms, cw, cwDL, cwVal >>

Reap(g) ==
    /\ Variant # "noReap"
    /\ gst[g] = "gone"
    /\ ms[g] # "gone"
    /\ ms' = [ms EXCEPT ![g] = "gone"]
    /\ rdl' = [rdl EXCEPT ![g] = 0]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, cw, cwDL, cwVal >>

SupGone(g) ==
    /\ sst[g] = "stopping"
    /\ \/ /\ gst[g] = "gone"
          /\ (Variant = "noReap" \/ ms[g] = "gone")
       \/ (Variant # "waitsForever" /\ clock >= sBegin[g] + SUP(bvSup[g]))
    /\ sst' = [sst EXCEPT ![g] = "gone"]
    /\ cdl' = [cdl EXCEPT ![g] = 0]
    /\ wr' = [wr EXCEPT ![g] = "none"]
    /\ mode' = [mode EXCEPT ![g] = "term"]
    /\ UNCHANGED << file, clock, reqVal, sv, sBegin, sent, bvSup, gst, gv, gBegin, gcalls, gphase, ms, rdl, cw, cwDL, cwVal >>

Give(g) ==
    /\ cw[g] = "armed"
    /\ clock >= cwDL[g]
    /\ cw' = [cw EXCEPT ![g] = "gaveUp"]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, ms, rdl, cwDL, cwVal >>

Done(g) ==
    /\ cw[g] = "armed"
    /\ sst[g] = "gone"
    /\ cw' = [cw EXCEPT ![g] = "done"]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, wr, mode, cdl, gst, gv, gBegin, gcalls, gphase, ms, rdl, cwDL, cwVal >>

GenStep(g) ==
    \/ SelfBegin(g)
    \/ ArmWaiter(g)
    \/ Escalate(g)
    \/ SendStop(g)
    \/ WriteFailed(g)
    \/ DeadlineKill(g)
    \/ FailKill(g)
    \/ CallEnds(g)
    \/ GraceEnd(g)
    \/ FmDone(g)
    \/ GwForcedGone(g)
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
    /\ gst \in [Gens -> {"none", "closing", "gone"}]
    /\ gphase \in [Gens -> {"none", "fm"}]
    /\ ms \in [Gens -> {"alive", "stopping", "gone"}]
    /\ rdl \in [Gens -> 0..(MaxT + REAP)]
    /\ cw \in [Gens -> {"none", "pending", "armed", "gaveUp", "done"}]

SameValues ==
    \A g \in Gens :
        /\ sst[g] # "up" => bvSup[g] = sv[g]
        /\ sent[g] => gv[g] = sv[g]
        /\ cw[g] \in {"armed", "gaveUp", "done"} => cwVal[g] = sv[g]

NoOutlast == \A g \in Gens : cw[g] = "gaveUp" => sst[g] = "gone"

StopEnds == \A g \in Gens : (sst[g] = "stopping") ~> (sst[g] = "gone")

WithinBound ==
    /\ \A g \in Gens : gst[g] = "closing" => clock <= gBegin[g] + GW(gv[g])
    /\ \A g \in Gens : (sst[g] = "stopping" /\ gst[g] # "gone") => clock <= cdl[g]
    /\ \A g \in Gens : (gst[g] = "gone" /\ ms[g] # "gone") => clock <= rdl[g]
    /\ \A g \in Gens : sst[g] = "stopping" => clock <= sBegin[g] + SUP(bvSup[g])

GatewayEndsWithStop == \A g \in Gens : sst[g] = "gone" => gst[g] = "gone"

NoManagedOutlives == \A g \in Gens : sst[g] = "gone" => ms[g] = "gone"

=============================================================================
