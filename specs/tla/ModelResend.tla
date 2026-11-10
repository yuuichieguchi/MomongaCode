---------------------------- MODULE ModelResend ----------------------------
(***************************************************************************)
(* Design model of the resend of one model request across claims, with the *)
(* gateway's stored answers. It describes the rule of the code, except in  *)
(* ModelResend.fixedAttempt, which keeps the attempt fixed.                *)
(*                                                                         *)
(* Code sources modelled (test/spec-drift-model-resend.test.ts checks     *)
(* every file:line below against the code)                                 *)
(*   packages/runtime/src/worker/model-step.ts:307  the idempotency key    *)
(*       modelKey(run.id, step, attempt) of a call                         *)
(*   packages/runtime/src/worker/model-step.ts:315-319  resumeInFlight: a  *)
(*       claim that finds a recorded model.requested without its answer    *)
(*       resends the recorded body with the recorded attempt (Claim,       *)
(*       Record, Send)                                                     *)
(*   packages/runtime/src/worker/model-step.ts:169  reject: the rejection  *)
(*       is appended as model.rejected with its usage.charged              *)
(*   packages/store/src/fold.ts:381  model.requested carries the attempt   *)
(*       (recAtt)                                                          *)
(*   packages/store/src/fold.ts:408-411  model.rejected raises the         *)
(*       recorded attempt by one (AttemptOnReject = TRUE is this code;     *)
(*       ModelResend.fixedAttempt describes the code before that rule)     *)
(*   packages/gateway/src/core/idempotency.ts:43,:52  a request with the   *)
(*       same key and digest joins the call in flight or replays the       *)
(*       stored answer without the upstream (Send on an "inflight" or      *)
(*       "done" entry); the ttl of 7 days is not modelled                  *)
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
(*   - the answer is only the counter that produced it; token amounts,     *)
(*     frames and streaming are not modelled; a charge is one count per    *)
(*     recorded outcome (charged). In the code a rejection's charge is a   *)
(*     usage.charged event (purpose rejected_answer) appended atomically   *)
(*     with model.rejected, and an acceptance's charge is model.responded  *)
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
(*   - the outcome (accept or reject) is charged once, when it is recorded:*)
(*     the event model.rejected carries the usage of the rejected answer and*)
(*     the run's spend counts it (charged); a replayed answer costs nothing*)
(*   - joining a call in flight always succeeds; in the code a resend can get*)
(*     409 idempotency_key_in_progress when the call is no longer joinable*)
(*     (gateway/src/core/idempotency.ts:42, run.ts:215), which is requeued and*)
(*     costs a claim                                                      *)
(*   - one target, so one meter; a fallback meter is compared the same way*)
(*     against its own counter from the claim's listing                   *)
(*                                                                         *)
(* Configurations (scripts/tlc.sh <name>, specs/tla/<name>.cfg)            *)
(*   ModelResend             the rule, enough claims for every crash and   *)
(*                           counter change; every invariant and Accepted  *)
(*                           (under weak fairness of the runtime and the   *)
(*                           gateway): holds                               *)
(*   ModelResend.attemptLimit the rule with fewer claims than crashes and  *)
(*                           changes, so the run can end FAILED; every     *)
(*                           invariant: holds                              *)
(*   ModelResend.attemptLimitReached  the attemptLimit constants, NotFailed *)
(*                           refuted: the FAILED end is reachable          *)
(*   ModelResend.decisionCrash the ModelResend constants,                  *)
(*                           DecidedRejectsNeverRedelivered refuted: a     *)
(*                           crash between the decision and the record     *)
(*                           redelivers the answer; the design accepts it  *)
(*   ModelResend.fixedAttempt the attempt stays 1 (the code of today):     *)
(*                           RejectedNeverRedelivered refuted (a stored    *)
(*                           rejected answer is replayed to every next     *)
(*                           claim)                                        *)
(*                                                                         *)
(* AcceptedMatchesCounter holds by construction of Decide; it is a sanity  *)
(* check of the model, not evidence.                                       *)
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
