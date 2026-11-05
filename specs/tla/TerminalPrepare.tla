---------------------------- MODULE TerminalPrepare ----------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    MaxAppends,
    MaxWorkerCrashes,
    MaxDaemonCrashes,
    MaxStalls,
    Leading,
    CommitMeasuresInline,
    NoRePrepare,
    LeadingUnseen,
    SeparateWrite,
    NoFence,
    MeasureOnLoop,
    RetryAfterFailure

Holders == {"h1", "h2"}
Service == "s"
Instances == Holders \cup {Service}
Pcs == {"none", "idle", "awaiting", "measuring", "ready", "done", "failed", "lost", "dead"}
Live == {"idle", "awaiting", "measuring", "ready"}
Statuses == {"active", "terminal"}
LeaseStates == {"held", "free"}

VARIABLES
    status,
    jr,
    appends,
    wcrashes,
    dcrashes,
    stalls,
    lease,
    loopBusy,
    ownBlock,
    pc,
    cur,
    ploc,
    reprep,
    inlineMeasured,
    badCommit

vars == <<status, jr, appends, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
          pc, cur, ploc, reprep, inlineMeasured, badCommit>>

Ev == [k |-> "e"]
LeadEv == [k |-> "L"]
TermEv == [k |-> "T"]
ContributionEv(n) == [k |-> "C", cov |-> n]

Positions(kind) == {p \in 1..Len(jr) : jr[p].k = kind}

HolderAlive == \E h \in Holders : cur[h] /\ pc[h] \in Live

Seen == IF LeadingUnseen THEN 0 ELSE Leading

LeadingEvents == IF Leading = 1 THEN <<LeadEv>> ELSE <<>>

TypeOK ==
    /\ status \in Statuses
    /\ \A p \in 1..Len(jr) : jr[p].k \in {"e", "L", "C", "T"}
    /\ appends \in 0..MaxAppends
    /\ wcrashes \in 0..MaxWorkerCrashes
    /\ dcrashes \in 0..MaxDaemonCrashes
    /\ stalls \in 0..MaxStalls
    /\ lease \in LeaseStates
    /\ loopBusy \in BOOLEAN
    /\ ownBlock \in BOOLEAN
    /\ pc \in [Instances -> Pcs]
    /\ cur \in [Holders -> BOOLEAN]
    /\ ploc \in [Instances -> Nat]
    /\ reprep \in [Instances -> Nat]
    /\ inlineMeasured \in BOOLEAN
    /\ badCommit \in BOOLEAN

Init ==
    /\ status = "active"
    /\ jr = <<Ev>>
    /\ appends = 0
    /\ wcrashes = 0
    /\ dcrashes = 0
    /\ stalls = 0
    /\ lease = "held"
    /\ loopBusy = FALSE
    /\ ownBlock = FALSE
    /\ pc = [i \in Instances |-> IF i = "h1" THEN "idle" ELSE "none"]
    /\ cur = [h \in Holders |-> h = "h1"]
    /\ ploc = [i \in Instances |-> 0]
    /\ reprep = [i \in Instances |-> 0]
    /\ inlineMeasured = FALSE
    /\ badCommit = FALSE

External ==
    /\ status = "active"
    /\ appends < MaxAppends
    /\ jr' = Append(jr, Ev)
    /\ appends' = appends + 1
    /\ UNCHANGED <<status, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   pc, cur, ploc, reprep, inlineMeasured, badCommit>>

StartService ==
    /\ status = "active"
    /\ (pc[Service] \in {"none", "dead", "lost"} \/ (pc[Service] = "failed" /\ RetryAfterFailure))
    /\ pc' = [pc EXCEPT ![Service] = "idle"]
    /\ reprep' = [reprep EXCEPT ![Service] = 0]
    /\ UNCHANGED <<status, jr, appends, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, ploc, inlineMeasured, badCommit>>

