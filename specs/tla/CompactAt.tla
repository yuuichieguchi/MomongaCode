------------------------------ MODULE CompactAt ------------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS MaxLevel, MaxSteps, MaxClaims,
          IgnoreAuto, SendOver, HintAnySize, NoProactiveFlag, ForgetLevel

VARIABLES alive, claim, mark, auto, step, pc, wrap, level, levelsDone,
          proDone, opaque, size, ev, proOk, okLevels

vars == <<alive, claim, mark, auto, step, pc, wrap, level, levelsDone,
          proDone, opaque, size, ev, proOk, okLevels>>

Levels == 0..MaxLevel
Marks == {"inside", "ceiling"}
Sizes == IF mark = "ceiling" THEN {"low", "over"} ELSE {"low", "high", "over"}
Fitting == Sizes \ {"over"}
Results == {"ok", "done"} \cup (IF opaque THEN {"retry"} ELSE {})
CompactEvents == {"forced_ok", "forced_retry", "forced_done", "proactive_ok", "proactive_retry", "proactive_done"}
SendEvents == {"sent", "final"}
Min2(a, b) == IF a < b THEN a ELSE b
OpaqueAfter(r) == CASE r = "ok" -> TRUE [] r = "retry" -> FALSE [] OTHER -> opaque
PcAfter(r) == IF r = "done" THEN "done" ELSE "loop"
MayCompact == auto \/ IgnoreAuto
ForcedEvent(r) == CASE r = "ok" -> "forced_ok" [] r = "retry" -> "forced_retry" [] OTHER -> "forced_done"
ProactiveEvent(r) == CASE r = "ok" -> "proactive_ok" [] r = "retry" -> "proactive_retry" [] OTHER -> "proactive_done"

Init ==
    /\ alive = TRUE /\ claim = 1
    /\ mark \in Marks /\ auto \in BOOLEAN
    /\ step = 0 /\ pc = "idle" /\ wrap = FALSE
    /\ level = 0 /\ levelsDone = {} /\ proDone = FALSE
    /\ opaque = FALSE /\ size = "low" /\ ev = "none"
    /\ proOk = 0 /\ okLevels = {}

StartStep ==
    /\ alive /\ pc = "idle" /\ step < MaxSteps
    /\ wrap' \in BOOLEAN
    /\ pc' = "loop" /\ level' = 0 /\ levelsDone' = {} /\ proDone' = FALSE
    /\ proOk' = 0 /\ okLevels' = {} /\ ev' = "start"
    /\ UNCHANGED <<alive, claim, mark, auto, step, opaque, size>>

BuildRejected ==
    /\ alive /\ pc = "loop" /\ opaque
    /\ opaque' = FALSE /\ ev' = "rejected"
    /\ UNCHANGED <<alive, claim, mark, auto, step, pc, wrap, level, levelsDone, proDone, size, proOk, okLevels>>

OverCompact ==
    /\ alive /\ pc = "loop" /\ MayCompact
    /\ (level \notin levelsDone \/ ForgetLevel)
    /\ \E r \in Results :
        /\ size' = "over"
        /\ levelsDone' = IF r = "retry" THEN levelsDone \ {level} ELSE levelsDone \cup {level}
        /\ okLevels' = IF r = "ok" THEN okLevels \cup {level} ELSE okLevels
        /\ opaque' = OpaqueAfter(r) /\ pc' = PcAfter(r)
        /\ ev' = IF level \in okLevels /\ r = "ok" THEN "forced_ok_again" ELSE ForcedEvent(r)
    /\ UNCHANGED <<alive, claim, mark, auto, step, wrap, level, proDone, proOk>>

Raise ==
    /\ alive /\ pc = "loop" /\ level < MaxLevel
    /\ level' = level + 1 /\ size' = "over" /\ ev' = "raise"
    /\ UNCHANGED <<alive, claim, mark, auto, step, pc, wrap, levelsDone, proDone, opaque, proOk, okLevels>>

