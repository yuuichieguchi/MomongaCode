---------------------------- MODULE TerminalModes ----------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS AnswerSets, AltReplies, Screens, MaxFocus, Variant

ASSUME Variant \in {"correct", "skipRestoreOnFail", "hintOnUnknown", "mouseAtStart", "waitForDa1", "replyAsKey", "leaveUnknown", "replyToOther"}
ASSUME MaxFocus \in Nat

Modes == {"alt-screen", "mouse", "bracketed-paste", "focus", "kitty-keys", "modify-other-keys", "title"}
NegStates == <<"unknown", "plain", "modify-other-keys", "kitty", "proven">>
QueryBatch == <<"kitty", "1049", "1006", "2004", "2026", "osc11", "da1">>
Queries == {QueryBatch[i] : i \in 1..Len(QueryBatch)}

ASSUME \A a \in AnswerSets : a \subseteq Queries
ASSUME AltReplies \subseteq {"set", "refused"}
ASSUME Screens \subseteq {"fullscreen", "scrollback"}

NegIndex(n) == CHOOSE i \in 1..Len(NegStates) : NegStates[i] = n
Forward(cur, cand) == IF NegIndex(cand) > NegIndex(cur) THEN cand ELSE cur

Hint(n) == IF n \in {"kitty", "proven"} \/ (Variant = "hintOnUnknown" /\ n = "unknown") THEN "shift+enter" ELSE "ctrl+j"

Phases == {"before", "running", "draining", "suspended", "lent", "released", "handover", "gone"}

VARIABLES phase, term, enabled, raw, saved, screen, neg, answers, altReply, pending, answered,
          ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, badLeave,
          leaving, boundEnded, lastResort

DrainVars == <<leaving, boundEnded, lastResort>>

vars == <<phase, term, enabled, raw, saved, screen, neg, answers, altReply, pending, answered,
          ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, badLeave, DrainVars>>

TypeOK ==
    /\ phase \in Phases
    /\ term \subseteq Modes
    /\ enabled \subseteq Modes
    /\ raw \in BOOLEAN
    /\ saved \subseteq Modes
    /\ screen \in {"fullscreen", "scrollback"}
    /\ neg \in {NegStates[i] : i \in 1..Len(NegStates)}
    /\ answers \in AnswerSets
    /\ altReply \in AltReplies
    /\ pending \in Seq(Queries)
    /\ answered \subseteq Queries
    /\ ended \in BOOLEAN
    /\ mouseAnswered \in BOOLEAN
    /\ refusalApplied \in BOOLEAN
    /\ hooked \in BOOLEAN
    /\ inputOn \in BOOLEAN
    /\ focusQueries \in 0..MaxFocus
    /\ appTyped \in BOOLEAN
    /\ othersTyped \in BOOLEAN
    /\ badLeave \in BOOLEAN
    /\ leaving \in {"none", "suspend", "lend", "exit"}
    /\ boundEnded \in BOOLEAN
    /\ lastResort \in BOOLEAN

Init ==
    /\ phase = "before"
    /\ term = {}
    /\ enabled = {}
    /\ raw = FALSE
    /\ saved = {}
    /\ screen \in Screens
    /\ neg = "unknown"
    /\ answers \in AnswerSets
    /\ altReply \in AltReplies
    /\ pending = <<>>
    /\ answered = {}
    /\ ended = FALSE
    /\ mouseAnswered = FALSE
    /\ refusalApplied = FALSE
    /\ hooked = FALSE
    /\ inputOn = FALSE
    /\ focusQueries = 0
    /\ appTyped = FALSE
    /\ othersTyped = FALSE
    /\ badLeave = FALSE
    /\ leaving = "none"
    /\ boundEnded = FALSE
    /\ lastResort = FALSE

MouseAllowed(s, answeredMouse) == s = "fullscreen" /\ answeredMouse

Answered(seq) == SelectSeq(seq, LAMBDA q : q \in answers)

