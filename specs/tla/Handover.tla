---------------------------- MODULE Handover ----------------------------
(***************************************************************************)
(* The move of an open TUI session to the new version by exec or relay      *)
(* (design-update-no-interrupt, I7, section 16), for both screen modes of   *)
(* design-screens-2026-11-10 (2.1, 2.2, 13.1).                              *)
(*                                                                          *)
(* The set of terminal modes and the screen mode travel in the environment  *)
(* of the exec (MOMONGA_HANDOVER_TERMINAL): envModes, envKnown. The record  *)
(* holds what adoption needs: the unsent input, the viewport anchor with    *)
(* its following flag, the display toggles (thought entries folded or      *)
(* open), the number of printed items (scrollback), the negotiation state.  *)
(* When the value is lost (envKnown false) the new process leaves every     *)
(* mode of the table once (LeaveAll), then starts as an ordinary client in  *)
(* the screen mode of its settings (screenNow), and adopts the record.      *)
(*                                                                          *)
(* The model's four modes stand for the two kinds of rows of the mode      *)
(* table: alt and mouse and paste are idempotent rows (a second enter       *)
(* write changes nothing in the terminal; paste stands for focus and        *)
(* modify-other-keys too); kitty is a stacked row (a second push needs a    *)
(* second pop; it stands for the title stack too). Every action treats      *)
(* every row alike, so the number of rows does not change a result.         *)
(*                                                                          *)
(* Abstracted away, with the reason:                                        *)
(* - the clock and every duration: no rule of the design reads one;         *)
(* - the contents of the record beyond the copied fields, the daemon, the   *)
(*   replay and the store: the screen is one fold of the events (16.1);     *)
(* - the row offset of the anchor and the terminal size: the adoption runs  *)
(*   the live resize path (screens 2.5), which clamps the offset and keeps  *)
(*   following; only the entry key and following are checked (ViewKept),    *)
(*   and no modelled variable reads the size;                               *)
(* - the order of escape sequences inside one write, the terminal replies   *)
(*   (a mode appears when its reply arrives: EnableMouse), the negotiation  *)
(*   state is one bit fixed before the first move;                          *)
(* - the effect of a /tui switch on the screen mode: Screen is fixed per    *)
(*   behaviour; a switch under way is not a quiet point (switching blocks   *)
(*   Begin), so no move sees a switch half done and no switch changes the   *)
(*   mode set of a move;                                                    *)
(* - the leave at session exit: it writes the leave sequence of the same    *)
(*   enabled set by the same table as LeaveAll and Refuse, no second actor; *)
(* - /clear (it opens a new session, so no record holds a clear mark); the  *)
(*   ACP, attach and headless kinds (they have no screen).                  *)
(*                                                                          *)
(* The terminal state changes only by writes of the product.                *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS MaxPrompts, MaxNewer, WriteFailBudget, ExecFailBudget, RefuseBudget, CrashBudget, Path, Variant, Screen

ASSUME Variant \in {"decided", "moveWithDialog", "echoKept", "retryOnExecFail", "noPrintedSkip", "restoreBeforeExec", "reenterWrites", "refuseLeavesModes", "envLost", "envLostNoLeave", "moveWithSwitch"}
ASSUME Path \in {"exec", "relay"}
ASSUME Screen \in {"fullscreen", "scrollback", "both"}
ASSUME Variant = "noPrintedSkip" => Screen = "scrollback"
ASSUME Variant \in {"restoreBeforeExec", "reenterWrites", "refuseLeavesModes", "envLostNoLeave"} => Screen = "fullscreen"
ASSUME MaxPrompts \in Nat \ {0}
ASSUME MaxNewer \in Nat \ {0}
ASSUME WriteFailBudget \in Nat
ASSUME ExecFailBudget \in Nat
ASSUME RefuseBudget \in Nat
ASSUME CrashBudget \in Nat

Moving == {"writing", "execing", "adopting"}
Drawing == {"serving", "adopted"}
Modes == {"alt", "mouse", "paste", "kitty"}
ModesOf(s) == IF s = "fullscreen" THEN Modes ELSE Modes \ {"alt", "mouse"}
StartModes(s) == IF s = "fullscreen" THEN {"alt", "paste", "kitty"} ELSE {"paste", "kitty"}
ScreenSet == IF Screen = "both" THEN {"fullscreen", "scrollback"} ELSE {Screen}
LossPossible == Variant \in {"envLost", "envLostNoLeave"}

VARIABLES phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg

vars == <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

Ready == envKnown \/ left \/ Variant = "envLostNoLeave"

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
    /\ screen \in ScreenSet
    /\ screenNow = screen
    /\ term = StartModes(screen)
    /\ want = term
    /\ envModes = {}
    /\ envKnown = TRUE
    /\ enabled = term
    /\ left = FALSE
    /\ twice = FALSE
    /\ viewNow = 0
    /\ recView = 0
    /\ adoptedView = 0
    /\ togNow = 0
    /\ recTog = 0
    /\ adoptedTog = 0
    /\ switching = FALSE
    /\ switchAtBegin = FALSE
    /\ negNow \in {0, 1}
    /\ recNeg = 0
    /\ adoptedNeg = 0

NewerArrives ==
    /\ curNewer < MaxNewer
    /\ curNewer' = curNewer + 1
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

Prompt ==
    /\ phase \in Drawing
    /\ promptsSeen < MaxPrompts
    /\ promptsSeen' = promptsSeen + 1
    /\ listed' = listed + 1
    /\ promptEntries' = promptEntries + (IF Variant = "echoKept" THEN 2 ELSE 1)
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

Flush ==
    /\ screenNow = "scrollback"
    /\ phase \in Drawing
    /\ output < listed
    /\ output' = listed
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

ToggleDialog ==
    /\ phase \in Drawing
    /\ dialog' = ~dialog
    /\ UNCHANGED <<phase, drawer, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

ToggleInput ==
    /\ phase \in Drawing
    /\ inputNow' = 1 - inputNow
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

ScrollView ==
    /\ screenNow = "fullscreen"
    /\ phase \in Drawing
    /\ viewNow' \in 0..1
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

ToggleThought ==
    /\ phase \in Drawing
    /\ togNow' = 1 - togNow
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

EnableMouse ==
    /\ screenNow = "fullscreen"
    /\ phase \in Drawing
    /\ "mouse" \notin term
    /\ term' = term \cup {"mouse"}
    /\ want' = want \cup {"mouse"}
    /\ enabled' = enabled \cup {"mouse"}
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, envModes, envKnown, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

StartSwitch ==
    /\ phase \in Drawing
    /\ ~switching
    /\ switching' = TRUE
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switchAtBegin, negNow, recNeg, adoptedNeg>>

EndSwitch ==
    /\ switching
    /\ switching' = FALSE
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switchAtBegin, negNow, recNeg, adoptedNeg>>

Begin ==
    /\ phase = "serving"
    /\ curNewer > 0
    /\ Variant = "retryOnExecFail" \/ attempts[curNewer] = 0
    /\ Variant = "moveWithDialog" \/ ~dialog
    /\ Variant = "moveWithSwitch" \/ ~switching
    /\ phase' = "writing"
    /\ attempts' = [attempts EXCEPT ![curNewer] = @ + 1]
    /\ openAtBegin' = dialog
    /\ switchAtBegin' = switching
    /\ UNCHANGED <<drawer, dialog, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, negNow, recNeg, adoptedNeg>>

WriteRecord ==
    /\ phase = "writing"
    /\ writeFails > 0
    /\ writeFails' = writeFails - 1
    /\ phase' = "serving"
    /\ UNCHANGED <<drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, execFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

WriteOk ==
    /\ phase = "writing"
    /\ phase' = "execing"
    /\ drawer' = "none"
    /\ recState' = "written"
    /\ recItems' = listed
    /\ recInput' = inputNow
    /\ envModes' = term
    /\ envKnown' = TRUE
    /\ recView' = viewNow
    /\ recTog' = togNow
    /\ recNeg' = negNow
    /\ UNCHANGED <<dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, term, want, enabled, left, twice, viewNow, adoptedView, togNow, adoptedTog, switching, switchAtBegin, negNow, adoptedNeg>>

RestoreOld ==
    /\ Variant = "restoreBeforeExec"
    /\ phase = "execing"
    /\ term' = {}
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

ExecFail ==
    /\ phase = "execing"
    /\ execFails > 0
    /\ execFails' = execFails - 1
    /\ phase' = "serving"
    /\ drawer' = "old"
    /\ UNCHANGED <<dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

ExecOk ==
    /\ phase = "execing"
    /\ phase' = "adopting"
    /\ relayAlive' = (Path = "relay")
    /\ envKnown' \in (IF LossPossible THEN BOOLEAN ELSE {envKnown})
    /\ UNCHANGED <<drawer, dialog, openAtBegin, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

LeaveAll ==
    /\ phase = "adopting"
    /\ ~envKnown
    /\ ~left
    /\ Variant # "envLostNoLeave"
    /\ term' = {}
    /\ want' = {}
    /\ enabled' = {}
    /\ left' = TRUE
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recState, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, envModes, envKnown, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

Refuse ==
    /\ phase = "adopting"
    /\ Ready
    /\ refuses > 0
    /\ refuses' = refuses - 1
    /\ phase' = "refused"
    /\ drawer' = "none"
    /\ relayAlive' = FALSE
    /\ recState' = IF recState = "written" THEN "leftover" ELSE recState
    /\ term' = IF Variant = "refuseLeavesModes" THEN term ELSE term \ (IF envKnown THEN envModes ELSE {})
    /\ UNCHANGED <<dialog, openAtBegin, listed, promptsSeen, promptEntries, output, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, crashes, consumes, screen, screenNow, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

Adopt ==
    /\ phase = "adopting"
    /\ Ready
    /\ phase' = "adopted"
    /\ screenNow' \in (IF envKnown \/ ~left THEN {screenNow} ELSE {"fullscreen", "scrollback"})
    /\ drawer' = "new"
    /\ relayAlive' = FALSE
    /\ recState' = IF recState = "written" THEN "consumed" ELSE recState
    /\ consumes' = consumes + IF recState = "written" THEN 1 ELSE 0
    /\ adoptedInput' = recInput
    /\ adoptedView' = recView
    /\ adoptedTog' = recTog
    /\ adoptedNeg' = recNeg
    /\ enabled' = IF envKnown THEN envModes ELSE IF left THEN StartModes(screenNow') ELSE {}
    /\ want' = IF envKnown \/ ~left THEN want ELSE StartModes(screenNow')
    /\ output' = IF Variant = "noPrintedSkip" THEN output + recItems ELSE output
    /\ term' = IF envKnown THEN (IF Variant \in {"restoreBeforeExec", "reenterWrites"} THEN term \cup envModes ELSE term) ELSE IF left THEN StartModes(screenNow') ELSE term
    /\ twice' = (twice \/ (Variant = "reenterWrites" /\ envKnown /\ envModes \cap term # {}))
    /\ UNCHANGED <<dialog, openAtBegin, listed, promptsSeen, promptEntries, recItems, recInput, inputNow, attempts, curNewer, writeFails, execFails, refuses, crashes, screen, envModes, envKnown, left, viewNow, recView, togNow, recTog, switching, switchAtBegin, negNow, recNeg>>

