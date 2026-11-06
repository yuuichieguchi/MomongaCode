--------------------------- MODULE OutputDrain ---------------------------
EXTENDS Naturals

CONSTANTS PipeCap, Ceiling, CeilingOn, BoundOn, Variant

ASSUME Variant \in {"decided", "fixedFromExit", "silentRelease", "noPhase", "noConfirm"}
ASSUME PipeCap \in Nat \ {0}
ASSUME Ceiling \in Nat \ {0}
ASSUME CeilingOn \in BOOLEAN
ASSUME BoundOn \in BOOLEAN

VARIABLES leader, known, outside, phase, view, reapResult, quiet, firing, stalled, stalls, buffered, resRead, released, releaseKind, noted, leftUnread, cutBuffered, cutStalled, lost

vars == <<leader, known, outside, phase, view, reapResult, quiet, firing, stalled, stalls, buffered, resRead, released, releaseKind, noted, leftUnread, cutBuffered, cutStalled, lost>>

TypeOK ==
    /\ leader \in {"live", "exited"}
    /\ known \in BOOLEAN
    /\ outside \in BOOLEAN
    /\ phase \in {"run", "identify", "reap", "drain"}
    /\ view \in {"unread", "free", "held", "unidentified", "unknown"}
    /\ reapResult \in {"none", "skipped", "killed", "unconfirmed"}
    /\ quiet \in BOOLEAN
    /\ firing \in BOOLEAN
    /\ stalled \in BOOLEAN
    /\ stalls \in 0..1
    /\ buffered \in 0..PipeCap
    /\ resRead \in 0..Ceiling
    /\ released \in BOOLEAN
    /\ releaseKind \in {"none", "eof", "idle", "ceiling", "bound", "fixed"}
    /\ noted \in BOOLEAN
    /\ leftUnread \in BOOLEAN
    /\ cutBuffered \in BOOLEAN
    /\ cutStalled \in BOOLEAN
    /\ lost \in BOOLEAN

Init ==
    /\ leader = "live"
    /\ known \in BOOLEAN
    /\ outside \in BOOLEAN
    /\ phase = "run"
    /\ view = "unread"
    /\ reapResult = "none"
    /\ quiet = FALSE
    /\ firing = FALSE
    /\ stalled = FALSE
    /\ stalls = 0
    /\ buffered = 0
    /\ resRead = 0
    /\ released = FALSE
    /\ releaseKind = "none"
    /\ noted = FALSE
    /\ leftUnread = FALSE
    /\ cutBuffered = FALSE
    /\ cutStalled = FALSE
    /\ lost = FALSE

PipeOpen == leader = "live" \/ known \/ outside

PhaseOneDone == phase = "drain"

Write ==
    /\ PipeOpen
    /\ IF released
       THEN /\ lost' = TRUE
            /\ UNCHANGED buffered
       ELSE /\ buffered < PipeCap
            /\ buffered' = buffered + 1
            /\ UNCHANGED lost
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, quiet, firing, stalled, stalls, resRead, released, releaseKind, noted, leftUnread, cutBuffered, cutStalled>>

Read ==
    /\ ~released
    /\ ~stalled
    /\ buffered > 0
    /\ buffered' = buffered - 1
    /\ quiet' = FALSE
    /\ firing' = FALSE
    /\ resRead' = IF PhaseOneDone THEN IF resRead < Ceiling THEN resRead + 1 ELSE resRead ELSE resRead
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, stalled, stalls, released, releaseKind, noted, leftUnread, cutBuffered, cutStalled, lost>>

Tick ==
    /\ ~quiet
    /\ quiet' = TRUE
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, firing, stalled, stalls, buffered, resRead, released, releaseKind, noted, leftUnread, cutBuffered, cutStalled, lost>>

Stall ==
    /\ stalls = 0
    /\ ~stalled
    /\ stalled' = TRUE
    /\ stalls' = 1
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, quiet, firing, buffered, resRead, released, releaseKind, noted, leftUnread, cutBuffered, cutStalled, lost>>

Unstall ==
    /\ stalled
    /\ stalled' = FALSE
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, quiet, firing, stalls, buffered, resRead, released, releaseKind, noted, leftUnread, cutBuffered, cutStalled, lost>>

LeaderExits ==
    /\ leader = "live"
    /\ leader' = "exited"
    /\ phase' = "identify"
    /\ UNCHANGED <<known, outside, view, reapResult, quiet, firing, stalled, stalls, buffered, resRead, released, releaseKind, noted, leftUnread, cutBuffered, cutStalled, lost>>

KnownExits ==
    /\ known
    /\ known' = FALSE
    /\ UNCHANGED <<leader, outside, phase, view, reapResult, quiet, firing, stalled, stalls, buffered, resRead, released, releaseKind, noted, leftUnread, cutBuffered, cutStalled, lost>>

OutsideCloses ==
    /\ outside
    /\ outside' = FALSE
    /\ UNCHANGED <<leader, known, phase, view, reapResult, quiet, firing, stalled, stalls, buffered, resRead, released, releaseKind, noted, leftUnread, cutBuffered, cutStalled, lost>>

