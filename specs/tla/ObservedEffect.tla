---------------------------- MODULE ObservedEffect ----------------------------
EXTENDS Naturals, FiniteSets


CONSTANTS
    Guard,
    MaxCrashes,
    MaxThird,
    GuardHonoured,
    BlindRedo,
    NoneRedo,
    IgnoreAuthMark,
    UnknownRedo

Guards == {"server_unique", "compare_and_set", "none"}
ReconcileOutcomes == {"already_applied", "not_applied", "unknown"}
CrashPoints == {"c0", "c1", "c2", "c3", "c4", "c5"}
Worlds == {"before", "after", "other"}
Records == {"none", "pending", "applied", "already_applied", "failed", "unknown"}
Pcs == {"claim", "prepared", "begun", "retry", "authorised", "sent", "finished", "completed", "journaled"}

VARIABLES
    world,
    copies,
    landed,
    third,
    orphans,
    mine,
    rec,
    recView,
    auth,
    pc,
    crashes,
    execs,
    licence,
    prep,
    stage,
    stageView,
    blind,
    badNotApplied,
    needlessUnknown

vars == <<world, copies, landed, third, orphans, mine, rec, recView, auth, pc, crashes, execs, licence, prep, stage,
          stageView, blind, badNotApplied, needlessUnknown>>

TypeOK ==
    /\ Guard \in Guards
    /\ world \in Worlds
    /\ copies \in 0..8
    /\ landed \in 0..8
    /\ third \in 0..MaxThird
    /\ orphans \in 0..MaxCrashes + 1
    /\ mine \in BOOLEAN
    /\ rec \in Records
    /\ recView \in Worlds \cup {"none"}
    /\ auth \in BOOLEAN
    /\ pc \in Pcs
    /\ crashes \in 0..MaxCrashes
    /\ execs \in 0..MaxCrashes + 1
    /\ licence \in BOOLEAN
    /\ prep \in Worlds \cup {"none"}
    /\ stage \in Records
    /\ stageView \in Worlds \cup {"none"}
    /\ blind \in BOOLEAN
    /\ badNotApplied \in BOOLEAN
    /\ needlessUnknown \in BOOLEAN

Init ==
    /\ world = "before"
    /\ copies = 0
    /\ landed = 0
    /\ third = 0
    /\ orphans = 0
    /\ mine = FALSE
    /\ rec = "none"
    /\ recView = "none"
    /\ auth = FALSE
    /\ pc = "claim"
    /\ crashes = 0
    /\ execs = 0
    /\ licence = FALSE
    /\ prep = "none"
    /\ stage = "none"
    /\ stageView = "none"
    /\ blind = FALSE
    /\ badNotApplied = FALSE
    /\ needlessUnknown = FALSE

Settled == rec \in {"applied", "already_applied", "failed", "unknown"}

WorldAfterLanding == IF world = "before" THEN "after" ELSE IF world = "after" /\ Guard = "none" THEN "other" ELSE world

Accepts ==
    \/ ~GuardHonoured
    \/ Guard = "none"
    \/ /\ Guard = "server_unique"
       /\ copies = 0
    \/ /\ Guard = "compare_and_set"
       /\ world = "before"

LandEffect ==
    IF Accepts
    THEN /\ copies' = copies + 1
         /\ landed' = landed + 1
         /\ world' = WorldAfterLanding
    ELSE UNCHANGED <<copies, landed, world>>

LandMine ==
    /\ mine
    /\ mine' = FALSE
    /\ LandEffect
    /\ UNCHANGED <<third, orphans, rec, recView, auth, pc, crashes, execs, licence, prep, stage, stageView, blind,
                   badNotApplied, needlessUnknown>>

LandOrphan ==
    /\ orphans > 0
    /\ orphans' = orphans - 1
    /\ LandEffect
    /\ UNCHANGED <<third, mine, rec, recView, auth, pc, crashes, execs, licence, prep, stage, stageView, blind,
                   badNotApplied, needlessUnknown>>

