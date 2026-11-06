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
(* A callback is one of ten kinds, each with one defect at most:           *)
(*   valid, wrongState, denied (access_denied with the right state),       *)
(*   deniedForged (access_denied with a wrong state), foreignClient (a     *)
(*   client id other than the saved one), noClient (no client_id: for a    *)
(*   returning sign-in this means the saved id, sign-in.txt:47; for a new  *)
(*   registration it is a protocol failure), badGrant (invalid_grant at    *)
(*   the exchange), badToken (the ID token fails verification), wrongSub   *)
(*   (another account signed in), noScope (valid ID token, no              *)
(*   chatgpt.tokens.use.direct)                                            *)
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
(*     saved id or a foreign id, or omits it (meaning the saved id); the   *)
(*     callback of a new registration carries a fresh issued id, or none.  *)
(*     An issued id encodes its label (10 * label index + n)               *)
(*   - the host id, login_hint, id_token_hint are not modelled             *)
(*   - the account mutex of PlanCredential is not modelled here: install   *)
(*     is one step, the checks before it are separate steps                 *)
(*                                                                         *)
(* Ghost variables: completions, log (one entry per install with the       *)
(* evidence the gateway had, one per rejection with its reason),           *)
(* lateIssue, issued.                                                      *)
(*                                                                         *)
(* Switches                                                                *)
(*   Serial   a begin is refused while another attempt of the label is     *)
(*            pending or consumed (attempts one after the other); not part *)
(*            of the design, used by the evidence configurations that need *)
(*            attempts one after the other                                 *)
(*   Cas      the registered record (step 4) and the install (step 10)     *)
(*            compare the issued client id and the subject with the record *)
(*            in the same step that writes it, under the account mutex;    *)
(*            the first validated subject binds the record (ruling 1 of    *)
(*            review 1). Cas = FALSE is the design before that ruling      *)
(*   CheckTtl, StateFirst, CheckState, HonourVerdict, PinIdentity,         *)
(*   RegisterFirst  each switches one rule off for its evidence            *)
(*            configuration; StateFirst orders the state check before the  *)
(*            handling of access_denied                                    *)
(*                                                                         *)
(* Properties                                                              *)
(*   AttemptOnce (I-S1), StateIsolation (I-S2), InstallGate (I-S3),        *)
(*   NoOverwrite (I-S4), RejectLeavesRecords (I-S4, a rejected attempt     *)
(*   changes no record), OtherLabelsUntouched (I-S4, a step changes the    *)
(*   record of at most one label) with RecordsOwnRegistration (the client  *)
(*   id in the record of a label was issued for that label), ExpiryRe-     *)
(*   spected (I-S6), DeniedAfterState (a forged access_denied is a state   *)
(*   failure), RegisteredBeforeExchange (section 5.1), ClientKept,         *)
(*   OneIdPerLabel, and the liveness property AttemptEnds                  *)
(*                                                                         *)
(* Stated limit (PlanSignIn.registrationWindow, ruling 3 of review 1):     *)
(* a crash between the callback and the registered write loses the issued  *)
(* id, and the next sign-in registers again; the first id is an orphan     *)
(* app at OpenAI. Two overlapping first sign-ins orphan one id the same    *)
(* way. Neither can be closed by ordering.                                 *)
(*                                                                         *)
(* Configurations (scripts/tlc.sh <name>, specs/tla/<name>.cfg)            *)
(*   PlanSignIn               two overlapping attempts, one label, Cas     *)
(*   PlanSignIn.otherAccount  two labels, two attempts, Cas                *)
(*   PlanSignIn.expiry        a short TTL, late callbacks, the sweep       *)
(*                            (AttemptEnds, scripts/tlc.sh <name>          *)
(*                            -lncheck final)                               *)
(*   PlanSignIn.registration  a crash at any point, overlapping attempts,  *)
(*                            Cas: the issued id is persisted before the   *)
(*                            exchange and reused                          *)
(*   PlanSignIn.overlap       Cas = FALSE: NoOverwrite refuted             *)
(*   PlanSignIn.expiryIgnored  a callback after the TTL is accepted:       *)
(*                            ExpiryRespected refuted                      *)
(*   PlanSignIn.deniedFirst   access_denied is handled before the state    *)
(*                            check: DeniedAfterState refuted              *)
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
    CheckState, HonourVerdict, PinIdentity, RegisterFirst, Serial, Cas, CheckTtl, StateFirst