Start ==
    /\ phase = "before"
    /\ LET first == (IF screen = "fullscreen" THEN {"alt-screen", "bracketed-paste"} ELSE {"bracketed-paste"})
                    \cup {"kitty-keys"} \cup (IF Variant = "mouseAtStart" THEN {"mouse"} ELSE {})
       IN /\ term' = first
          /\ enabled' = first
    /\ phase' = "running"
    /\ hooked' = TRUE
    /\ raw' = TRUE
    /\ inputOn' = (Variant # "waitForDa1")
    /\ pending' = Answered(QueryBatch)
    /\ UNCHANGED <<saved, screen, neg, answers, altReply, answered, ended, mouseAnswered, refusalApplied, focusQueries, appTyped, othersTyped, badLeave, DrainVars>>

Restore ==
    LET left == IF Variant = "leaveUnknown" THEN Modes ELSE enabled
    IN /\ term' = term \ left
       /\ enabled' = {}
       /\ raw' = FALSE
       /\ badLeave' = (badLeave \/ ~(left \subseteq term))

Absorb(q) ==
    LET ans == answered \cup {q}
        endedNow == ended \/ q = "da1"
        n1 == IF q = "kitty" THEN Forward(neg, "kitty") ELSE IF q = "da1" THEN Forward(neg, "plain") ELSE neg
        mok == neg # "plain" /\ n1 = "plain"
        n2 == IF mok THEN Forward(n1, "modify-other-keys") ELSE n1
        mAns == mouseAnswered \/ q = "1006"
        refuse == screen = "fullscreen" /\ ~refusalApplied /\ endedNow /\ "1049" \in ans /\ altReply = "refused"
        scr == IF refuse THEN "scrollback" ELSE screen
        withMok == enabled \cup (IF mok THEN {"modify-other-keys"} ELSE {})
        withMouse == withMok \cup (IF MouseAllowed(screen, mAns) THEN {"mouse"} ELSE {})
        en == IF refuse THEN withMouse \ {"mouse", "alt-screen"} ELSE withMouse
    IN /\ answered' = ans
       /\ ended' = endedNow
       /\ neg' = n2
       /\ mouseAnswered' = mAns
       /\ refusalApplied' = (refusalApplied \/ refuse)
       /\ screen' = scr
       /\ enabled' = en
       /\ term' = (term \cup (withMouse \ enabled)) \ (IF refuse THEN {"mouse", "alt-screen"} ELSE {})
       /\ inputOn' = (inputOn \/ q = "da1")

ReplyToApp ==
    /\ pending # <<>>
    /\ phase = "running"
    /\ Absorb(Head(pending))
    /\ pending' = Tail(pending)
    /\ appTyped' = (appTyped \/ Variant = "replyAsKey")
    /\ UNCHANGED <<phase, raw, saved, answers, altReply, hooked, focusQueries, othersTyped, badLeave, DrainVars>>

ReplyToSuccessor ==
    /\ pending # <<>>
    /\ phase = "handover"
    /\ pending' = Tail(pending)
    /\ UNCHANGED <<phase, term, enabled, raw, saved, screen, neg, answers, altReply, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, badLeave, DrainVars>>

ReplyToOther ==
    /\ pending # <<>>
    /\ phase \in {"suspended", "lent", "gone"}
    /\ pending' = Tail(pending)
    /\ othersTyped' = TRUE
    /\ UNCHANGED <<phase, term, enabled, raw, saved, screen, neg, answers, altReply, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, badLeave, DrainVars>>

Proof ==
    /\ phase = "running"
    /\ inputOn
    /\ neg' = Forward(neg, "proven")
    /\ UNCHANGED <<phase, term, enabled, raw, saved, screen, answers, altReply, pending, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, badLeave, DrainVars>>

EnableFocus ==
    /\ phase = "running"
    /\ "focus" \notin enabled
    /\ enabled' = enabled \cup {"focus"}
    /\ term' = term \cup {"focus"}
    /\ UNCHANGED <<phase, raw, saved, screen, neg, answers, altReply, pending, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, badLeave, DrainVars>>

