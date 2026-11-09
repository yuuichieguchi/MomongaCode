---------------------------- MODULE StopProtocol ----------------------------
EXTENDS Naturals

CONSTANTS Gens, Vals, MaxT, Variant

ASSUME Variant \in {"decided", "mixed", "noMessage", "lateWaiter", "noDeadline", "waitsForever"}
ASSUME MaxT \in Nat
ASSUME Gens # {}
ASSUME Vals \subseteq Nat \ {0}

FmBound == 2

CG(v) == v
GW(v) == CG(v) + FmBound
SUP(v) == GW(v) + 1
DAEMON(v) == SUP(v) + 1

MaxVal == CHOOSE v \in Vals : \A w \in Vals : w <= v

VARIABLES file, clock, reqVal,
          sst, sv, sBegin, sent, bvSup,
          gst, gv, gBegin, gcalls, gphase,
          cw, cwDL, cwVal

vars == << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, gst, gv, gBegin, gcalls, gphase, cw, cwDL, cwVal >>

ProtoVars == << sst, sv, sBegin, sent, bvSup, gst, gv, gBegin, gcalls, gphase, cw, cwDL, cwVal >>

Init ==
    /\ file \in Vals
    /\ clock = 0
    /\ reqVal = 0
    /\ sst = [g \in Gens |-> "up"]
    /\ sv = [g \in Gens |-> 0]
    /\ sBegin = [g \in Gens |-> 0]
    /\ sent = [g \in Gens |-> FALSE]
    /\ bvSup = [g \in Gens |-> 0]
    /\ gst = [g \in Gens |-> "none"]
    /\ gv = [g \in Gens |-> 0]
    /\ gBegin = [g \in Gens |-> 0]
    /\ gcalls = [g \in Gens |-> FALSE]
    /\ gphase = [g \in Gens |-> "none"]
    /\ cw = [g \in Gens |-> "none"]
    /\ cwDL = [g \in Gens |-> 0]
    /\ cwVal = [g \in Gens |-> 0]

SupOverdue(g) == Variant # "waitsForever" /\ sst[g] = "stopping" /\ clock >= sBegin[g] + SUP(bvSup[g])
SendOverdue(g) == sst[g] = "stopping" /\ ~sent[g] /\ clock >= sBegin[g] + 1
GraceOverdue(g) == gst[g] = "closing" /\ gphase[g] = "none" /\ clock >= gBegin[g] + CG(gv[g])
GwOverdue(g) == Variant \notin {"noDeadline", "waitsForever"} /\ gst[g] = "closing" /\ clock >= gBegin[g] + GW(gv[g])
WaiterOverdue(g) == cw[g] = "armed" /\ clock >= cwDL[g]

Overdue == \E g \in Gens : SupOverdue(g) \/ SendOverdue(g) \/ GraceOverdue(g) \/ GwOverdue(g) \/ WaiterOverdue(g)

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
    /\ cw' = [g \in Gens |-> IF Variant = "lateWaiter" THEN "pending" ELSE "armed"]
    /\ cwVal' = [g \in Gens |-> IF Variant = "lateWaiter" THEN 0 ELSE file]
    /\ cwDL' = [g \in Gens |-> IF Variant = "lateWaiter" THEN 0 ELSE clock + DAEMON(file)]
    /\ UNCHANGED << file, clock, sent, gst, gv, gBegin, gcalls, gphase >>

SelfBegin(g) ==
    /\ sst[g] = "up"
    /\ clock + DAEMON(MaxVal) <= MaxT
    /\ sst' = [sst EXCEPT ![g] = "stopping"]
    /\ sv' = [sv EXCEPT ![g] = file]
    /\ sBegin' = [sBegin EXCEPT ![g] = clock]
    /\ bvSup' = [bvSup EXCEPT ![g] = file]
    /\ UNCHANGED << file, clock, reqVal, sent, gst, gv, gBegin, gcalls, gphase, cw, cwDL, cwVal >>