ThirdPartyCreates ==
    /\ Guard # "none"
    /\ third < MaxThird
    /\ world = "before"
    /\ third' = third + 1
    /\ world' = "after"
    /\ copies' = copies + 1
    /\ UNCHANGED <<landed, orphans, mine, rec, recView, auth, pc, crashes, execs, licence, prep, stage, stageView,
                   blind, badNotApplied, needlessUnknown>>

ThirdPartyChanges ==
    /\ third < MaxThird
    /\ world \in {"before", "after"}
    /\ third' = third + 1
    /\ world' = "other"
    /\ UNCHANGED <<copies, landed, orphans, mine, rec, recView, auth, pc, crashes, execs, licence, prep, stage,
                   stageView, blind, badNotApplied, needlessUnknown>>

Crash ==
    /\ crashes < MaxCrashes
    /\ pc \notin {"claim", "journaled"}
    /\ crashes' = crashes + 1
    /\ pc' = "claim"
    /\ orphans' = orphans + (IF mine THEN 1 ELSE 0)
    /\ mine' = FALSE
    /\ licence' = FALSE
    /\ prep' = "none"
    /\ stage' = "none"
    /\ stageView' = "none"
    /\ UNCHANGED <<world, copies, landed, third, rec, recView, auth, execs, blind, badNotApplied, needlessUnknown>>

ClaimSettled ==
    /\ pc = "claim"
    /\ Settled
    /\ ~(UnknownRedo /\ rec = "unknown")
    /\ pc' = "completed"
    /\ UNCHANGED <<world, copies, landed, third, orphans, mine, rec, recView, auth, crashes, execs, licence, prep,
                   stage, stageView, blind, badNotApplied, needlessUnknown>>

ClaimUnknownRedo ==
    /\ UnknownRedo
    /\ pc = "claim"
    /\ rec = "unknown"
    /\ pc' = "retry"
    /\ UNCHANGED <<world, copies, landed, third, orphans, mine, rec, recView, auth, crashes, execs, licence, prep,
                   stage, stageView, blind, badNotApplied, needlessUnknown>>

Prepare ==
    /\ pc = "claim"
    /\ rec = "none"
    /\ prep' = world
    /\ pc' = "prepared"
    /\ UNCHANGED <<world, copies, landed, third, orphans, mine, rec, recView, auth, crashes, execs, licence, stage,
                   stageView, blind, badNotApplied, needlessUnknown>>

Begin ==
    /\ pc = "prepared"
    /\ rec' = "pending"
    /\ pc' = "begun"
    /\ UNCHANGED <<world, copies, landed, third, orphans, mine, recView, auth, crashes, execs, licence, prep, stage,
                   stageView, blind, badNotApplied, needlessUnknown>>

SkipAlreadyApplied ==
    /\ pc = "begun"
    /\ prep = "after"
    /\ stage' = "already_applied"
    /\ stageView' = prep
    /\ pc' = "finished"
    /\ UNCHANGED <<world, copies, landed, third, orphans, mine, rec, recView, auth, crashes, execs, licence, prep,
                   blind, badNotApplied, needlessUnknown>>

Authorise ==
    /\ \/ pc = "begun" /\ prep # "after"
       \/ pc = "retry"
    /\ auth' = TRUE
    /\ pc' = "authorised"
    /\ UNCHANGED <<world, copies, landed, third, orphans, mine, rec, recView, crashes, execs, licence, prep, stage,
                   stageView, blind, badNotApplied, needlessUnknown>>

Send ==
    /\ pc = "authorised"
    /\ mine' = TRUE
    /\ execs' = execs + 1
    /\ blind' = (blind \/ (execs > 0 /\ ~licence))
    /\ licence' = FALSE
    /\ pc' = "sent"
    /\ UNCHANGED <<world, copies, landed, third, orphans, rec, recView, auth, crashes, prep, stage, stageView,
                   badNotApplied, needlessUnknown>>

Finish ==
    /\ pc = "sent"
    /\ ~mine
    /\ stage' = IF world = "after" THEN "applied" ELSE "failed"
    /\ stageView' = world
    /\ pc' = "finished"
    /\ UNCHANGED <<world, copies, landed, third, orphans, mine, rec, recView, auth, crashes, execs, licence, prep,
                   blind, badNotApplied, needlessUnknown>>