DisableFocus ==
    /\ phase = "running"
    /\ "focus" \in enabled
    /\ enabled' = enabled \ {"focus"}
    /\ term' = term \ {"focus"}
    /\ UNCHANGED <<phase, raw, saved, screen, neg, answers, altReply, pending, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, badLeave, DrainVars>>

FocusIn ==
    /\ phase = "running"
    /\ "focus" \in enabled
    /\ focusQueries < MaxFocus
    /\ focusQueries' = focusQueries + 1
    /\ pending' = pending \o Answered(<<"osc11", "da1">>)
    /\ UNCHANGED <<phase, term, enabled, raw, saved, screen, neg, answers, altReply, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, appTyped, othersTyped, badLeave, DrainVars>>

SetTitle ==
    /\ phase = "running"
    /\ "title" \notin enabled
    /\ enabled' = enabled \cup {"title"}
    /\ term' = term \cup {"title"}
    /\ UNCHANGED <<phase, raw, saved, screen, neg, answers, altReply, pending, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, badLeave, DrainVars>>

Switch(s) ==
    /\ phase = "running"
    /\ screen # s
    /\ screen' = s
    /\ IF s = "scrollback"
          THEN /\ enabled' = enabled \ {"mouse", "alt-screen"}
               /\ term' = term \ {"mouse", "alt-screen"}
          ELSE LET add == {"alt-screen"} \cup (IF MouseAllowed(s, mouseAnswered) THEN {"mouse"} ELSE {})
               IN /\ enabled' = enabled \cup add
                  /\ term' = term \cup add
    /\ UNCHANGED <<phase, raw, saved, neg, answers, altReply, pending, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, badLeave, DrainVars>>

LeaveReady(kind) ==
    \/ phase = "running" /\ (pending = <<>> \/ Variant = "replyToOther")
    \/ phase = "draining" /\ leaving = kind /\ (pending = <<>> \/ boundEnded)

Drain(kind) ==
    /\ phase = "running"
    /\ hooked
    /\ Variant # "replyToOther"
    /\ pending # <<>>
    /\ phase' = "draining"
    /\ leaving' = kind
    /\ UNCHANGED <<term, enabled, raw, saved, screen, neg, answers, altReply, pending, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, badLeave, boundEnded, lastResort>>

ReplyDrained ==
    /\ phase = "draining"
    /\ pending # <<>>
    /\ pending' = Tail(pending)
    /\ UNCHANGED <<phase, term, enabled, raw, saved, screen, neg, answers, altReply, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, badLeave, DrainVars>>

DrainBound ==
    /\ phase = "draining"
    /\ "da1" \notin answers
    /\ ~boundEnded
    /\ boundEnded' = TRUE
    /\ UNCHANGED <<phase, term, enabled, raw, saved, screen, neg, answers, altReply, pending, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, badLeave, leaving, lastResort>>

Suspend ==
    /\ LeaveReady("suspend")
    /\ saved' = enabled
    /\ Restore
    /\ phase' = "suspended"
    /\ leaving' = "none"
    /\ UNCHANGED <<screen, neg, answers, altReply, pending, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, boundEnded, lastResort>>

Continue ==
    /\ phase = "suspended"
    /\ enabled' = enabled \cup saved
    /\ term' = term \cup saved
    /\ raw' = TRUE
    /\ phase' = "running"
    /\ UNCHANGED <<saved, screen, neg, answers, altReply, pending, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, badLeave, DrainVars>>

Lend ==
    /\ LeaveReady("lend")
    /\ saved' = enabled
    /\ Restore
    /\ phase' = "lent"
    /\ leaving' = "none"
    /\ UNCHANGED <<screen, neg, answers, altReply, pending, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, boundEnded, lastResort>>

TakeBack ==
    /\ phase = "lent"
    /\ hooked
    /\ enabled' = enabled \cup saved
    /\ term' = term \cup saved
    /\ raw' = TRUE
    /\ phase' = "running"
    /\ UNCHANGED <<saved, screen, neg, answers, altReply, pending, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, badLeave, DrainVars>>