Crash ==
    /\ phase \in Moving
    /\ crashes > 0
    /\ crashes' = crashes - 1
    /\ phase' = "crashed"
    /\ drawer' = "none"
    /\ relayAlive' = FALSE
    /\ recState' = IF recState = "written" THEN "leftover" ELSE recState
    /\ UNCHANGED <<dialog, openAtBegin, listed, promptsSeen, promptEntries, output, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

Sweep ==
    /\ recState = "leftover"
    /\ phase \in {"crashed", "refused"}
    /\ recState' = "swept"
    /\ UNCHANGED <<phase, drawer, dialog, openAtBegin, relayAlive, listed, promptsSeen, promptEntries, output, recItems, recInput, inputNow, adoptedInput, attempts, curNewer, writeFails, execFails, refuses, crashes, consumes, screen, screenNow, term, want, envModes, envKnown, enabled, left, twice, viewNow, recView, adoptedView, togNow, recTog, adoptedTog, switching, switchAtBegin, negNow, recNeg, adoptedNeg>>

Next ==
    \/ NewerArrives
    \/ Prompt
    \/ Flush
    \/ ToggleDialog
    \/ ToggleInput
    \/ ScrollView
    \/ ToggleThought
    \/ EnableMouse
    \/ StartSwitch
    \/ EndSwitch
    \/ Begin
    \/ WriteRecord
    \/ WriteOk
    \/ RestoreOld
    \/ ExecFail
    \/ ExecOk
    \/ LeaveAll
    \/ Refuse
    \/ Adopt
    \/ Crash
    \/ Sweep

