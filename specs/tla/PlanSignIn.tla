-------------------------- MODULE PlanSignIn --------------------------
(***************************************************************************)
(* Design model of the sign-in attempts of a ChatGPT plan account in the   *)
(* gateway (design-chatgpt-plan.md sections 5.1 to 5.3 and 9, increment    *)
(* P5b). It describes what the design says the code does.                   *)
(*                                                                         *)
(* Modelled                                                                *)
(*   - the attempt table: begin (one pending attempt per label, a new      *)
(*     begin replaces the pending one), the pending attempt TTL, the sweep *)
(*     that expires an attempt, complete (the attempt is looked up and      *)
(*     consumed in one step), replays of a callback on an attempt that is  *)
(*     no longer pending                                                    *)
(*   - the steps of complete in the order of section 5.3: state and client *)
(*     check (steps 2 and 3), the registered record (step 4), the exchange *)
(*     (step 5), the subject check (steps 7 and 8, the ID token verdict    *)
(*     and the scope verdict), the install (steps 9 and 10), each a        *)
(*     separate step so attempts interleave                                 *)
(*   - the record per label: absent, registered, active, plan_disabled,    *)
(*     with the issued client id and the subject                           *)
(*   - the client ids that OpenAI has issued to attempts of a label        *)
(*   - a crash of the gateway: the attempt table is memory and is lost,    *)
(*     the records are files and survive                                   *)
(*                                                                         *)
(* A callback is one of nine kinds, each with one defect at most:          *)
(*   valid, wrongState, denied (access_denied), foreignClient, noClient,   *)
(*   badGrant (invalid_grant at the exchange), badToken (the ID token      *)
(*   fails verification), wrongSub (another account signed in), noScope    *)
(*   (valid ID token, no chatgpt.tokens.use.direct)                         *)
(*                                                                         *)
(* Abstractions (a proof holds only for this model)                        *)
(*   - cryptography: the verdicts of the signature, issuer, audience,      *)
(*     expiry and nonce checks are the single verdict badToken; PKCE and    *)
(*     the nonce are not values                                             *)
(*   - the browser and the loopback listener (I-S5 is a test): a callback  *)
(*     reaches complete through the CLI, with the attempt id the CLI holds *)
(*   - time is a discrete clock; the TTL is TTL ticks; the exchange takes  *)
(*     no time (T_a is inside the TTL of the design)                        *)
(*   - a returning sign-in is an attempt whose record has an issued client *)
(*     id when it begins; the callback of a returning attempt carries the  *)
(*     saved id, a foreign id, or none; the callback of a new registration *)
(*     carries a fresh issued id, or none                                  *)
(*   - the host id, login_hint, id_token_hint are not modelled             *)
(*   - the account mutex of PlanCredential is not modelled here: install   *)
(*     is one step, the checks before it are separate steps                 *)
(*                                                                         *)
(* Ghost variables: completions, log (one entry per install with the       *)
(* evidence the gateway had), lateIssue, issued.                           *)
(*                                                                         *)
(* Switches                                                                *)
(*   Serial   a begin is refused while another attempt of the label is     *)
(*            pending or consumed (attempts one after the other)           *)
(*   Cas      the registered record and the install compare the issued    *)
(*            client id and the subject with the record in the same step   *)
(*            that writes it. The design as written does not do this: the  *)
(*            checks of steps 3 and 8 and the writes of steps 4 and 10 are *)
(*            separate. Cas = FALSE is the design as written; Cas = TRUE   *)
(*            is the smallest change that makes NoOverwrite and ClientKept *)
(*            hold for overlapping attempts (PlanSignIn.overlapFixed)      *)
(*                                                                         *)
(* Properties                                                              *)
(*   AttemptOnce (I-S1), StateIsolation (I-S2), InstallGate (I-S3),        *)
(*   NoOverwrite (I-S4), RejectLeavesRecords (I-S4, a rejected attempt     *)
(*   changes no record), OtherLabelsUntouched (I-S4), ExpiryRespected      *)
(*   (I-S6), RegisteredBeforeExchange and NoIdAfterRegister (section 5.1), *)
(*   ClientKept, OneIdPerLabel, and the liveness property AttemptEnds      *)
(*                                                                         *)
(* Finding (PlanSignIn.overlap): with the design as written, two           *)
(* overlapping attempts of one label that both begin before any record     *)
(* exists both pass steps 3 and 8, both write, and the second install      *)
(* replaces the subject or the client of the first. NoOverwrite is         *)
(* therefore not in the PlanSignIn and PlanSignIn.otherAccount lists.      *)
(*                                                                         *)
(* Configurations (scripts/tlc.sh <name>, specs/tla/<name>.cfg)            *)
(*   PlanSignIn               two overlapping attempts, one label: I-S1,   *)
(*                            I-S2, I-S3, I-S6 and the rejection rule hold *)
(*   PlanSignIn.otherAccount  two labels, two attempts                     *)
(*   PlanSignIn.expiry        a short TTL, late callbacks, the sweep       *)
(*                            (AttemptEnds, scripts/tlc.sh <name>          *)
(*                            -lncheck final)                               *)
(*   PlanSignIn.registration  attempts one after the other, a crash at any *)
(*                            point: the issued id is persisted before the *)
(*                            exchange and reused                          *)
(*   PlanSignIn.overlap       the finding above: NoOverwrite refuted       *)
(*   PlanSignIn.overlapFixed  Cas = TRUE: NoOverwrite and ClientKept hold  *)
(*   PlanSignIn.noStateCheck  the state is not compared: StateIsolation    *)
(*                            refuted                                      *)
(*   PlanSignIn.verdictIgnored  the ID token and scope verdicts are not    *)
(*                            applied: InstallGate refuted                 *)
(*   PlanSignIn.overwriteOther  the subject and client are not compared    *)
(*                            with the record: NoOverwrite refuted         *)
(*   PlanSignIn.registerLate  the registered record is written at install, *)
(*                            not before the exchange:                     *)
(*                            RegisteredBeforeExchange refuted             *)
(*   PlanSignIn.registrationWindow  a crash between the callback and the   *)
(*                            registered record loses the issued id:       *)
(*                            OneIdPerLabel refuted                        *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS
    Attempts, SecondLabel, MaxClock, TTL, MaxCrash, MaxCb,
    CheckState, HonourVerdict, PinIdentity, RegisterFirst, Serial, Cas

ASSUME Attempts # {} /\ TTL \in Nat /\ MaxClock \in Nat /\ MaxCrash \in Nat /\ MaxCb \in Nat
ASSUME \A c \in {SecondLabel, CheckState, HonourVerdict, PinIdentity, RegisterFirst, Serial, Cas} : c \in BOOLEAN

None == "none"
Labels == IF SecondLabel THEN {"l1", "l2"} ELSE {"l1"}
Kinds == {"valid", "wrongState", "denied", "foreignClient", "noClient", "badGrant", "badToken", "wrongSub", "noScope"}
AttStates == {"free", "pending", "consumed", "installed", "rejected", "expired", "replaced", "lost"}
Active == {"pending", "consumed"}
Phases == {"none", "validate", "register", "exchange", "verify", "install"}
RecStates == {"absent", "registered", "active", "plan_disabled"}

VARIABLES
    att, albl, dl, mode, savedAt, cur, ph, issuedFor, cat, cbCount,
    rState, rClient, rSub,
    issued, lateIssue, completions, log,
    clock, crashes

vars == <<att, albl, dl, mode, savedAt, cur, ph, issuedFor, cat, cbCount, rState, rClient, rSub, issued, lateIssue, completions, log, clock, crashes>>

Init ==
    /\ att = [i \in Attempts |-> "free"]
    /\ albl = [i \in Attempts |-> "l1"]
    /\ dl = [i \in Attempts |-> 0]
    /\ mode = [i \in Attempts |-> "new"]
    /\ savedAt = [i \in Attempts |-> 0]
    /\ cur = [i \in Attempts |-> None]
    /\ ph = [i \in Attempts |-> "none"]
    /\ issuedFor = [i \in Attempts |-> 0]
    /\ cat = [i \in Attempts |-> 0]
    /\ cbCount = [i \in Attempts |-> 0]
    /\ rState = [l \in Labels |-> "absent"]
    /\ rClient = [l \in Labels |-> 0]
    /\ rSub = [l \in Labels |-> None]
    /\ issued = [l \in Labels |-> 0]
    /\ lateIssue = [l \in Labels |-> FALSE]
    /\ completions = [i \in Attempts |-> 0]
    /\ log = {}
    /\ clock = 0
    /\ crashes = 0

Set(f, k, v) == [f EXCEPT ![k] = v]

CbClient(i) ==
    LET k == cur[i] IN
    IF mode[i] = "new"
        THEN IF k \in {"noClient", "denied"} THEN 0 ELSE issuedFor[i]
        ELSE IF k = "foreignClient" THEN 99 ELSE IF k = "noClient" THEN 0 ELSE savedAt[i]

SubOf(i) == IF cur[i] = "wrongSub" THEN "s2" ELSE "s1"

Settle(i, status) ==
    /\ att' = Set(att, i, status)
    /\ ph' = Set(ph, i, "none")

-----------------------------------------------------------------------------

Tick ==
    /\ clock < MaxClock
    /\ clock' = clock + 1
    /\ UNCHANGED <<att, albl, dl, mode, savedAt, cur, ph, issuedFor, cat, cbCount, rState, rClient, rSub, issued, lateIssue, completions, log, crashes>>

Begin(i, l) ==
    /\ att[i] = "free"
    /\ clock + TTL < MaxClock
    /\ Serial => \A j \in Attempts : ~(att[j] \in Active /\ albl[j] = l)
    /\ att' = [j \in Attempts |-> IF j = i THEN "pending" ELSE IF att[j] = "pending" /\ albl[j] = l THEN "replaced" ELSE att[j]]
    /\ albl' = Set(albl, i, l)
    /\ dl' = Set(dl, i, clock + TTL)
    /\ mode' = Set(mode, i, IF rClient[l] = 0 THEN "new" ELSE "returning")
    /\ savedAt' = Set(savedAt, i, rClient[l])
    /\ UNCHANGED <<cur, ph, issuedFor, cat, cbCount, rState, rClient, rSub, issued, lateIssue, completions, log, clock, crashes>>

Expire(i) ==
    /\ att[i] = "pending" /\ clock > dl[i]
    /\ att' = Set(att, i, "expired")
    /\ UNCHANGED <<albl, dl, mode, savedAt, cur, ph, issuedFor, cat, cbCount, rState, rClient, rSub, issued, lateIssue, completions, log, clock, crashes>>

Complete(i, k) ==
    LET l == albl[i]
        issues == mode[i] = "new" /\ ~(k \in {"noClient", "denied"})
    IN
    /\ att[i] = "pending" /\ cbCount[i] < MaxCb
    /\ cbCount' = Set(cbCount, i, cbCount[i] + 1)
    /\ IF clock > dl[i]
        THEN /\ att' = Set(att, i, "expired")
             /\ UNCHANGED <<cur, ph, issuedFor, cat, issued, lateIssue, completions>>
        ELSE /\ att' = Set(att, i, "consumed")
             /\ cur' = Set(cur, i, k)
             /\ ph' = Set(ph, i, "validate")
             /\ cat' = Set(cat, i, clock)
             /\ completions' = Set(completions, i, completions[i] + 1)
             /\ issued' = IF issues THEN Set(issued, l, issued[l] + 1) ELSE issued
             /\ issuedFor' = Set(issuedFor, i, IF issues THEN issued[l] + 1 ELSE 0)
             /\ lateIssue' = IF issues /\ rClient[l] # 0 THEN Set(lateIssue, l, TRUE) ELSE lateIssue
    /\ UNCHANGED <<albl, dl, mode, savedAt, rState, rClient, rSub, log, clock, crashes>>

Replay(i) ==
    /\ att[i] \notin {"free", "pending"} /\ cbCount[i] < MaxCb
    /\ cbCount' = Set(cbCount, i, cbCount[i] + 1)
    /\ UNCHANGED <<att, albl, dl, mode, savedAt, cur, ph, issuedFor, cat, rState, rClient, rSub, issued, lateIssue, completions, log, clock, crashes>>

Validate(i) ==
    LET k == cur[i]
        l == albl[i]
        c == CbClient(i)
        stateBad == CheckState /\ k = "wrongState"
        clientBad == IF rClient[l] = 0 THEN c = 0 ELSE PinIdentity /\ c # rClient[l]
    IN
    /\ att[i] = "consumed" /\ ph[i] = "validate"
    /\ IF k = "denied" \/ stateBad \/ clientBad
        THEN Settle(i, "rejected")
        ELSE /\ ph' = Set(ph, i, IF RegisterFirst /\ rClient[l] = 0 THEN "register" ELSE "exchange")
             /\ UNCHANGED att
    /\ UNCHANGED <<albl, dl, mode, savedAt, cur, issuedFor, cat, cbCount, rState, rClient, rSub, issued, lateIssue, completions, log, clock, crashes>>

Register(i) ==
    LET l == albl[i] IN
    /\ att[i] = "consumed" /\ ph[i] = "register"
    /\ IF Cas /\ rClient[l] # 0 /\ rClient[l] # CbClient(i)
        THEN /\ Settle(i, "rejected") /\ UNCHANGED <<rState, rClient>>
        ELSE /\ rState' = Set(rState, l, "registered")
             /\ rClient' = Set(rClient, l, CbClient(i))
             /\ ph' = Set(ph, i, "exchange")
             /\ UNCHANGED att
    /\ UNCHANGED <<albl, dl, mode, savedAt, cur, issuedFor, cat, cbCount, rSub, issued, lateIssue, completions, log, clock, crashes>>

Exchange(i) ==
    /\ att[i] = "consumed" /\ ph[i] = "exchange"
    /\ IF cur[i] = "badGrant"
        THEN Settle(i, "rejected")
        ELSE /\ ph' = Set(ph, i, "verify") /\ UNCHANGED att
    /\ UNCHANGED <<albl, dl, mode, savedAt, cur, issuedFor, cat, cbCount, rState, rClient, rSub, issued, lateIssue, completions, log, clock, crashes>>

Verify(i) ==
    LET k == cur[i]
        l == albl[i]
        tokenBad == HonourVerdict /\ k = "badToken"
        subBad == PinIdentity /\ rSub[l] # None /\ SubOf(i) # rSub[l]
    IN
    /\ att[i] = "consumed" /\ ph[i] = "verify"
    /\ IF tokenBad \/ subBad
        THEN Settle(i, "rejected")
        ELSE /\ ph' = Set(ph, i, "install") /\ UNCHANGED att
    /\ UNCHANGED <<albl, dl, mode, savedAt, cur, issuedFor, cat, cbCount, rState, rClient, rSub, issued, lateIssue, completions, log, clock, crashes>>

Install(i) ==
    LET k == cur[i]
        l == albl[i]
        c == CbClient(i)
        s == SubOf(i)
        newState == IF HonourVerdict /\ k = "noScope" THEN "plan_disabled" ELSE "active"
    IN
    /\ att[i] = "consumed" /\ ph[i] = "install"
    /\ IF Cas /\ (~(rSub[l] \in {None, s}) \/ ~(rClient[l] \in {0, c}))
        THEN /\ Settle(i, "rejected") /\ UNCHANGED <<rState, rClient, rSub, log>>
        ELSE /\ rState' = Set(rState, l, newState)
             /\ rClient' = Set(rClient, l, c)
             /\ rSub' = Set(rSub, l, s)
             /\ Settle(i, "installed")
             /\ log' = log \cup {[att |-> i, lbl |-> l, state |-> newState, stOk |-> k # "wrongState", idvOk |-> k # "badToken",
                                  scopeOk |-> k # "noScope", subOk |-> rSub[l] \in {None, s}, clientOk |-> rClient[l] \in {0, c},
                                  fresh |-> cat[i] <= dl[i]]}
    /\ UNCHANGED <<albl, dl, mode, savedAt, cur, issuedFor, cat, cbCount, issued, lateIssue, completions, clock, crashes>>