LastOver ==
    /\ alive /\ pc = "loop" /\ level = MaxLevel
    /\ pc' = "done"
    /\ \/ /\ wrap
          /\ size' = "over" /\ ev' = "stop"
       \/ /\ ~wrap
          /\ \E s \in {"low", "over"} :
                /\ size' = s
                /\ ev' = IF s = "over" THEN "stop" ELSE "final"
       \/ /\ SendOver
          /\ size' = "over" /\ ev' = "sent"
    /\ UNCHANGED <<alive, claim, mark, auto, step, wrap, level, levelsDone, proDone, opaque, proOk, okLevels>>

SendFit ==
    /\ alive /\ pc = "loop"
    /\ \E s \in Fitting : size' = s
    /\ ev' = "sent"
    /\ IF wrap THEN pc' = "done" /\ UNCHANGED step
               ELSE pc' = "idle" /\ step' = step + 1
    /\ UNCHANGED <<alive, claim, mark, auto, wrap, level, levelsDone, proDone, opaque, proOk, okLevels>>

Proactive ==
    /\ alive /\ pc = "loop" /\ MayCompact /\ ~wrap /\ level = 0
    /\ (~proDone \/ NoProactiveFlag)
    /\ \E s \in (IF HintAnySize THEN Fitting ELSE Fitting \cap {"high"}), r \in Results :
        /\ size' = s
        /\ proDone' = (r # "retry")
        /\ proOk' = IF r = "ok" THEN Min2(proOk + 1, 2) ELSE proOk
        /\ opaque' = OpaqueAfter(r) /\ pc' = PcAfter(r)
        /\ ev' = ProactiveEvent(r)
    /\ UNCHANGED <<alive, claim, mark, auto, step, wrap, level, levelsDone, okLevels>>

End ==
    /\ alive /\ pc = "loop"
    /\ pc' = "done" /\ ev' = "ended"
    /\ UNCHANGED <<alive, claim, mark, auto, step, wrap, level, levelsDone, proDone, opaque, size, proOk, okLevels>>

Crash ==
    /\ alive /\ pc # "done" /\ claim < MaxClaims
    /\ alive' = FALSE /\ ev' = "crash"
    /\ UNCHANGED <<claim, mark, auto, step, pc, wrap, level, levelsDone, proDone, opaque, size, proOk, okLevels>>

Reclaim ==
    /\ ~alive
    /\ alive' = TRUE /\ claim' = claim + 1
    /\ mark' \in Marks /\ auto' \in BOOLEAN
    /\ pc' = IF pc = "loop" THEN "idle" ELSE pc
    /\ ev' = "claim"
    /\ UNCHANGED <<step, wrap, level, levelsDone, proDone, opaque, size, proOk, okLevels>>

Done == pc = "done" \/ (alive /\ pc = "idle" /\ step = MaxSteps)

Terminated == Done /\ UNCHANGED vars

LoopStep == BuildRejected \/ OverCompact \/ Raise \/ LastOver \/ SendFit \/ Proactive

Next == StartStep \/ LoopStep \/ End \/ Crash \/ Reclaim \/ Terminated

Spec == Init /\ [][Next]_vars /\ WF_vars(LoopStep) /\ WF_vars(StartStep)

TypeOK ==
    /\ alive \in BOOLEAN /\ claim \in 1..MaxClaims
    /\ mark \in Marks /\ auto \in BOOLEAN
    /\ step \in 0..MaxSteps /\ pc \in {"idle", "loop", "done"}
    /\ wrap \in BOOLEAN /\ level \in Levels /\ levelsDone \subseteq Levels
    /\ proDone \in BOOLEAN /\ opaque \in BOOLEAN
    /\ size \in {"low", "high", "over"} /\ proOk \in 0..2 /\ okLevels \subseteq Levels

NoCompactionWithoutAuto == ev \in CompactEvents \cup {"forced_ok_again"} => auto
SentFits == ev \in SendEvents => size # "over"
ProactiveOnlyAboveMark == ev \in {"proactive_ok", "proactive_retry", "proactive_done"} => (size = "high" /\ level = 0 /\ ~wrap)
NoProactiveAtCeiling == mark = "ceiling" => ev \notin {"proactive_ok", "proactive_retry", "proactive_done"}
ProactiveOncePerStep == proOk <= 1
ForcedOncePerLevel == ev # "forced_ok_again"

LoopEnds == [](pc = "loop" => <>(pc # "loop" \/ ~alive))
=============================================================================
