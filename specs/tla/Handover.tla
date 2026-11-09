---------------------------- MODULE Handover ----------------------------
EXTENDS Naturals

CONSTANTS MaxPrompts, MaxNewer, WriteFailBudget, ExecFailBudget, RefuseBudget, CrashBudget, Path, Variant

ASSUME Variant \in {"decided", "moveWithDialog", "echoKept", "retryOnExecFail", "noPrintedSkip"}
ASSUME Path \in {"exec", "relay"}
ASSUME MaxPrompts \in Nat \ {0}
ASSUME MaxNewer \in Nat \ {0}
ASSUME WriteFailBudget \in Nat
ASSUME ExecFailBudget \in Nat
ASSUME RefuseBudget \in Nat
ASSUME CrashBudget \in Nat

Moving == {"writing", "execing", "adopting"}
Drawing == {"serving", "adopted"}

VARIABLES phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes

vars == <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes>>

Init ==
    /\ phase = "serving"
    /\ drawer = "old"
    /\ dialog = FALSE
    /\ openAtBegin = FALSE
    /\ relayAlive = FALSE
    /\ listed = 0
    /\ promptsSeen = 0
    /\ promptEntries = 0
    /\ output = 0
    /\ recState = "none"
    /\ recItems = 0
    /\ recInput = 0
    /\ inputNow = 0
    /\ adoptedInput = 0
    /\ attempts = [n \in 0..MaxNewer |-> 0]
    /\ curNewer = 0
    /\ writeFails = WriteFailBudget
    /\ execFails = ExecFailBudget
    /\ refuses = RefuseBudget
    /\ crashes = CrashBudget
    /\ consumes = 0

NewerArrives ==
    /\ curNewer < MaxNewer
    /\ curNewer' = curNewer + 1
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, writeFails, execFails, refuses, crashes, consumes>>

Prompt ==
    /\ phase \in Drawing
    /\ promptsSeen < MaxPrompts
    /\ promptsSeen' = promptsSeen + 1
    /\ listed' = listed + 1
    /\ promptEntries' = promptEntries + (IF Variant = "echoKept" THEN 2 ELSE 1)
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes>>

Flush ==
    /\ phase \in Drawing
    /\ output < listed
    /\ output' = listed
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes>>

ToggleDialog ==
    /\ phase \in Drawing
    /\ dialog' = ~dialog
    /\ UNCHANGED <<phase, drawer, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes>>

ToggleInput ==
    /\ phase \in Drawing
    /\ inputNow' = 1 - inputNow
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes>>

Begin ==
    /\ phase = "serving"
    /\ curNewer > 0
    /\ Variant = "retryOnExecFail" \/ attempts[curNewer] = 0
    /\ Variant = "moveWithDialog" \/ ~dialog
    /\ phase' = "writing"
    /\ attempts' = [attempts EXCEPT ![curNewer] = @ + 1]
    /\ openAtBegin' = dialog
    /\ UNCHANGED <<drawer, dialog, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, curNewer, writeFails, execFails, refuses, crashes, consumes>>

WriteRecord ==
    /\ phase = "writing"
    /\ writeFails > 0
    /\ writeFails' = writeFails - 1
    /\ phase' = "serving"
    /\ UNCHANGED <<drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, execFails, refuses, crashes, consumes>>

WriteOk ==
    /\ phase = "writing"
    /\ phase' = "execing"
    /\ drawer' = "none"
    /\ recState' = "written"
    /\ recItems' = listed
    /\ recInput' = inputNow
    /\ UNCHANGED <<dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes>>

ExecFail ==
    /\ phase = "execing"
    /\ execFails > 0
    /\ execFails' = execFails - 1
    /\ phase' = "serving"
    /\ drawer' = "old"
    /\ UNCHANGED <<dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, refuses, crashes, consumes>>

ExecOk ==
    /\ phase = "execing"
    /\ phase' = "adopting"
    /\ relayAlive' = (Path = "relay")
    /\ UNCHANGED <<drawer, dialog, openAtBegin, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes>>

Refuse ==
    /\ phase = "adopting"
    /\ refuses > 0
    /\ refuses' = refuses - 1
    /\ phase' = "refused"
    /\ drawer' = "none"
    /\ relayAlive' = FALSE
    /\ recState' = IF recState = "written" THEN "leftover" ELSE recState
    /\ UNCHANGED <<dialog, openAtBegin, listed, promptsSeen, promptEntries, output, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, crashes, consumes>>

Adopt ==
    /\ phase = "adopting"
    /\ phase' = "adopted"
    /\ drawer' = "new"
    /\ relayAlive' = FALSE
    /\ recState' = IF recState = "written" THEN "consumed" ELSE recState
    /\ consumes' = consumes + IF recState = "written" THEN 1 ELSE 0
    /\ adoptedInput' = recInput
    /\ output' = IF Variant = "noPrintedSkip" THEN output + recItems ELSE output
    /\ UNCHANGED <<dialog, openAtBegin, listed, promptsSeen, promptEntries, recItems, recInput, inputNow, attempts, curNewer, writeFails, execFails, refuses, crashes>>

Crash ==
    /\ phase \in Moving
    /\ crashes > 0
    /\ crashes' = crashes - 1
    /\ phase' = "crashed"
    /\ drawer' = "none"
    /\ relayAlive' = FALSE
    /\ recState' = IF recState = "written" THEN "leftover" ELSE recState
    /\ UNCHANGED <<dialog, openAtBegin, listed, promptsSeen, promptEntries, output, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, consumes>>

Sweep ==
    /\ recState = "leftover"
    /\ phase \in {"crashed", "refused"}
    /\ recState' = "swept"
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes>>

Next ==
    \/ NewerArrives
    \/ Prompt
    \/ Flush
    \/ ToggleDialog
    \/ ToggleInput
    \/ Begin
    \/ WriteRecord
    \/ WriteOk
    \/ ExecFail
    \/ ExecOk
    \/ Refuse
    \/ Adopt
    \/ Crash
    \/ Sweep

Spec == Init /\ [][Next]_vars /\ WF_vars(Begin) /\ WF_vars(WriteRecord) /\ WF_vars(WriteOk) /\ WF_vars(ExecFail) /\ WF_vars(ExecOk) /\ WF_vars(Refuse) /\ WF_vars(Adopt) /\ WF_vars(Sweep) /\ WF_vars(Flush)

TypeOK ==
    /\ phase \in {"serving", "writing", "execing", "adopting", "adopted", "refused", "crashed"}
    /\ drawer \in {"old", "new", "none"}
    /\ dialog \in BOOLEAN
    /\ openAtBegin \in BOOLEAN
    /\ relayAlive \in BOOLEAN
    /\ recState \in {"none", "written", "consumed", "leftover", "swept"}
    /\ inputNow \in {0, 1}
    /\ adoptedInput \in {0, 1}
    /\ recInput \in {0, 1}
    /\ curNewer \in 0..MaxNewer

NoMoveWithDialog == ~openAtBegin

OneAttemptPerNewer == \A n \in 0..MaxNewer : attempts[n] <= 1

NoDuplicateOutput == output <= listed

OneEntryPerPrompt == promptEntries <= promptsSeen

DrawerOwnsScreen == /\ (phase = "serving" => drawer = "old") /\ (phase = "adopted" => drawer = "new")

RelayNeverDraws == relayAlive => drawer # "old"

InputKept == phase = "adopted" => adoptedInput = recInput

RecordConsumedOnce == consumes <= 1

Terminates == \A s \in {"writing", "execing", "adopting"} : []((phase = s) => <>(phase # s))

=============================================================================
