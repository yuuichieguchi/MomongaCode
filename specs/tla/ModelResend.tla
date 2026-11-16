---------------------------- MODULE ModelResend ----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS MaxClaims, MaxCrashes, MaxChanges, AttemptOnReject

NoCounter == 99

Attempts == 1..(MaxClaims + 1)
Pcs == {"none", "claimed", "recorded", "sent", "got", "acc", "rej"}
Phases == {"run", "done", "failed"}

VARIABLES
    phase,
    pc,
    claims,
    crashes,
    changes,
    gwCtr,
    mCtr,
    reqRec,
    recAtt,
    att,
    gw,
    gwAns,
    calls,
    recRejected,
    decidedRejected,
    redelivered,
    redeliveredDecided,
    accCtr,
    accMeter,
    charged

vars == <<phase, pc, claims, crashes, changes, gwCtr, mCtr, reqRec, recAtt, att, gw, gwAns, calls,
          recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter, charged>>

TypeOK ==
    /\ phase \in Phases
    /\ pc \in Pcs
    /\ claims \in 0..MaxClaims
    /\ crashes \in 0..MaxCrashes
    /\ changes \in 0..MaxChanges
    /\ gwCtr \in 0..MaxChanges
    /\ mCtr \in 0..MaxChanges
    /\ reqRec \in BOOLEAN
    /\ recAtt \in Attempts
    /\ att \in Attempts
    /\ gw \in [Attempts -> {"none", "inflight", "done"}]
    /\ gwAns \in [Attempts -> (0..MaxChanges) \cup {NoCounter}]
    /\ calls \in [Attempts -> 0..MaxClaims]
    /\ recRejected \subseteq Attempts
    /\ decidedRejected \subseteq Attempts
    /\ redelivered \in BOOLEAN
    /\ redeliveredDecided \in BOOLEAN
    /\ accCtr \in (0..MaxChanges) \cup {NoCounter}
    /\ accMeter \in (0..MaxChanges) \cup {NoCounter}
    /\ charged \in [Attempts -> 0..MaxClaims]

Init ==
    /\ phase = "run"
    /\ pc = "none"
    /\ claims = 0
    /\ crashes = 0
    /\ changes = 0
    /\ gwCtr = 0
    /\ mCtr = 0
    /\ reqRec = FALSE
    /\ recAtt = 1
    /\ att = 1
    /\ gw = [a \in Attempts |-> "none"]
    /\ gwAns = [a \in Attempts |-> NoCounter]
    /\ calls = [a \in Attempts |-> 0]
    /\ recRejected = {}
    /\ decidedRejected = {}
    /\ redelivered = FALSE
    /\ redeliveredDecided = FALSE
    /\ accCtr = NoCounter
    /\ accMeter = NoCounter
    /\ charged = [a \in Attempts |-> 0]

Claim ==
    /\ phase = "run"
    /\ pc = "none"
    /\ claims < MaxClaims
    /\ claims' = claims + 1
    /\ mCtr' = gwCtr
    /\ pc' = "claimed"
    /\ UNCHANGED <<phase, crashes, changes, gwCtr, reqRec, recAtt, att, gw, gwAns, calls,
                   recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter, charged>>

Exhaust ==
    /\ phase = "run"
    /\ pc = "none"
    /\ claims = MaxClaims
    /\ phase' = "failed"
    /\ UNCHANGED <<pc, claims, crashes, changes, gwCtr, mCtr, reqRec, recAtt, att, gw, gwAns, calls,
                   recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter, charged>>

Record ==
    /\ pc = "claimed"
    /\ reqRec' = TRUE
    /\ pc' = "recorded"
    /\ UNCHANGED <<phase, claims, crashes, changes, gwCtr, mCtr, recAtt, att, gw, gwAns, calls,
                   recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter, charged>>

Send ==
    /\ pc = "recorded"
    /\ att' = recAtt
    /\ pc' = "sent"
    /\ IF gw[recAtt] = "none"
          THEN /\ gw' = [gw EXCEPT ![recAtt] = "inflight"]
               /\ gwAns' = [gwAns EXCEPT ![recAtt] = gwCtr]
               /\ calls' = [calls EXCEPT ![recAtt] = @ + 1]
          ELSE UNCHANGED <<gw, gwAns, calls>>
    /\ UNCHANGED <<phase, claims, crashes, changes, gwCtr, mCtr, reqRec, recAtt,
                   recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter, charged>>