Reclaim(h) ==
    /\ status = "active"
    /\ lease = "free"
    /\ pc[h] \in {"none", "dead", "failed", "lost"}
    /\ (RetryAfterFailure \/ \A g \in Holders : pc[g] # "failed")
    /\ lease' = "held"
    /\ cur' = [g \in Holders |-> g = h]
    /\ pc' = [pc EXCEPT ![h] = "idle"]
    /\ reprep' = [reprep EXCEPT ![h] = 0]
    /\ UNCHANGED <<status, jr, appends, wcrashes, dcrashes, stalls, loopBusy, ownBlock,
                   ploc, inlineMeasured, badCommit>>

Plan(i) ==
    /\ status = "active"
    /\ pc[i] = "idle"
    /\ pc' = [pc EXCEPT ![i] = "awaiting"]
    /\ UNCHANGED <<status, jr, appends, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, ploc, reprep, inlineMeasured, badCommit>>

WorkerRun(i) ==
    /\ ~MeasureOnLoop
    /\ pc[i] = "awaiting"
    /\ ploc' = [ploc EXCEPT ![i] = Len(jr)]
    /\ pc' = [pc EXCEPT ![i] = "ready"]
    /\ IF SeparateWrite /\ status = "active"
          THEN jr' = Append(jr, ContributionEv(Len(jr) + Seen))
          ELSE jr' = jr
    /\ UNCHANGED <<status, appends, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, reprep, inlineMeasured, badCommit>>

LoopMeasureStart(i) ==
    /\ MeasureOnLoop
    /\ pc[i] = "awaiting"
    /\ ~loopBusy
    /\ loopBusy' = TRUE
    /\ ploc' = [ploc EXCEPT ![i] = Len(jr)]
    /\ pc' = [pc EXCEPT ![i] = "measuring"]
    /\ UNCHANGED <<status, jr, appends, wcrashes, dcrashes, stalls, lease, ownBlock,
                   cur, reprep, inlineMeasured, badCommit>>

LoopMeasureEnd(i) ==
    /\ MeasureOnLoop
    /\ pc[i] = "measuring"
    /\ loopBusy' = FALSE
    /\ pc' = [pc EXCEPT ![i] = "ready"]
    /\ UNCHANGED <<status, jr, appends, wcrashes, dcrashes, stalls, lease, ownBlock,
                   cur, ploc, reprep, inlineMeasured, badCommit>>

WorkerCrash ==
    /\ wcrashes < MaxWorkerCrashes
    /\ \E i \in Instances : pc[i] = "awaiting"
    /\ wcrashes' = wcrashes + 1
    /\ pc' = [i \in Instances |-> IF pc[i] = "awaiting" THEN "failed" ELSE pc[i]]
    /\ UNCHANGED <<status, jr, appends, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, ploc, reprep, inlineMeasured, badCommit>>

Fresh(i) == ploc[i] = Len(jr)

Fenced(i) == IF i \in Holders THEN cur[i] ELSE TRUE

WriteTerminal(i, cov, measuredInline) ==
    /\ jr' = jr \o LeadingEvents \o (IF SeparateWrite THEN <<>> ELSE <<ContributionEv(cov)>>) \o <<TermEv>>
    /\ status' = "terminal"
    /\ pc' = [pc EXCEPT ![i] = "done"]
    /\ inlineMeasured' = (inlineMeasured \/ measuredInline)
    /\ badCommit' = (badCommit \/ ~Fenced(i))

CommitFresh(i) ==
    /\ pc[i] = "ready"
    /\ status = "active"
    /\ (Fenced(i) \/ NoFence)
    /\ (Fresh(i) \/ NoRePrepare \/ SeparateWrite)
    /\ WriteTerminal(i, ploc[i] + Seen, FALSE)
    /\ UNCHANGED <<appends, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, ploc, reprep>>

CommitInline(i) ==
    /\ CommitMeasuresInline
    /\ pc[i] = "ready"
    /\ status = "active"
    /\ Fenced(i)
    /\ ~Fresh(i)
    /\ WriteTerminal(i, Len(jr) + Leading, TRUE)
    /\ UNCHANGED <<appends, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, ploc, reprep>>

CommitRefuseStale(i) ==
    /\ ~CommitMeasuresInline
    /\ ~NoRePrepare
    /\ ~SeparateWrite
    /\ pc[i] = "ready"
    /\ status = "active"
    /\ Fenced(i)
    /\ ~Fresh(i)
    /\ pc' = [pc EXCEPT ![i] = "idle"]
    /\ reprep' = [reprep EXCEPT ![i] = reprep[i] + 1]
    /\ UNCHANGED <<status, jr, appends, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, ploc, inlineMeasured, badCommit>>

CommitLost(i) ==
    /\ ~NoFence
    /\ pc[i] = "ready"
    /\ status = "active"
    /\ ~Fenced(i)
    /\ pc' = [pc EXCEPT ![i] = "lost"]
    /\ UNCHANGED <<status, jr, appends, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, ploc, reprep, inlineMeasured, badCommit>>

Stop(i) ==
    /\ status = "terminal"
    /\ pc[i] \in Live
    /\ pc' = [pc EXCEPT ![i] = "done"]
    /\ UNCHANGED <<status, jr, appends, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, ploc, reprep, inlineMeasured, badCommit>>

ExpireHolderGone ==
    /\ status = "active"
    /\ lease = "held"
    /\ ~HolderAlive
    /\ lease' = "free"
    /\ UNCHANGED <<status, jr, appends, wcrashes, dcrashes, stalls, loopBusy, ownBlock,
                   pc, cur, ploc, reprep, inlineMeasured, badCommit>>

ExpireBlocked ==
    /\ status = "active"
    /\ lease = "held"
    /\ HolderAlive
    /\ loopBusy
    /\ lease' = "free"
    /\ ownBlock' = TRUE
    /\ UNCHANGED <<status, jr, appends, wcrashes, dcrashes, stalls, loopBusy,
                   pc, cur, ploc, reprep, inlineMeasured, badCommit>>

ExpireStall ==
    /\ status = "active"
    /\ lease = "held"
    /\ HolderAlive
    /\ stalls < MaxStalls
    /\ stalls' = stalls + 1
    /\ lease' = "free"
    /\ UNCHANGED <<status, jr, appends, wcrashes, dcrashes, loopBusy, ownBlock,
                   pc, cur, ploc, reprep, inlineMeasured, badCommit>>

DaemonCrash ==
    /\ status = "active"
    /\ dcrashes < MaxDaemonCrashes
    /\ dcrashes' = dcrashes + 1
    /\ pc' = [i \in Instances |-> IF pc[i] \in Live THEN "dead" ELSE pc[i]]
    /\ loopBusy' = FALSE
    /\ UNCHANGED <<status, jr, appends, wcrashes, stalls, lease, ownBlock,
                   cur, ploc, reprep, inlineMeasured, badCommit>>

Stutter == UNCHANGED vars

Next ==
    \/ External
    \/ StartService
    \/ WorkerCrash
    \/ ExpireHolderGone
    \/ ExpireBlocked
    \/ ExpireStall
    \/ DaemonCrash
    \/ Stutter
    \/ \E i \in Instances :
        \/ Plan(i)
        \/ WorkerRun(i)
        \/ LoopMeasureStart(i)
        \/ LoopMeasureEnd(i)
        \/ CommitFresh(i)
        \/ CommitInline(i)
        \/ CommitRefuseStale(i)
        \/ CommitLost(i)
        \/ Stop(i)
    \/ \E h \in Holders : Reclaim(h)

Fairness ==
    /\ \A i \in Instances :
        /\ WF_vars(Plan(i))
        /\ WF_vars(WorkerRun(i))
        /\ WF_vars(LoopMeasureStart(i))
        /\ WF_vars(LoopMeasureEnd(i))
        /\ WF_vars(CommitFresh(i))
        /\ WF_vars(CommitInline(i))
        /\ WF_vars(CommitRefuseStale(i))
        /\ WF_vars(CommitLost(i))
        /\ WF_vars(Stop(i))
    /\ \A h \in Holders : WF_vars(Reclaim(h))
    /\ WF_vars(ExpireHolderGone)

Spec == Init /\ [][Next]_vars

LiveSpec == Spec /\ Fairness

AtMostOneContribution == Cardinality(Positions("C")) <= 1

ContributionCoversJournal == \A p \in Positions("C") : jr[p].cov = p - 1

TerminalAtomic ==
    /\ (status = "terminal") <=> (Positions("T") # {})
    /\ \A p \in Positions("C") : p < Len(jr) /\ jr[p + 1].k = "T"
    /\ (Positions("C") # {} => status = "terminal")

CommitNeverMeasures == ~inlineMeasured

FencedCommit == ~badCommit

LeaseKeptWhileAwaiting == ~ownBlock

RePrepareBounded == \A i \in Instances : reprep[i] <= MaxAppends

Terminates == <>(status = "terminal")

=============================================================================