Release ==
    /\ phase = "running"
    /\ phase' = "released"
    /\ hooked' = FALSE
    /\ UNCHANGED <<term, enabled, raw, saved, screen, neg, answers, altReply, pending, answered, ended, mouseAnswered, refusalApplied, inputOn, focusQueries, appTyped, othersTyped, badLeave, DrainVars>>

Handover ==
    /\ phase = "released"
    /\ phase' = "handover"
    /\ UNCHANGED <<term, enabled, raw, saved, screen, neg, answers, altReply, pending, answered, ended, mouseAnswered, refusalApplied, hooked, inputOn, focusQueries, appTyped, othersTyped, badLeave, DrainVars>>

Adopt ==
    /\ phase = "released"
    /\ phase' = "running"
    /\ hooked' = TRUE
    /\ raw' = TRUE
    /\ mouseAnswered' = ("mouse" \in enabled)
    /\ UNCHANGED <<term, enabled, saved, screen, neg, answers, altReply, pending, answered, ended, refusalApplied, inputOn, focusQueries, appTyped, othersTyped, badLeave, DrainVars>>

ExitWithRestore(ready, resort) ==
    /\ hooked
    /\ ready
    /\ Restore
    /\ phase' = "gone"
    /\ hooked' = FALSE
    /\ leaving' = "none"
    /\ lastResort' = (lastResort \/ resort)
    /\ UNCHANGED <<saved, screen, neg, answers, altReply, pending, answered, ended, mouseAnswered, refusalApplied, inputOn, focusQueries, appTyped, othersTyped, boundEnded>>

Finish == ExitWithRestore(LeaveReady("exit"), FALSE)

Fail ==
    \/ /\ Variant # "skipRestoreOnFail"
       /\ ExitWithRestore(LeaveReady("exit") \/ phase = "lent", FALSE)
    \/ /\ Variant = "skipRestoreOnFail"
       /\ hooked
       /\ phase \in {"running", "lent"}
       /\ phase' = "gone"
       /\ hooked' = FALSE
       /\ UNCHANGED <<term, enabled, raw, saved, screen, neg, answers, altReply, pending, answered, ended, mouseAnswered, refusalApplied, inputOn, focusQueries, appTyped, othersTyped, badLeave, DrainVars>>

Signal == ExitWithRestore(LeaveReady("exit") \/ phase \in {"suspended", "lent"}, FALSE)

Uncaught == ExitWithRestore(phase \in {"running", "lent", "draining"}, TRUE)

ExitHook == ExitWithRestore(phase \in {"running", "suspended", "lent", "draining"}, TRUE)

Next ==
    \/ Start
    \/ ReplyToApp
    \/ ReplyToSuccessor
    \/ ReplyToOther
    \/ Proof
    \/ EnableFocus
    \/ DisableFocus
    \/ FocusIn
    \/ SetTitle
    \/ Switch("scrollback")
    \/ Switch("fullscreen")
    \/ Drain("suspend")
    \/ Drain("lend")
    \/ Drain("exit")
    \/ ReplyDrained
    \/ DrainBound
    \/ Suspend
    \/ Continue
    \/ Lend
    \/ TakeBack
    \/ Release
    \/ Handover
    \/ Adopt
    \/ Finish
    \/ Fail
    \/ Signal
    \/ Uncaught
    \/ ExitHook

Spec == Init /\ [][Next]_vars

RestoredOnExit == phase = "gone" => term = {} /\ ~raw

HandoverKeeps == phase = "handover" => term = enabled /\ raw

EnabledIsTerm == phase \in {"running", "released", "handover"} => enabled = term

Monotone == [][NegIndex(neg') >= NegIndex(neg)]_vars

HintTrue == phase # "before" => (Hint(neg) = "shift+enter" => neg \in {"kitty", "proven"})

NoWait == phase = "running" => inputOn

MouseGuarded == "mouse" \in term => "1006" \in answered /\ screen = "fullscreen"

RestoreIdempotent == ~badLeave

ReplyNeverKey == ~appTyped

NoReplyLeftForOthers == othersTyped => (lastResort \/ boundEnded)
=============================================================================