Finish ==
    /\ \E a \in Attempts :
        /\ gw[a] = "inflight"
        /\ gw' = [gw EXCEPT ![a] = "done"]
    /\ UNCHANGED <<phase, pc, claims, crashes, changes, gwCtr, mCtr, reqRec, recAtt, att, gwAns, calls,
                   recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter, charged>>

Deliver ==
    /\ pc = "sent"
    /\ gw[att] = "done"
    /\ pc' = "got"
    /\ redelivered' = (redelivered \/ att \in recRejected)
    /\ redeliveredDecided' = (redeliveredDecided \/ att \in decidedRejected)
    /\ UNCHANGED <<phase, claims, crashes, changes, gwCtr, mCtr, reqRec, recAtt, att, gw, gwAns, calls,
                   recRejected, decidedRejected, accCtr, accMeter, charged>>

Decide ==
    /\ pc = "got"
    /\ IF gwAns[att] = mCtr
          THEN /\ pc' = "acc"
               /\ UNCHANGED decidedRejected
          ELSE /\ pc' = "rej"
               /\ decidedRejected' = decidedRejected \cup {att}
    /\ UNCHANGED <<phase, claims, crashes, changes, gwCtr, mCtr, reqRec, recAtt, att, gw, gwAns, calls,
                   recRejected, redelivered, redeliveredDecided, accCtr, accMeter, charged>>

RecordAccept ==
    /\ pc = "acc"
    /\ phase' = "done"
    /\ accCtr' = gwAns[att]
    /\ accMeter' = mCtr
    /\ charged' = [charged EXCEPT ![att] = @ + 1]
    /\ pc' = "none"
    /\ UNCHANGED <<claims, crashes, changes, gwCtr, mCtr, reqRec, recAtt, att, gw, gwAns, calls,
                   recRejected, decidedRejected, redelivered, redeliveredDecided>>

RecordReject ==
    /\ pc = "rej"
    /\ recRejected' = recRejected \cup {att}
    /\ recAtt' = IF AttemptOnReject THEN att + 1 ELSE att
    /\ charged' = [charged EXCEPT ![att] = @ + 1]
    /\ pc' = "none"
    /\ UNCHANGED <<phase, claims, crashes, changes, gwCtr, mCtr, reqRec, att, gw, gwAns, calls,
                   decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter>>

Crash ==
    /\ phase = "run"
    /\ pc # "none"
    /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ pc' = "none"
    /\ UNCHANGED <<phase, claims, changes, gwCtr, mCtr, reqRec, recAtt, att, gw, gwAns, calls,
                   recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter, charged>>

CounterChange ==
    /\ phase = "run"
    /\ changes < MaxChanges
    /\ changes' = changes + 1
    /\ gwCtr' = gwCtr + 1
    /\ UNCHANGED <<phase, pc, claims, crashes, mCtr, reqRec, recAtt, att, gw, gwAns, calls,
                   recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter, charged>>

Ended ==
    /\ phase # "run"
    /\ UNCHANGED vars

Next ==
    \/ Ended
    \/ Claim
    \/ Exhaust
    \/ Record
    \/ Send
    \/ Finish
    \/ Deliver
    \/ Decide
    \/ RecordAccept
    \/ RecordReject
    \/ Crash
    \/ CounterChange

Progress ==
    \/ Claim
    \/ Exhaust
    \/ Record
    \/ Send
    \/ Finish
    \/ Deliver
    \/ Decide
    \/ RecordAccept
    \/ RecordReject

Spec == Init /\ [][Next]_vars /\ WF_vars(Progress)

OneUpstreamCallPerAttempt == \A a \in Attempts : calls[a] <= 1

RejectedNeverRedelivered == ~redelivered

AcceptedMatchesCounter == phase = "done" => accCtr = accMeter

DecidedRejectsNeverRedelivered == ~redeliveredDecided

NotFailed == phase # "failed"

ChargedOncePerAttempt ==
    /\ \A a \in Attempts : charged[a] <= 1 /\ (charged[a] > 0 => calls[a] = 1)
    /\ \A a \in recRejected : charged[a] = 1
    /\ phase = "done" => charged[att] = 1

Accepted == <>(phase = "done")

=============================================================================
