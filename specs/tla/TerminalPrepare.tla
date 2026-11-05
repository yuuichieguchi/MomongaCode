---------------------------- MODULE TerminalPrepare ----------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    MaxApprovals,
    MaxBeats,
    MaxWorkerCrashes,
    MaxDaemonCrashes,
    MaxStalls,
    LeadingChanges,
    HeartbeatAppends,
    CommitMeasuresInline,
    NoRePrepare,
    LeadingUnseen,
    ClockTwice,
    RowsRecomputed,
    SeparateWrite,
    NoFence,
    MeasureOnLoop,
    RetryAfterFailure

Holders == {"h1", "h2"}
Service == "s"
Instances == Holders \cup {Service}
Pcs == {"none", "idle", "awaiting", "measuring", "inlining", "ready", "done", "failed", "lost", "dead"}
Live == {"idle", "awaiting", "measuring", "inlining", "ready"}
Statuses == {"active", "terminal"}
LeaseStates == {"held", "free"}

VARIABLES
    status,
    jr,
    cancels,
    resolved,
    beats,
    wcrashes,
    dcrashes,
    stalls,
    lease,
    loopBusy,
    ownBlock,
    pc,
    cur,
    lead,
    pl,
    ploc,
    plead,
    reprep,
    inlineMeasured,
    badCommit,
    rowsMismatch

vars == <<status, jr, cancels, resolved, beats, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
          pc, cur, lead, pl, ploc, plead, reprep, inlineMeasured, badCommit, rowsMismatch>>

Ev == [k |-> "e"]
LeadEv == [k |-> "L"]
TermEv == [k |-> "T"]
ContributionEv(n) == [k |-> "C", cov |-> n]

Positions(kind) == {p \in 1..Len(jr) : jr[p].k = kind}

HolderAlive == \E h \in Holders : cur[h] /\ pc[h] \in Live

LeadEvents(n) == IF n = 1 THEN <<LeadEv>> ELSE <<>>

TypeOK ==
    /\ status \in Statuses
    /\ \A p \in 1..Len(jr) : jr[p].k \in {"e", "L", "C", "T"}
    /\ cancels \in 0..1
    /\ resolved \in 0..MaxApprovals
    /\ beats \in 0..MaxBeats
    /\ wcrashes \in 0..MaxWorkerCrashes
    /\ dcrashes \in 0..MaxDaemonCrashes
    /\ stalls \in 0..MaxStalls
    /\ lease \in LeaseStates
    /\ loopBusy \in BOOLEAN
    /\ ownBlock \in BOOLEAN
    /\ pc \in [Instances -> Pcs]
    /\ cur \in [Holders -> BOOLEAN]
    /\ lead \in 0..1
    /\ pl \in [Instances -> 0..1]
    /\ ploc \in [Instances -> Nat]
    /\ plead \in [Instances -> 0..1]
    /\ reprep \in [Instances -> Nat]
    /\ inlineMeasured \in BOOLEAN
    /\ badCommit \in BOOLEAN
    /\ rowsMismatch \in BOOLEAN

Init ==
    /\ status = "active"
    /\ jr = <<Ev>>
    /\ cancels = 0
    /\ resolved = 0
    /\ beats = 0
    /\ wcrashes = 0
    /\ dcrashes = 0
    /\ stalls = 0
    /\ lease = "held"
    /\ loopBusy = FALSE
    /\ ownBlock = FALSE
    /\ pc = [i \in Instances |-> IF i = "h1" THEN "idle" ELSE "none"]
    /\ cur = [h \in Holders |-> h = "h1"]
    /\ lead = 0
    /\ pl = [i \in Instances |-> 0]
    /\ ploc = [i \in Instances |-> 0]
    /\ plead = [i \in Instances |-> 0]
    /\ reprep = [i \in Instances |-> 0]
    /\ inlineMeasured = FALSE
    /\ badCommit = FALSE
    /\ rowsMismatch = FALSE

Cancel ==
    /\ status = "active"
    /\ cancels = 0
    /\ cancels' = 1
    /\ jr' = Append(jr, Ev)
    /\ UNCHANGED <<status, resolved, beats, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   pc, cur, lead, pl, ploc, plead, reprep, inlineMeasured, badCommit, rowsMismatch>>

Resolve ==
    /\ status = "active"
    /\ resolved < MaxApprovals
    /\ resolved' = resolved + 1
    /\ jr' = Append(jr, Ev)
    /\ UNCHANGED <<status, cancels, beats, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   pc, cur, lead, pl, ploc, plead, reprep, inlineMeasured, badCommit, rowsMismatch>>

Keepalive ==
    /\ HeartbeatAppends
    /\ status = "active"
    /\ HolderAlive
    /\ beats < MaxBeats
    /\ beats' = beats + 1
    /\ jr' = Append(jr, Ev)
    /\ UNCHANGED <<status, cancels, resolved, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   pc, cur, lead, pl, ploc, plead, reprep, inlineMeasured, badCommit, rowsMismatch>>