ArmWaiter(g) ==
    /\ Variant = "lateWaiter"
    /\ cw[g] = "pending"
    /\ clock >= sBegin[g]
    /\ cw' = [cw EXCEPT ![g] = "armed"]
    /\ cwVal' = [cwVal EXCEPT ![g] = file]
    /\ cwDL' = [cwDL EXCEPT ![g] = clock + DAEMON(file)]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, gst, gv, gBegin, gcalls, gphase >>

SendStop(g) ==
    /\ sst[g] = "stopping"
    /\ ~sent[g]
    /\ gst[g] = "none"
    /\ sent' = [sent EXCEPT ![g] = TRUE]
    /\ gst' = [gst EXCEPT ![g] = "closing"]
    /\ gBegin' = [gBegin EXCEPT ![g] = clock]
    /\ gcalls' = [gcalls EXCEPT ![g] = TRUE]
    /\ gphase' = [gphase EXCEPT ![g] = "none"]
    /\ gv' = [gv EXCEPT ![g] = IF Variant = "noMessage" THEN file ELSE sv[g]]
    /\ bvSup' = [bvSup EXCEPT ![g] = IF Variant = "mixed" THEN file ELSE bvSup[g]]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, cw, cwDL, cwVal >>

CallEnds(g) ==
    /\ gst[g] = "closing"
    /\ gphase[g] = "none"
    /\ gcalls[g]
    /\ gcalls' = [gcalls EXCEPT ![g] = FALSE]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, gst, gv, gBegin, gphase, cw, cwDL, cwVal >>

GraceEnd(g) ==
    /\ gst[g] = "closing"
    /\ gphase[g] = "none"
    /\ clock >= gBegin[g] + CG(gv[g])
    /\ gcalls' = [gcalls EXCEPT ![g] = FALSE]
    /\ gphase' = [gphase EXCEPT ![g] = "fm"]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, gst, gv, gBegin, cw, cwDL, cwVal >>

FmDone(g) ==
    /\ Variant # "waitsForever"
    /\ gst[g] = "closing"
    /\ gphase[g] = "fm"
    /\ gst' = [gst EXCEPT ![g] = "gone"]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, gv, gBegin, gcalls, gphase, cw, cwDL, cwVal >>

GwForcedGone(g) ==
    /\ GwOverdue(g)
    /\ gst' = [gst EXCEPT ![g] = "gone"]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, gv, gBegin, gcalls, gphase, cw, cwDL, cwVal >>

SupGone(g) ==
    /\ sst[g] = "stopping"
    /\ ((sent[g] /\ gst[g] = "gone") \/ (Variant # "waitsForever" /\ clock >= sBegin[g] + SUP(bvSup[g])))
    /\ sst' = [sst EXCEPT ![g] = "gone"]
    /\ UNCHANGED << file, clock, reqVal, sv, sBegin, sent, bvSup, gst, gv, gBegin, gcalls, gphase, cw, cwDL, cwVal >>

Give(g) ==
    /\ cw[g] = "armed"
    /\ clock >= cwDL[g]
    /\ cw' = [cw EXCEPT ![g] = "gaveUp"]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, gst, gv, gBegin, gcalls, gphase, cwDL, cwVal >>

Done(g) ==
    /\ cw[g] = "armed"
    /\ sst[g] = "gone"
    /\ cw' = [cw EXCEPT ![g] = "done"]
    /\ UNCHANGED << file, clock, reqVal, sst, sv, sBegin, sent, bvSup, gst, gv, gBegin, gcalls, gphase, cwDL, cwVal >>

GenStep(g) ==
    \/ SelfBegin(g)
    \/ ArmWaiter(g)
    \/ SendStop(g)
    \/ CallEnds(g)
    \/ GraceEnd(g)
    \/ FmDone(g)
    \/ GwForcedGone(g)
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
    /\ gst \in [Gens -> {"none", "closing", "gone"}]
    /\ gphase \in [Gens -> {"none", "fm"}]
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
    /\ \A g \in Gens : sst[g] = "stopping" => clock <= sBegin[g] + SUP(bvSup[g])

=============================================================================