Crash ==
    /\ crashes < MaxCrash
    /\ crashes' = crashes + 1
    /\ att' = [i \in Attempts |-> IF att[i] \in Active THEN "lost" ELSE att[i]]
    /\ ph' = [i \in Attempts |-> "none"]
    /\ UNCHANGED <<albl, dl, mode, savedAt, cur, issuedFor, cat, cbCount, rState, rClient, rSub, issued, lateIssue, completions, log, clock>>

Terminated == (\A i \in Attempts : att[i] \notin Active) /\ UNCHANGED vars

Next ==
    \/ Tick
    \/ \E i \in Attempts : \E l \in Labels : Begin(i, l)
    \/ \E i \in Attempts : Expire(i) \/ Replay(i) \/ Validate(i) \/ Register(i) \/ Exchange(i) \/ Verify(i) \/ Install(i)
    \/ \E i \in Attempts : \E k \in Kinds : Complete(i, k)
    \/ Crash
    \/ Terminated

Fairness ==
    /\ WF_vars(Tick)
    /\ \A i \in Attempts : WF_vars(Expire(i)) /\ WF_vars(Validate(i)) /\ WF_vars(Register(i)) /\ WF_vars(Exchange(i))
                           /\ WF_vars(Verify(i)) /\ WF_vars(Install(i))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
    /\ \A i \in Attempts : att[i] \in AttStates /\ ph[i] \in Phases /\ cbCount[i] \in Nat
    /\ \A l \in Labels : rState[l] \in RecStates /\ rClient[l] \in Nat /\ issued[l] \in Nat