ASSUME Attempts # {} /\ TTL \in Nat /\ MaxClock \in Nat /\ MaxCrash \in Nat /\ MaxCb \in Nat
ASSUME \A c \in {SecondLabel, CheckState, HonourVerdict, PinIdentity, RegisterFirst, Serial, Cas, CheckTtl, StateFirst} : c \in BOOLEAN

None == "none"
Labels == IF SecondLabel THEN {"l1", "l2"} ELSE {"l1"}
LblIdx(l) == IF l = "l1" THEN 1 ELSE 2
Kinds == {"valid", "wrongState", "denied", "deniedForged", "foreignClient", "noClient", "badGrant", "badToken", "wrongSub", "noScope"}
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
        THEN IF k \in {"noClient", "denied", "deniedForged"} THEN 0 ELSE issuedFor[i]
        ELSE IF k = "foreignClient" THEN 99 ELSE savedAt[i]

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
        issues == mode[i] = "new" /\ ~(k \in {"noClient", "denied", "deniedForged"})
    IN
    /\ att[i] = "pending" /\ cbCount[i] < MaxCb
    /\ cbCount' = Set(cbCount, i, cbCount[i] + 1)
    /\ IF CheckTtl /\ clock > dl[i]
        THEN /\ att' = Set(att, i, "expired")
             /\ UNCHANGED <<cur, ph, issuedFor, cat, issued, lateIssue, completions>>
        ELSE /\ att' = Set(att, i, "consumed")
             /\ cur' = Set(cur, i, k)
             /\ ph' = Set(ph, i, "validate")
             /\ cat' = Set(cat, i, clock)
             /\ completions' = Set(completions, i, completions[i] + 1)
             /\ issued' = IF issues THEN Set(issued, l, issued[l] + 1) ELSE issued
             /\ issuedFor' = Set(issuedFor, i, IF issues THEN 10 * LblIdx(l) + issued[l] + 1 ELSE 0)
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
        forged == k \in {"wrongState", "deniedForged"}
        stateBad == CheckState /\ forged
        deniedK == k \in {"denied", "deniedForged"}
        clientBad == IF rClient[l] = 0 THEN c = 0 ELSE PinIdentity /\ c # rClient[l]
        why == IF StateFirst
                THEN (IF stateBad THEN "state" ELSE IF deniedK THEN "denied" ELSE IF clientBad THEN "client" ELSE None)
                ELSE (IF deniedK THEN "denied" ELSE IF stateBad THEN "state" ELSE IF clientBad THEN "client" ELSE None)
    IN
    /\ att[i] = "consumed" /\ ph[i] = "validate"
    /\ IF why # None
        THEN /\ Settle(i, "rejected")
             /\ log' = log \cup {[kind |-> "reject", att |-> i, why |-> why, forged |-> forged]}
        ELSE /\ ph' = Set(ph, i, IF RegisterFirst /\ rClient[l] = 0 THEN "register" ELSE "exchange")
             /\ UNCHANGED <<att, log>>
    /\ UNCHANGED <<albl, dl, mode, savedAt, cur, issuedFor, cat, cbCount, rState, rClient, rSub, issued, lateIssue, completions, clock, crashes>>

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
             /\ log' = log \cup {[kind |-> "install", att |-> i, lbl |-> l, state |-> newState, stOk |-> ~(k \in {"wrongState", "deniedForged"}), idvOk |-> k # "badToken",
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

Installs == {e \in log : e.kind = "install"}

DeniedAfterState == \A e \in log : (e.kind = "reject" /\ e.why = "denied") => ~e.forged

RecordsOwnRegistration == \A l \in Labels : rClient[l] = 0 \/ rClient[l] \div 10 = LblIdx(l)

StateIsolation == \A e \in Installs : e.stOk

InstallGate == \A e \in Installs : e.idvOk /\ (e.state = "active" => e.scopeOk)

NoOverwrite == \A e \in Installs : e.subOk /\ e.clientOk

ExpiryRespected == \A e \in Installs : e.fresh

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