Identify ==
    /\ phase = "identify"
    /\ \/ /\ known
          /\ view' \in {"held", "unidentified", "unknown"}
       \/ /\ ~known
          /\ view' \in {"free", "unknown"}
    /\ phase' = "reap"
    /\ UNCHANGED <<leader, known, outside, reapResult, quiet, firing, stalled, stalls, buffered, resRead, released, releaseKind, noted, leftUnread, cutBuffered, cutStalled, lost>>

Reap ==
    /\ phase = "reap"
    /\ phase' = "drain"
    /\ \/ /\ view = "free"
          /\ reapResult' = "skipped"
          /\ UNCHANGED known
       \/ /\ view \in {"unidentified", "unknown"}
          /\ reapResult' = IF view = "unknown" THEN "none" ELSE "unconfirmed"
          /\ UNCHANGED known
       \/ /\ view = "held"
          /\ \/ /\ reapResult' = "killed"
                /\ known' = FALSE
             \/ /\ reapResult' = "unconfirmed"
                /\ UNCHANGED known
    /\ UNCHANGED <<leader, outside, view, quiet, firing, stalled, stalls, buffered, resRead, released, releaseKind, noted, leftUnread, cutBuffered, cutStalled, lost>>

Release(kind, note) ==
    /\ ~released
    /\ released' = TRUE
    /\ releaseKind' = kind
    /\ noted' = note
    /\ leftUnread' = (kind # "bound" /\ known /\ ~PhaseOneDone)
    /\ cutBuffered' = (kind \in {"idle", "fixed"} /\ buffered > 0)
    /\ cutStalled' = stalled
    /\ lost' = (buffered > 0)

ReleaseOnEof ==
    /\ ~PipeOpen
    /\ buffered = 0
    /\ Release("eof", FALSE)
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, quiet, firing, stalled, stalls, buffered, resRead>>

TimerMayFire ==
    /\ ~released
    /\ quiet
    /\ PipeOpen
    /\ \/ PhaseOneDone
       \/ (Variant = "noPhase" /\ leader = "exited")

Fire ==
    /\ TimerMayFire
    /\ ~firing
    /\ IF Variant = "noConfirm"
       THEN /\ Release("idle", TRUE)
            /\ UNCHANGED firing
       ELSE /\ firing' = TRUE
            /\ UNCHANGED <<released, releaseKind, noted, leftUnread, cutBuffered, cutStalled, lost>>
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, quiet, stalled, stalls, buffered, resRead>>

Confirm ==
    /\ firing
    /\ ~released
    /\ buffered = 0
    /\ Release("idle", Variant # "silentRelease")
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, quiet, firing, stalled, stalls, buffered, resRead>>

ConfirmBlind ==
    /\ firing
    /\ ~released
    /\ buffered > 0
    /\ stalled
    /\ Release("idle", Variant # "silentRelease")
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, quiet, firing, stalled, stalls, buffered, resRead>>

Ceil ==
    /\ CeilingOn
    /\ PhaseOneDone
    /\ resRead >= Ceiling
    /\ Release("ceiling", TRUE)
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, quiet, firing, stalled, stalls, buffered, resRead>>

OwnerBound ==
    /\ BoundOn
    /\ leader = "exited"
    /\ Release("bound", TRUE)
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, quiet, firing, stalled, stalls, buffered, resRead>>

FixedDeadline ==
    /\ Variant = "fixedFromExit"
    /\ leader = "exited"
    /\ Release("fixed", FALSE)
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, quiet, firing, stalled, stalls, buffered, resRead>>

Settled ==
    /\ released
    /\ UNCHANGED vars

Next ==
    \/ Write
    \/ Read
    \/ Tick
    \/ Stall
    \/ Unstall
    \/ LeaderExits
    \/ KnownExits
    \/ OutsideCloses
    \/ Identify
    \/ Reap
    \/ ReleaseOnEof
    \/ Fire
    \/ Confirm
    \/ ConfirmBlind
    \/ Ceil
    \/ OwnerBound
    \/ FixedDeadline
    \/ Settled

Fairness ==
    /\ WF_vars(Read)
    /\ WF_vars(Tick)
    /\ WF_vars(Unstall)
    /\ WF_vars(LeaderExits)
    /\ WF_vars(Identify)
    /\ WF_vars(Reap)
    /\ WF_vars(ReleaseOnEof)
    /\ WF_vars(Fire)
    /\ WF_vars(Confirm)
    /\ WF_vars(ConfirmBlind)
    /\ WF_vars(Ceil)
    /\ WF_vars(OwnerBound)

Spec == Init /\ [][Next]_vars /\ Fairness

NoKnownWriterLeftUnread == ~leftUnread

ByteLostImpliesNote == lost => noted

NonEofReleaseIsNoted == (released /\ releaseKind # "eof") => noted

NoLossWithoutStall == cutBuffered => cutStalled

AlwaysReleased == <>released

=============================================================================