Spec == Init /\ [][Next]_vars /\ WF_vars(Begin) /\ WF_vars(WriteRecord) /\ WF_vars(WriteOk) /\ WF_vars(ExecFail) /\ WF_vars(ExecOk) /\ WF_vars(LeaveAll) /\ WF_vars(Refuse) /\ WF_vars(Adopt) /\ WF_vars(Sweep) /\ WF_vars(Flush) /\ WF_vars(EndSwitch)

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
    /\ screen \in {"fullscreen", "scrollback"}
    /\ screenNow \in {"fullscreen", "scrollback"}
    /\ term \subseteq Modes
    /\ want \subseteq Modes
    /\ envModes \subseteq Modes
    /\ enabled \subseteq Modes
    /\ envKnown \in BOOLEAN
    /\ left \in BOOLEAN
    /\ twice \in BOOLEAN
    /\ viewNow \in {0, 1}
    /\ recView \in {0, 1}
    /\ adoptedView \in {0, 1}
    /\ togNow \in {0, 1}
    /\ recTog \in {0, 1}
    /\ adoptedTog \in {0, 1}
    /\ switching \in BOOLEAN
    /\ switchAtBegin \in BOOLEAN
    /\ negNow \in {0, 1}
    /\ recNeg \in {0, 1}
    /\ adoptedNeg \in {0, 1}

