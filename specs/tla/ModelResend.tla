---------------------------- MODULE ModelResend ----------------------------
(***************************************************************************)
(* Design model of the resend of one model request across claims, with the *)
(* gateway's stored answers. It describes the rule proposed for T0, not    *)
(* the code of today, except in ModelResend.fixedAttempt.                  *)
(*                                                                         *)
(* Code sources modelled                                                   *)
(*   packages/runtime/src/worker/model-step.ts:220  the idempotency key    *)
(*       modelKey(run.id, step, attempt) of a call                         *)
(*   packages/runtime/src/worker/model-step.ts:232  resumeInFlight: a      *)
(*       claim that finds a recorded model.requested without its answer    *)
(*       resends the recorded body with the recorded attempt (Claim,       *)
(*       Record, Send)                                                     *)
(*   packages/runtime/src/worker/model-step.ts:18,:270  MODEL_ATTEMPT = 1  *)
(*       (AttemptOnReject = FALSE is this code)                            *)
(*   packages/store/src/fold.ts:348  model.requested carries the attempt   *)
(*       (recAtt)                                                          *)
(*   packages/gateway/src/core/idempotency.ts:46-52  a stored answer with  *)
(*       the same key and digest is replayed without the upstream (Send    *)
(*       on a "done" entry); the ttl of 7 days is not modelled             *)
(*   packages/gateway/src/core/store.ts:235  a completed answer is stored  *)
(*       under its key (Finish)                                            *)
(*   t2-t5-design.md M4, "A report of another counter within a claim": the *)
(*       runtime rejects a complete answer whose counter differs from the  *)
(*       counter of its meter; the claim ends with GatewayFailureError and *)
(*       the run is requeued (Decide, RecordReject, the claim count)       *)
(*                                                                         *)
(* The rule (AttemptOnReject = TRUE)                                       *)
(*   - the key of a call is (run, step, attempt)                           *)
(*   - a claim that resends a recorded request keeps the attempt, so the   *)
(*     gateway replays the stored answer or joins the call in flight       *)
(*   - when the runtime rejects a complete answer it records the rejection *)
(*     with that attempt before the claim ends; the next claim resends the *)
(*     recorded body under attempt + 1 (RecordReject)                      *)
(*                                                                         *)
(* Abstractions (a proof holds only for this model):                       *)
(*   - one run, one model step, one request body; the digest never differs *)
(*   - the answer is only the counter that produced it; usage, frames and  *)
(*     streaming are not modelled                                          *)
(*   - the meter's counter is read once at claim start (mCtr) from the     *)
(*     gateway's counter; the gateway's counter changes a bounded number   *)
(*     of times at any moment (a gateway restart with a new target         *)
(*     definition). An in-flight call keeps the counter it started with    *)
(*   - the upstream call is one action (start) and one action (finish);    *)
(*     the gateway survives a crash of the runtime, and a call in flight   *)
(*     finishes and is stored                                              *)
(*   - the gateway's store is never lost and never expires                 *)
(*   - every claim that ends without an accepted answer (crash or          *)
(*     rejection) uses one of MaxClaims attempts of the run; when they are *)
(*     used up the run is FAILED                                           *)
(*   - the other failure and retry paths of the step (compaction           *)
(*     recovery, deadline, cancel, stream restart) are not modelled        *)
(*   - the recording of the rejection and of the accepted answer is one    *)
(*     atomic append each                                                  *)
(*                                                                         *)
(* Configurations (scripts/tlc.sh <name>, specs/tla/<name>.cfg)            *)
(*   ModelResend             the rule, enough claims for every crash and   *)
(*                           counter change; every invariant and Settles   *)
(*                           (under weak fairness of the runtime and the   *)
(*                           gateway): holds                               *)
(*   ModelResend.attemptLimit the rule with fewer claims than crashes and  *)
(*                           changes, so the run can end FAILED; every     *)
(*                           invariant: holds                              *)
(*   ModelResend.fixedAttempt the attempt stays 1 (the code of today):     *)
(*                           RejectedNeverRedelivered refuted (a stored    *)
(*                           rejected answer is replayed to every next     *)
(*                           claim)                                        *)
(*                                                                         *)
(* Finding (crash window): the rule records the rejection after the        *)
(* claim has decided it. A crash between the decision and the record       *)
(* leaves no trace, so the next claim receives the same answer again. That *)
(* redelivery is not the stored answer of a recorded rejection and         *)
(* RejectedNeverRedelivered (about recorded rejections) holds; it costs    *)
(* one more claim. DecidedRejects / RedeliveredDecided expose it.          *)
(***************************************************************************)
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
    accMeter

vars == <<phase, pc, claims, crashes, changes, gwCtr, mCtr, reqRec, recAtt, att, gw, gwAns, calls,
          recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter>>

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

Claim ==
    /\ phase = "run"
    /\ pc = "none"
    /\ claims < MaxClaims
    /\ claims' = claims + 1
    /\ mCtr' = gwCtr
    /\ pc' = "claimed"
    /\ UNCHANGED <<phase, crashes, changes, gwCtr, reqRec, recAtt, att, gw, gwAns, calls,
                   recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter>>

Exhaust ==
    /\ phase = "run"
    /\ pc = "none"
    /\ claims = MaxClaims
    /\ phase' = "failed"
    /\ UNCHANGED <<pc, claims, crashes, changes, gwCtr, mCtr, reqRec, recAtt, att, gw, gwAns, calls,
                   recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter>>

Record ==
    /\ pc = "claimed"
    /\ reqRec' = TRUE
    /\ pc' = "recorded"
    /\ UNCHANGED <<phase, claims, crashes, changes, gwCtr, mCtr, recAtt, att, gw, gwAns, calls,
                   recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter>>

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
                   recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter>>

Finish ==
    /\ \E a \in Attempts :
        /\ gw[a] = "inflight"
        /\ gw' = [gw EXCEPT ![a] = "done"]
    /\ UNCHANGED <<phase, pc, claims, crashes, changes, gwCtr, mCtr, reqRec, recAtt, att, gwAns, calls,
                   recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter>>

Deliver ==
    /\ pc = "sent"
    /\ gw[att] = "done"
    /\ pc' = "got"
    /\ redelivered' = (redelivered \/ att \in recRejected)
    /\ redeliveredDecided' = (redeliveredDecided \/ att \in decidedRejected)
    /\ UNCHANGED <<phase, claims, crashes, changes, gwCtr, mCtr, reqRec, recAtt, att, gw, gwAns, calls,
                   recRejected, decidedRejected, accCtr, accMeter>>

Decide ==
    /\ pc = "got"
    /\ IF gwAns[att] = mCtr
          THEN /\ pc' = "acc"
               /\ UNCHANGED decidedRejected
          ELSE /\ pc' = "rej"
               /\ decidedRejected' = decidedRejected \cup {att}
    /\ UNCHANGED <<phase, claims, crashes, changes, gwCtr, mCtr, reqRec, recAtt, att, gw, gwAns, calls,
                   recRejected, redelivered, redeliveredDecided, accCtr, accMeter>>

RecordAccept ==
    /\ pc = "acc"
    /\ phase' = "done"
    /\ accCtr' = gwAns[att]
    /\ accMeter' = mCtr
    /\ pc' = "none"
    /\ UNCHANGED <<claims, crashes, changes, gwCtr, mCtr, reqRec, recAtt, att, gw, gwAns, calls,
                   recRejected, decidedRejected, redelivered, redeliveredDecided>>

RecordReject ==
    /\ pc = "rej"
    /\ recRejected' = recRejected \cup {att}
    /\ recAtt' = IF AttemptOnReject THEN att + 1 ELSE att
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
                   recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter>>

CounterChange ==
    /\ phase = "run"
    /\ changes < MaxChanges
    /\ changes' = changes + 1
    /\ gwCtr' = gwCtr + 1
    /\ UNCHANGED <<phase, pc, claims, crashes, mCtr, reqRec, recAtt, att, gw, gwAns, calls,
                   recRejected, decidedRejected, redelivered, redeliveredDecided, accCtr, accMeter>>

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

Settles == <>(phase # "run")

Accepted == <>(phase = "done")

=============================================================================