Complete ==
    /\ pc = "finished"
    /\ rec' = stage
    /\ recView' = stageView
    /\ pc' = "completed"
    /\ UNCHANGED <<world, copies, landed, third, orphans, mine, auth, crashes, execs, licence, prep, stage,
                   stageView, blind, badNotApplied, needlessUnknown>>

Journal ==
    /\ pc = "completed"
    /\ pc' = "journaled"
    /\ UNCHANGED <<world, copies, landed, third, orphans, mine, rec, recView, auth, crashes, execs, licence, prep,
                   stage, stageView, blind, badNotApplied, needlessUnknown>>

ClaimBlind ==
    /\ BlindRedo
    /\ pc = "claim"
    /\ rec = "pending"
    /\ pc' = "retry"
    /\ UNCHANGED <<world, copies, landed, third, orphans, mine, rec, recView, auth, crashes, execs, licence, prep,
                   stage, stageView, blind, badNotApplied, needlessUnknown>>

ProbesMarkedStarted == IF IgnoreAuthMark THEN TRUE ELSE auth

ReconcileNotApplied ==
    /\ licence' = TRUE
    /\ pc' = "retry"
    /\ UNCHANGED <<stage, stageView, needlessUnknown>>

ReconcileUnknown ==
    /\ stage' = "unknown"
    /\ stageView' = world
    /\ needlessUnknown' = (needlessUnknown \/ ~auth)
    /\ pc' = "finished"
    /\ UNCHANGED licence

Reconcile ==
    /\ ~BlindRedo
    /\ pc = "claim"
    /\ rec = "pending"
    /\ UNCHANGED <<world, copies, landed, third, orphans, mine, rec, recView, auth, crashes, execs, prep, blind>>
    /\ IF ~ProbesMarkedStarted
       THEN /\ ReconcileNotApplied
            /\ UNCHANGED badNotApplied
       ELSE IF world = "after"
       THEN /\ stage' = "already_applied"
            /\ stageView' = world
            /\ pc' = "finished"
            /\ UNCHANGED <<licence, badNotApplied, needlessUnknown>>
       ELSE IF world = "before" /\ (Guard # "none" \/ NoneRedo)
       THEN /\ ReconcileNotApplied
            /\ badNotApplied' = (badNotApplied \/ (auth /\ Guard = "none"))
       ELSE /\ ReconcileUnknown
            /\ UNCHANGED badNotApplied

WorkerStep ==
    \/ ClaimSettled
    \/ ClaimUnknownRedo
    \/ ClaimBlind
    \/ Reconcile
    \/ Prepare
    \/ Begin
    \/ SkipAlreadyApplied
    \/ Authorise
    \/ Send
    \/ Finish
    \/ Complete
    \/ Journal

Progress == WorkerStep \/ LandMine \/ LandOrphan

Environment == Crash \/ ThirdPartyCreates \/ ThirdPartyChanges

Settle == pc = "journaled" /\ orphans = 0 /\ ~mine /\ UNCHANGED vars

Next == Progress \/ Environment \/ Settle

Spec == Init /\ [][Next]_vars

LiveSpec == Spec /\ WF_vars(Progress)

NoBlindRedo == ~blind

GuardedRedo == ~badNotApplied

NoNeedlessUnknown == ~needlessUnknown

AtMostOneLanded == landed <= 1

AtMostOneOpenPR == Guard # "none" => copies <= 1

ResultFromWorld ==
    /\ rec \in {"applied", "already_applied"} => recView = "after"
    /\ rec = "failed" => recView # "after"
    /\ rec = "unknown" => recView \in Worlds

ConvergesWhenUndisturbed ==
    (pc = "journaled" /\ third = 0 /\ Guard # "none") => rec \in {"applied", "already_applied"}

UnknownIsStable == rec = "unknown" => pc \in {"claim", "completed", "journaled"}

Terminates == <>(pc = "journaled")

EndsDecided == <>(pc = "journaled" /\ rec \in {"applied", "already_applied", "failed", "unknown"})

=============================================================================