NoMoveWithDialog == ~openAtBegin

NoMoveWithSwitch == ~switchAtBegin

OneAttemptPerNewer == \A n \in 0..MaxNewer : attempts[n] <= 1

NoDuplicateOutput == output <= listed

NoPrintedInFullscreen == (screen = "fullscreen" /\ screenNow = "fullscreen") => output = 0

OneEntryPerPrompt == promptEntries <= promptsSeen

DrawerOwnsScreen == /\ (phase = "serving" => drawer = "old") /\ (phase = "adopted" => drawer = "new")

RelayNeverDraws == relayAlive => drawer # "old"

InputKept == phase = "adopted" => adoptedInput = recInput

ViewKept == (screen = "fullscreen" /\ screenNow = "fullscreen" /\ phase = "adopted") => adoptedView = recView

TogglesKept == phase = "adopted" => adoptedTog = recTog

NegKept == phase = "adopted" => adoptedNeg = recNeg

ModesKept == /\ ~twice /\ (left => ~envKnown) /\ (phase \notin {"refused", "crashed"} => term = want)

EnabledKnown == phase = "adopted" => enabled = term

NoneLeftSet == phase = "refused" => term = {}

RecordConsumedOnce == consumes <= 1

Terminates == \A s \in {"writing", "execing", "adopting"} : []((phase = s) => <>(phase # s))

=============================================================================