AttemptOnce == \A i \in Attempts : completions[i] <= 1

StateIsolation == \A e \in log : e.stOk

InstallGate == \A e \in log : e.idvOk /\ (e.state = "active" => e.scopeOk)

NoOverwrite == \A e \in log : e.subOk /\ e.clientOk

ExpiryRespected == \A e \in log : e.fresh

RegisteredBeforeExchange == \A i \in Attempts : (att[i] = "consumed" /\ ph[i] \in {"exchange", "verify", "install"}) => rClient[albl[i]] # 0

NoIdAfterRegister == \A l \in Labels : ~lateIssue[l]

OneIdPerLabel == \A l \in Labels : issued[l] <= 1

RejectLeavesRecords ==
    [][\A i \in Attempts : (att'[i] = "rejected" /\ att[i] # "rejected") => (rState' = rState /\ rClient' = rClient /\ rSub' = rSub)]_vars

Rec(l) == <<rState[l], rClient[l], rSub[l]>>

OtherLabelsUntouched == [][Cardinality({l \in Labels : Rec(l)' # Rec(l)}) <= 1]_vars

ClientKept == [][\A l \in Labels : rClient[l] # 0 => rClient'[l] = rClient[l]]_vars

AttemptEnds == \A i \in Attempts : (att[i] \in Active) ~> (att[i] \notin Active)

=========================================================================
