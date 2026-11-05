---------------------------- MODULE ChildCancel ----------------------------
EXTENDS Naturals

CONSTANTS MaxFailures, MaxDaemonCrashes, IntentInMemory

VARIABLES parent, child, intent, failures, crashes

vars == <<parent, child, intent, failures, crashes>>

Init ==
    /\ parent = "cancelling"
    /\ child = "live"
    /\ intent = TRUE
    /\ failures = 0
    /\ crashes = 0

ParentFinish ==
    /\ parent = "cancelling"
    /\ parent' = "terminal"
    /\ UNCHANGED <<child, intent, failures, crashes>>

ChildSelfFinish ==
    /\ child = "live"
    /\ child' = "done"
    /\ UNCHANGED <<parent, intent, failures, crashes>>

Sweepable == IF IntentInMemory THEN intent ELSE parent \in {"cancelling", "terminal"}

SweepChild ==
    /\ child = "live"
    /\ Sweepable
    /\ child' = "done"
    /\ UNCHANGED <<parent, intent, failures, crashes>>

SweepFails ==
    /\ child = "live"
    /\ Sweepable
    /\ failures < MaxFailures
    /\ failures' = failures + 1
    /\ UNCHANGED <<parent, child, intent, crashes>>

DaemonCrash ==
    /\ crashes < MaxDaemonCrashes
    /\ crashes' = crashes + 1
    /\ intent' = FALSE
    /\ UNCHANGED <<parent, child, failures>>

Stutter == UNCHANGED vars

Next == ParentFinish \/ ChildSelfFinish \/ SweepChild \/ SweepFails \/ DaemonCrash \/ Stutter

Spec == Init /\ [][Next]_vars

LiveSpec == Spec /\ WF_vars(SweepChild) /\ WF_vars(ParentFinish)

TypeOK ==
    /\ parent \in {"cancelling", "terminal"}
    /\ child \in {"live", "done"}
    /\ intent \in BOOLEAN
    /\ failures \in 0..MaxFailures
    /\ crashes \in 0..MaxDaemonCrashes

OrphansSettle == <>(child = "done")

=============================================================================
