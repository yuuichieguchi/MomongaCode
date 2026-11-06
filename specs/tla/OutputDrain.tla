--------------------------- MODULE OutputDrain ---------------------------
EXTENDS Naturals

CONSTANTS MaxBytes, Variant

ASSUME Variant \in {"decided", "fixedFromExit", "silentRelease", "noPhase"}
ASSUME MaxBytes \in Nat \ {0}

VARIABLES leader, known, outside, phase, view, reapResult, quiet, buffered, read, written, released, releaseKind, noted, leftUnread

vars == <<leader, known, outside, phase, view, reapResult, quiet, buffered, read, written, released, releaseKind, noted, leftUnread>>

TypeOK ==
    /\ leader \in {"live", "exited"}
    /\ known \in BOOLEAN
    /\ outside \in BOOLEAN
    /\ phase \in {"run", "identify", "reap", "drain"}
    /\ view \in {"unread", "free", "held", "unidentified"}
    /\ reapResult \in {"none", "skipped", "killed", "unconfirmed"}
    /\ quiet \in BOOLEAN
    /\ buffered \in 0..MaxBytes
    /\ read \in 0..MaxBytes
    /\ written \in 0..MaxBytes
    /\ released \in BOOLEAN
    /\ releaseKind \in {"none", "eof", "idle", "fixed"}
    /\ noted \in BOOLEAN
    /\ leftUnread \in BOOLEAN

Init ==
    /\ leader = "live"
    /\ known \in BOOLEAN
    /\ outside \in BOOLEAN
    /\ phase = "run"
    /\ view = "unread"
    /\ reapResult = "none"
    /\ quiet = FALSE
    /\ buffered = 0
    /\ read = 0
    /\ written = 0
    /\ released = FALSE
    /\ releaseKind = "none"
    /\ noted = FALSE
    /\ leftUnread = FALSE

PipeOpen == leader = "live" \/ known \/ outside

PhaseOneDone == phase = "drain"

Write ==
    /\ PipeOpen
    /\ written < MaxBytes
    /\ written' = written + 1
    /\ buffered' = IF released THEN buffered ELSE buffered + 1
    /\ quiet' = FALSE
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, read, released, releaseKind, noted, leftUnread>>

Read ==
    /\ ~released
    /\ buffered > 0
    /\ buffered' = buffered - 1
    /\ read' = read + 1
    /\ quiet' = FALSE
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, written, released, releaseKind, noted, leftUnread>>

Tick ==
    /\ ~quiet
    /\ quiet' = TRUE
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, buffered, read, written, released, releaseKind, noted, leftUnread>>

LeaderExits ==
    /\ leader = "live"
    /\ leader' = "exited"
    /\ phase' = "identify"
    /\ UNCHANGED <<known, outside, view, reapResult, quiet, buffered, read, written, released, releaseKind, noted, leftUnread>>

KnownExits ==
    /\ known
    /\ known' = FALSE
    /\ UNCHANGED <<leader, outside, phase, view, reapResult, quiet, buffered, read, written, released, releaseKind, noted, leftUnread>>

OutsideCloses ==
    /\ outside
    /\ outside' = FALSE
    /\ UNCHANGED <<leader, known, phase, view, reapResult, quiet, buffered, read, written, released, releaseKind, noted, leftUnread>>

Identify ==
    /\ phase = "identify"
    /\ \/ /\ known
          /\ view' \in {"held", "unidentified"}
       \/ /\ ~known
          /\ view' = "free"
    /\ phase' = "reap"
    /\ UNCHANGED <<leader, known, outside, reapResult, quiet, buffered, read, written, released, releaseKind, noted, leftUnread>>

Reap ==
    /\ phase = "reap"
    /\ phase' = "drain"
    /\ \/ /\ view = "free"
          /\ reapResult' = "skipped"
          /\ UNCHANGED known
       \/ /\ view = "unidentified"
          /\ reapResult' = "unconfirmed"
          /\ UNCHANGED known
       \/ /\ view = "held"
          /\ \/ /\ reapResult' = "killed"
                /\ known' = FALSE
             \/ /\ reapResult' = "unconfirmed"
                /\ UNCHANGED known
    /\ UNCHANGED <<leader, outside, view, quiet, buffered, read, written, released, releaseKind, noted, leftUnread>>

Release(kind, note) ==
    /\ ~released
    /\ released' = TRUE
    /\ releaseKind' = kind
    /\ noted' = note
    /\ leftUnread' = (known /\ reapResult = "none")

ReleaseOnEof ==
    /\ ~PipeOpen
    /\ buffered = 0
    /\ Release("eof", FALSE)
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, quiet, buffered, read, written>>

IdleGap ==
    /\ \/ PhaseOneDone
       \/ (Variant = "noPhase" /\ leader = "exited")
    /\ PipeOpen
    /\ quiet
    /\ buffered = 0
    /\ Release("idle", Variant # "silentRelease")
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, quiet, buffered, read, written>>

FixedDeadline ==
    /\ Variant = "fixedFromExit"
    /\ leader = "exited"
    /\ Release("fixed", FALSE)
    /\ UNCHANGED <<leader, known, outside, phase, view, reapResult, quiet, buffered, read, written>>

Settled ==
    /\ released
    /\ \/ ~PipeOpen
       \/ written = MaxBytes
    /\ UNCHANGED vars

Next ==
    \/ Write
    \/ Read
    \/ Tick
    \/ LeaderExits
    \/ KnownExits
    \/ OutsideCloses
    \/ Identify
    \/ Reap
    \/ ReleaseOnEof
    \/ IdleGap
    \/ FixedDeadline
    \/ Settled

Fairness ==
    /\ WF_vars(Read)
    /\ WF_vars(Tick)
    /\ WF_vars(LeaderExits)
    /\ WF_vars(Identify)
    /\ WF_vars(Reap)
    /\ WF_vars(ReleaseOnEof)
    /\ WF_vars(IdleGap)
    /\ WF_vars(Write)

Spec == Init /\ [][Next]_vars /\ Fairness

NoKnownWriterLeftUnread == ~leftUnread

ByteLostImpliesNote == (released /\ written > read) => noted

AlwaysReleased == <>released

=============================================================================
