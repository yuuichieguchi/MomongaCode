----------------------------- MODULE BudgetLedger -----------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Runs,
    Limit,
    Sizes,
    MaxRequests,
    MaxInterrupts,
    ReleaseBeforeAppend,
    ResendNoReserve,
    SweepBeforeChildDone

ASSUME /\ Runs \in Nat /\ Runs >= 1
       /\ Limit \in Nat
       /\ Sizes \subseteq (Nat \ {0}) /\ Sizes # {}
       /\ MaxRequests \in Nat
       /\ MaxInterrupts \in Nat
       /\ ReleaseBeforeAppend \in BOOLEAN
       /\ ResendNoReserve \in BOOLEAN
       /\ SweepBeforeChildDone \in BOOLEAN

RunIds == 1..Runs

Root == 1

SettlingEvents == {"model.responded", "usage.charged"}

Unswept == Limit + 1

VARIABLES spent, reserved, req, size, status, sent, interrupts, aggregate, unswept

vars == <<spent, reserved, req, size, status, sent, interrupts, aggregate, unswept>>

RECURSIVE SumOver(_, _)
SumOver(S, f) == IF S = {} THEN 0 ELSE LET x == CHOOSE y \in S : TRUE IN f[x] + SumOver(S \ {x}, f)

Counted(r) == status[r] # "terminal"

TreeSpent == SumOver(RunIds, spent)

TreeReserved == SumOver({r \in RunIds : Counted(r)}, reserved)

Others(r) == SumOver({x \in RunIds \ {r} : Counted(x)}, reserved)

-----------------------------------------------------------------------------

Init ==
    /\ spent = [r \in RunIds |-> 0]
    /\ reserved = [r \in RunIds |-> 0]
    /\ req = [r \in RunIds |-> "none"]
    /\ size = [r \in RunIds |-> 0]
    /\ status = [r \in RunIds |-> "running"]
    /\ sent = [r \in RunIds |-> 0]
    /\ interrupts = 0
    /\ aggregate = Unswept
    /\ unswept = {}

Admit(r, s) ==
    /\ status[r] = "running"
    /\ req[r] = "none"
    /\ sent[r] < MaxRequests
    /\ TreeSpent + Others(r) + s <= Limit
    /\ reserved' = [reserved EXCEPT ![r] = s]
    /\ size' = [size EXCEPT ![r] = s]
    /\ req' = [req EXCEPT ![r] = "streaming"]
    /\ sent' = [sent EXCEPT ![r] = @ + 1]
    /\ UNCHANGED <<spent, status, interrupts, aggregate, unswept>>

Settle(r, c) ==
    /\ req[r] = "streaming"
    /\ ~ReleaseBeforeAppend
    /\ spent' = [spent EXCEPT ![r] = @ + c]
    /\ reserved' = [reserved EXCEPT ![r] = 0]
    /\ req' = [req EXCEPT ![r] = "none"]
    /\ UNCHANGED <<size, status, sent, interrupts, aggregate, unswept>>

ReleaseEarly(r) ==
    /\ req[r] = "streaming"
    /\ ReleaseBeforeAppend
    /\ reserved' = [reserved EXCEPT ![r] = 0]
    /\ req' = [req EXCEPT ![r] = "released"]
    /\ UNCHANGED <<spent, size, status, sent, interrupts, aggregate, unswept>>

AppendLate(r, c) ==
    /\ req[r] = "released"
    /\ spent' = [spent EXCEPT ![r] = @ + c]
    /\ req' = [req EXCEPT ![r] = "none"]
    /\ UNCHANGED <<reserved, size, status, sent, interrupts, aggregate, unswept>>

Interrupt(r) ==
    /\ req[r] = "streaming"
    /\ interrupts < MaxInterrupts
    /\ interrupts' = interrupts + 1
    /\ req' = [req EXCEPT ![r] = "recorded"]
    /\ reserved' = IF ResendNoReserve THEN [reserved EXCEPT ![r] = 0] ELSE reserved
    /\ UNCHANGED <<spent, size, status, sent, aggregate, unswept>>

Resend(r) ==
    /\ req[r] = "recorded"
    /\ reserved' = IF ResendNoReserve THEN reserved ELSE [reserved EXCEPT ![r] = size[r]]
    /\ req' = [req EXCEPT ![r] = "streaming"]
    /\ UNCHANGED <<spent, size, status, sent, interrupts, aggregate, unswept>>

Finish(r) ==
    /\ status[r] \in {"running", "cancelling"}
    /\ req[r] = "none"
    /\ status' = [x \in RunIds |->
                    IF x = r THEN "terminal"
                    ELSE IF r = Root /\ status[x] = "running" THEN "cancelling"
                    ELSE status[x]]
    /\ unswept' = unswept \cup {r}
    /\ UNCHANGED <<spent, reserved, req, size, sent, interrupts, aggregate>>

RecomputesRoot(r) == r = Root \/ ~SweepBeforeChildDone

Sweep(r) ==
    /\ r \in unswept
    /\ unswept' = unswept \ {r}
    /\ aggregate' = IF status[Root] = "terminal" /\ RecomputesRoot(r) THEN TreeSpent ELSE aggregate
    /\ UNCHANGED <<spent, reserved, req, size, status, sent, interrupts>>

Terminated == (\A r \in RunIds : status[r] = "terminal") /\ unswept = {} /\ UNCHANGED vars

Next ==
    \/ \E r \in RunIds :
        \/ \E s \in Sizes : Admit(r, s)
        \/ \E c \in 1..size[r] : Settle(r, c) \/ AppendLate(r, c)
        \/ ReleaseEarly(r)
        \/ Interrupt(r)
        \/ Resend(r)
        \/ Finish(r)
        \/ Sweep(r)
    \/ Terminated

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------

TypeOK ==
    /\ req \in [RunIds -> {"none", "streaming", "released", "recorded"}]
    /\ status \in [RunIds -> {"running", "cancelling", "terminal"}]
    /\ interrupts \in 0..MaxInterrupts

B2 == TreeSpent + TreeReserved <= Limit

B4 == \A r \in RunIds : req[r] = "streaming" => reserved[r] = size[r]

B7 == (\A r \in RunIds : status[r] = "terminal") /\ unswept = {} => aggregate = TreeSpent

=============================================================================