Due ==
    /\ LeadingChanges
    /\ status = "active"
    /\ lead = 0
    /\ lead' = 1
    /\ UNCHANGED <<status, jr, cancels, resolved, beats, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   pc, cur, pl, ploc, plead, reprep, inlineMeasured, badCommit, rowsMismatch>>

StartService ==
    /\ status = "active"
    /\ (pc[Service] \in {"none", "dead", "lost"} \/ (pc[Service] = "failed" /\ RetryAfterFailure))
    /\ pc' = [pc EXCEPT ![Service] = "idle"]
    /\ reprep' = [reprep EXCEPT ![Service] = 0]
    /\ UNCHANGED <<status, jr, cancels, resolved, beats, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, lead, pl, ploc, plead, inlineMeasured, badCommit, rowsMismatch>>

Reclaim(h) ==
    /\ status = "active"
    /\ lease = "free"
    /\ pc[h] \in {"none", "dead", "failed", "lost"}
    /\ (RetryAfterFailure \/ \A g \in Holders : pc[g] # "failed")
    /\ lease' = "held"
    /\ cur' = [g \in Holders |-> g = h]
    /\ pc' = [pc EXCEPT ![h] = "idle"]
    /\ reprep' = [reprep EXCEPT ![h] = 0]
    /\ UNCHANGED <<status, jr, cancels, resolved, beats, wcrashes, dcrashes, stalls, loopBusy, ownBlock,
                   lead, pl, ploc, plead, inlineMeasured, badCommit, rowsMismatch>>

Plan(i) ==
    /\ status = "active"
    /\ pc[i] = "idle"
    /\ pc' = [pc EXCEPT ![i] = "awaiting"]
    /\ pl' = [pl EXCEPT ![i] = lead]
    /\ UNCHANGED <<status, jr, cancels, resolved, beats, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, lead, ploc, plead, reprep, inlineMeasured, badCommit, rowsMismatch>>

SeenBy(i) == IF LeadingUnseen THEN 0 ELSE pl[i]

WorkerRun(i) ==
    /\ ~MeasureOnLoop
    /\ pc[i] = "awaiting"
    /\ ploc' = [ploc EXCEPT ![i] = Len(jr)]
    /\ plead' = [plead EXCEPT ![i] = SeenBy(i)]
    /\ pc' = [pc EXCEPT ![i] = "ready"]
    /\ IF SeparateWrite /\ status = "active"
          THEN jr' = Append(jr, ContributionEv(Len(jr) + SeenBy(i)))
          ELSE jr' = jr
    /\ UNCHANGED <<status, cancels, resolved, beats, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, lead, pl, reprep, inlineMeasured, badCommit, rowsMismatch>>

LoopMeasureStart(i) ==
    /\ MeasureOnLoop
    /\ pc[i] = "awaiting"
    /\ ~loopBusy
    /\ loopBusy' = TRUE
    /\ ploc' = [ploc EXCEPT ![i] = Len(jr)]
    /\ plead' = [plead EXCEPT ![i] = SeenBy(i)]
    /\ pc' = [pc EXCEPT ![i] = "measuring"]
    /\ UNCHANGED <<status, jr, cancels, resolved, beats, wcrashes, dcrashes, stalls, lease, ownBlock,
                   cur, lead, pl, reprep, inlineMeasured, badCommit, rowsMismatch>>

LoopMeasureEnd(i) ==
    /\ MeasureOnLoop
    /\ pc[i] = "measuring"
    /\ loopBusy' = FALSE
    /\ pc' = [pc EXCEPT ![i] = "ready"]
    /\ UNCHANGED <<status, jr, cancels, resolved, beats, wcrashes, dcrashes, stalls, lease, ownBlock,
                   cur, lead, pl, ploc, plead, reprep, inlineMeasured, badCommit, rowsMismatch>>

WorkerCrash ==
    /\ wcrashes < MaxWorkerCrashes
    /\ \E i \in Instances : pc[i] = "awaiting"
    /\ wcrashes' = wcrashes + 1
    /\ pc' = [i \in Instances |-> IF pc[i] = "awaiting" THEN "failed" ELSE pc[i]]
    /\ UNCHANGED <<status, jr, cancels, resolved, beats, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, lead, pl, ploc, plead, reprep, inlineMeasured, badCommit, rowsMismatch>>

Fresh(i) == ploc[i] = Len(jr)

Fenced(i) == IF i \in Holders THEN cur[i] ELSE TRUE

CommitLeading(i) == IF ClockTwice THEN lead ELSE pl[i]

RowsEnded(i) == IF RowsRecomputed THEN lead ELSE CommitLeading(i)

WriteTerminal(i, cov, measuredInline) ==
    /\ jr' = jr \o LeadEvents(CommitLeading(i)) \o (IF SeparateWrite THEN <<>> ELSE <<ContributionEv(cov)>>) \o <<TermEv>>
    /\ status' = "terminal"
    /\ pc' = [pc EXCEPT ![i] = "done"]
    /\ inlineMeasured' = (inlineMeasured \/ measuredInline)
    /\ badCommit' = (badCommit \/ ~Fenced(i))
    /\ rowsMismatch' = (rowsMismatch \/ RowsEnded(i) # CommitLeading(i))

CommitFresh(i) ==
    /\ pc[i] = "ready"
    /\ status = "active"
    /\ (Fenced(i) \/ NoFence)
    /\ (Fresh(i) \/ NoRePrepare \/ SeparateWrite)
    /\ WriteTerminal(i, ploc[i] + plead[i], FALSE)
    /\ UNCHANGED <<cancels, resolved, beats, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, lead, pl, ploc, plead, reprep>>

CommitInlineStart(i) ==
    /\ CommitMeasuresInline
    /\ pc[i] = "ready"
    /\ status = "active"
    /\ Fenced(i)
    /\ ~Fresh(i)
    /\ ~loopBusy
    /\ loopBusy' = TRUE
    /\ pc' = [pc EXCEPT ![i] = "inlining"]
    /\ UNCHANGED <<status, jr, cancels, resolved, beats, wcrashes, dcrashes, stalls, lease, ownBlock,
                   cur, lead, pl, ploc, plead, reprep, inlineMeasured, badCommit, rowsMismatch>>

CommitInlineEnd(i) ==
    /\ CommitMeasuresInline
    /\ pc[i] = "inlining"
    /\ status = "active"
    /\ Fenced(i)
    /\ loopBusy' = FALSE
    /\ WriteTerminal(i, Len(jr) + CommitLeading(i), TRUE)
    /\ UNCHANGED <<cancels, resolved, beats, wcrashes, dcrashes, stalls, lease, ownBlock,
                   cur, lead, pl, ploc, plead, reprep>>

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
    /\ UNCHANGED <<status, jr, cancels, resolved, beats, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, lead, pl, ploc, plead, inlineMeasured, badCommit, rowsMismatch>>

CommitLost(i) ==
    /\ ~NoFence
    /\ pc[i] \in {"ready", "inlining"}
    /\ status = "active"
    /\ ~Fenced(i)
    /\ pc' = [pc EXCEPT ![i] = "lost"]
    /\ loopBusy' = (loopBusy /\ pc[i] # "inlining")
    /\ UNCHANGED <<status, jr, cancels, resolved, beats, wcrashes, dcrashes, stalls, lease, ownBlock,
                   cur, lead, pl, ploc, plead, reprep, inlineMeasured, badCommit, rowsMismatch>>

Stop(i) ==
    /\ status = "terminal"
    /\ pc[i] \in Live
    /\ pc' = [pc EXCEPT ![i] = "done"]
    /\ UNCHANGED <<status, jr, cancels, resolved, beats, wcrashes, dcrashes, stalls, lease, loopBusy, ownBlock,
                   cur, lead, pl, ploc, plead, reprep, inlineMeasured, badCommit, rowsMismatch>>

ExpireHolderGone ==
    /\ status = "active"
    /\ lease = "held"
    /\ ~HolderAlive
    /\ lease' = "free"
    /\ UNCHANGED <<status, jr, cancels, resolved, beats, wcrashes, dcrashes, stalls, loopBusy, ownBlock,
                   pc, cur, lead, pl, ploc, plead, reprep, inlineMeasured, badCommit, rowsMismatch>>

ExpireBlocked ==
    /\ status = "active"
    /\ lease = "held"
    /\ HolderAlive
    /\ loopBusy
    /\ lease' = "free"
    /\ ownBlock' = TRUE
    /\ UNCHANGED <<status, jr, cancels, resolved, beats, wcrashes, dcrashes, stalls, loopBusy,
                   pc, cur, lead, pl, ploc, plead, reprep, inlineMeasured, badCommit, rowsMismatch>>

ExpireStall ==
    /\ status = "active"
    /\ lease = "held"
    /\ HolderAlive
    /\ stalls < MaxStalls
    /\ stalls' = stalls + 1
    /\ lease' = "free"
    /\ UNCHANGED <<status, jr, cancels, resolved, beats, wcrashes, dcrashes, loopBusy, ownBlock,
                   pc, cur, lead, pl, ploc, plead, reprep, inlineMeasured, badCommit, rowsMismatch>>

DaemonCrash ==
    /\ status = "active"
    /\ dcrashes < MaxDaemonCrashes
    /\ dcrashes' = dcrashes + 1
    /\ pc' = [i \in Instances |-> IF pc[i] \in Live THEN "dead" ELSE pc[i]]
    /\ loopBusy' = FALSE
    /\ UNCHANGED <<status, jr, cancels, resolved, beats, wcrashes, stalls, lease, ownBlock,
                   cur, lead, pl, ploc, plead, reprep, inlineMeasured, badCommit, rowsMismatch>>

Stutter == UNCHANGED vars

Next ==
    \/ Cancel
    \/ Resolve
    \/ Keepalive
    \/ Due
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
        \/ CommitInlineStart(i)
        \/ CommitInlineEnd(i)
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
        /\ WF_vars(CommitInlineStart(i))
        /\ WF_vars(CommitInlineEnd(i))
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

ApprovalRowsMatchJournal == ~rowsMismatch

LeaseKeptWhileAwaiting == ~ownBlock

RePrepareBounded == \A i \in Instances : reprep[i] <= 1 + MaxApprovals

Terminates == <>(status = "terminal")

=============================================================================
