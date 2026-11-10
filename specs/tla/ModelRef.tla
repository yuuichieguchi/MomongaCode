------------------------------ MODULE ModelRef ------------------------------
(***************************************************************************)
(* Design model of a model reference: the identity of a configured model, *)
(* the resolution of the text a user or a file writes, and what a session *)
(* or a run keeps of it (design-model-names-2026-11-10.md, 2.1-2.2, 3.1,  *)
(* 3.2, 3.4, 3.9, 3.10, 7.3). The decided variant is the rule of the      *)
(* design; every other Variant is a wrong rule that must break one        *)
(* property (the evidence configurations).                                 *)
(*                                                                         *)
(* Identity and text                                                       *)
(*   - a configured model is (provider name P, own name I); P is one      *)
(*     segment (it never contains "/"), I is a sequence of segments (an   *)
(*     own name may contain "/"); a text is a sequence of segments, so    *)
(*     that "Canon = P/I" is <<P>> \o I and the parse at the first "/" is *)
(*     the first segment                                                   *)
(*   - Resolve(text): the Canon of a configured model first; else the     *)
(*     one configured model with that own name; several -> ambiguous;     *)
(*     none -> missing                                                     *)
(*   - Display(c): the own name when exactly one configured model has it  *)
(*     and it equals no configured Canon, else the Canon                  *)
(*   - what a session keeps is the Canon of the resolved model (3.9)      *)
(*   - a run pins the Canon, the chain and the role it resolved at its    *)
(*     claim and keeps them (3.10, R06-76); the chain of a model is the   *)
(*     model followed by the resolved fallback entries, without repeats   *)
(*                                                                         *)
(* Actors, derived from the code at commit 924b2d8c (every reader and     *)
(* writer of the configured models or of a stored model reference)         *)
(*   writers of models.connections / start / fallback / roles:             *)
(*     hand editing (any content; AddConn, RemoveConn, AddModel,           *)
(*       RemoveModel, SetStart, SetFallback, SetRole)                      *)
(*     packages/config/src/add-model-connection.ts:132 addModelConnection *)
(*       through editUserSettings (:114): only adds a connection or a      *)
(*       model entry, never removes (AddConn, AddModel); callers          *)
(*       packages/cli/src/tui/backend.ts:141, tui/plan-flows.ts:277,298,  *)
(*       packages/gateway/src/plan/api.ts:180 (the plan route)             *)
(*     scripts/plan-real-check.ts:376 writeCarriageAliases through        *)
(*       editUserSettings: adds entries (AddConn, AddModel)               *)
(*   readers, each resolving with the settings it read:                    *)
(*     gateway derivation per epoch packages/gateway/src/process.ts:1217, *)
(*       :1254                                                             *)
(*     runtime per use through the cache                                   *)
(*       packages/runtime/src/process/settings-port.ts:63 (takeUserSnapshot) *)
(*       and :108-124 (modelRoles, modelTargets, autoModeClassifier)      *)
(*     CLI per command packages/cli/src/run/open-session.ts:20-28         *)
(*     the auto-fit key reader settings-port.ts:44 (the classifier)       *)
(*     the reflection role packages/runtime/src/memory/reflection.ts:177  *)
(*       (roles.reflection else the run's pin)                             *)
(*   writers of a stored model reference:                                   *)
(*     session create packages/runtime/src/service/app.ts:249 and         *)
(*       session patch :277-281 (setModelAlias,                            *)
(*       packages/store/src/runtime-store.ts:1090): the check against the  *)
(*       listing and the store are two steps (CreateSession, ResolveStore) *)
(*     child run create packages/runtime/src/process/child-runs.ts:55-66  *)
(*       (createChildRun, packages/store/src/runtime-store.ts:1159): the   *)
(*       agent's model text is checked at spawn, else the parent's pin is *)
(*       copied; a child run holds a stored reference with the lifecycle  *)
(*       of a session, so Sessions stands for both                         *)
(*     run start pins packages/runtime/src/worker/claim-runner.ts:365,    *)
(*       :384 (run.started pins, read back by packages/runtime/src/worker/ *)
(*       pins.ts:87-121 on resume and by the claim check :400) (StartRun) *)
(*     run facts packages/store/src/run-facts.ts:66,:119-167: a copy of   *)
(*       the pinned value; it resolves nothing, so it adds no state       *)
(*   actors that cannot affect an invariant: the supervisor reads only the *)
(*     credential names of connections (packages/supervisor/src/          *)
(*     child-env.ts), never a reference; the ACP and eval clients         *)
(*     (packages/cli/src/acp/agent.ts:377,421, packages/eval/src/         *)
(*     runner.ts:90) are callers of the session create and patch above    *)
(*                                                                         *)
(* Abstracted away                                                         *)
(*   - the characters of ids: an own name is a short sequence of          *)
(*     segments (Ids); the split of a text at its first "/" is the first *)
(*     segment (the property test I-N1 covers the parse of any string)    *)
(*   - the content of capabilities, billing and the ids of the provider   *)
(*     derivation (2.1.1); the provider names are two atoms                *)
(*   - durations and the files: an edit is atomic and a file that the     *)
(*     loader refuses (a reference that resolves to nothing or to two     *)
(*     models) is not applied, because the cache keeps the last good      *)
(*     copy (SettingsHealth.tla); Valid is the loader's check             *)
(*   - which process reads: gateway, runtime and CLI each read "the       *)
(*     settings at that time"; a reader holding an older good copy        *)
(*     resolves a text to a Canon of that copy, and a Canon does not      *)
(*     depend on the copy, so reading an older copy adds no behaviour to  *)
(*     NoRebind, NoGuess, DisplayRoundTrip; for RunKeepsPin the pin is    *)
(*     taken once at the claim whichever copy that was; epochs are        *)
(*     SettingsSwap.tla                                                    *)
(*   - the order of connections and of model entries: "first model entry" *)
(*     (the start model when start is absent) and "file order" (the       *)
(*     ambiguity rule of the wrong variant lastWins) are one fixed        *)
(*     deterministic choice among the configured models; reordering        *)
(*     changes no identity (SettingsSwap.tla, I-N3 property test)         *)
(*   - the role of a request in a run (compaction, reflection, analysis,  *)
(*     classifier): one setting, role, with the resolution of start; all  *)
(*     of them are pinned as Canon at the claim by the same step          *)
(*   - the model's own name equal to a Canon of another model is covered  *)
(*     by the segment form of Ids; with the configurations of this        *)
(*     directory the ids are one segment                                    *)
(*                                                                         *)
(* Variants (every Variant other than "decided" is a wrong rule)          *)
(*   storeDisplay  the session keeps the display name, not the Canon      *)
(*   lastWins      a bare name held by several models resolves to one of  *)
(*                 them (file order) instead of being refused              *)
(*   unpinned      a run resolves its model, chain and role again at      *)
(*                 every step instead of keeping the claim's                *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Provs, Ids, Sessions, MaxEdits, None, Variant

ASSUME Variant \in {"decided", "storeDisplay", "lastWins", "unpinned"}
ASSUME MaxEdits \in Nat
ASSUME \A i \in Ids : Len(i) >= 1

IdsPlain == {<<"x">>, <<"y">>}
IdsSlash == {<<"x">>, <<"p1", "x">>}

Canon(c) == <<c.prov>> \o c.id
Texts == Ids \cup {<<p>> \o i : p \in Provs, i \in Ids}
Confs0 == {[prov |-> p, id |-> i] : p \in Provs, i \in Ids}

VARIABLES conns, models, start, role, fallback, edits, pend, stored, origin, claim, eff

settingsVars == <<conns, models, start, role, fallback, edits>>
sessionVars == <<pend, stored, origin, claim, eff>>
vars == <<conns, models, start, role, fallback, edits, pend, stored, origin, claim, eff>>

ConfsOf(cn, md) == UNION {{[prov |-> p, id |-> i] : i \in md[p]} : p \in cn}
Confs == ConfsOf(conns, models)

Holders(cs, t) == {c \in cs : c.id = t}
ByCanon(cs, t) == {c \in cs : Canon(c) = t}

ResolveIn(cs, t) ==
    IF ByCanon(cs, t) # {}
    THEN [k |-> "found", m |-> CHOOSE c \in ByCanon(cs, t) : TRUE]
    ELSE IF Cardinality(Holders(cs, t)) = 1
    THEN [k |-> "found", m |-> CHOOSE c \in Holders(cs, t) : TRUE]
    ELSE IF Cardinality(Holders(cs, t)) = 0
    THEN [k |-> "missing"]
    ELSE IF Variant = "lastWins"
    THEN [k |-> "found", m |-> CHOOSE c \in Holders(cs, t) : TRUE]
    ELSE [k |-> "ambiguous"]

Resolve(t) == ResolveIn(Confs, t)

Display(c) ==
    IF Cardinality(Holders(Confs, c.id)) = 1 /\ \A c2 \in Confs : Canon(c2) # c.id
    THEN c.id
    ELSE Canon(c)

StartModel ==
    IF start # None THEN Resolve(start)
    ELSE IF Confs = {} THEN [k |-> "missing"]
    ELSE [k |-> "found", m |-> CHOOSE c \in Confs : TRUE]

RECURSIVE Fold(_, _)
Fold(acc, rest) ==
    IF rest = <<>> THEN acc
    ELSE IF \E k \in 1..Len(acc) : acc[k] = Head(rest) THEN Fold(acc, Tail(rest))
    ELSE Fold(Append(acc, Head(rest)), Tail(rest))

FallbackModels == [k \in 1..Len(fallback) |-> Resolve(fallback[k]).m]
Chain(m) == Fold(<<m>>, FallbackModels)
RoleModel == IF role = None THEN None ELSE Resolve(role).m

Claimed(m) == [pin |-> m, chain |-> Chain(m), role |-> RoleModel]

FallbackSeqs == {<<>>} \cup {<<a>> : a \in Texts} \cup {<<a, b>> : a \in Texts, b \in Texts}

Valid(cn, md, st, rl, fb) ==
    LET cs == ConfsOf(cn, md) IN
    /\ st = None \/ ResolveIn(cs, st).k = "found"
    /\ rl = None \/ ResolveIn(cs, rl).k = "found"
    /\ \A k \in 1..Len(fb) : ResolveIn(cs, fb[k]).k = "found"

TypeOK ==
    /\ conns \subseteq Provs
    /\ models \in [Provs -> SUBSET Ids]
    /\ \A p \in Provs : p \notin conns => models[p] = {}
    /\ start \in Texts \cup {None}
    /\ role \in Texts \cup {None}
    /\ fallback \in FallbackSeqs
    /\ edits \in 0..MaxEdits
    /\ stored \in [Sessions -> Texts \cup {None}]
    /\ origin \in [Sessions -> Confs0 \cup {None}]

Init ==
    /\ conns = {}
    /\ models = [p \in Provs |-> {}]
    /\ start = None /\ role = None /\ fallback = <<>>
    /\ edits = 0
    /\ pend = [s \in Sessions |-> None]
    /\ stored = [s \in Sessions |-> None]
    /\ origin = [s \in Sessions |-> None]
    /\ claim = [s \in Sessions |-> None]
    /\ eff = [s \in Sessions |-> None]

Edited(cn, md, st, rl, fb) ==
    /\ edits < MaxEdits
    /\ Valid(cn, md, st, rl, fb)
    /\ conns' = cn /\ models' = md /\ start' = st /\ role' = rl /\ fallback' = fb
    /\ edits' = edits + 1
    /\ UNCHANGED sessionVars

AddConn(p, i) ==
    /\ p \notin conns
    /\ Edited(conns \cup {p}, [models EXCEPT ![p] = {i}], start, role, fallback)

RemoveConn(p) ==
    /\ p \in conns
    /\ Edited(conns \ {p}, [models EXCEPT ![p] = {}], start, role, fallback)

AddModel(p, i) ==
    /\ p \in conns /\ i \notin models[p]
    /\ Edited(conns, [models EXCEPT ![p] = @ \cup {i}], start, role, fallback)

RemoveModel(p, i) ==
    /\ p \in conns /\ i \in models[p]
    /\ Edited(conns, [models EXCEPT ![p] = @ \ {i}], start, role, fallback)

SetStart(t) ==
    /\ t # start
    /\ Edited(conns, models, t, role, fallback)

SetRole(t) ==
    /\ t # role
    /\ Edited(conns, models, start, t, fallback)

SetFallback(fb) ==
    /\ fb # fallback
    /\ Edited(conns, models, start, role, fb)

CreateSession(s, ref) ==
    LET r == IF ref = None THEN StartModel ELSE Resolve(ref) IN
    /\ pend[s] = None
    /\ r.k = "found"
    /\ pend' = [pend EXCEPT ![s] = [m |-> r.m, disp |-> Display(r.m)]]
    /\ UNCHANGED <<settingsVars, stored, origin, claim, eff>>

ResolveStore(s) ==
    /\ pend[s] # None
    /\ stored' = [stored EXCEPT ![s] = IF Variant = "storeDisplay" THEN pend[s].disp ELSE Canon(pend[s].m)]
    /\ origin' = [origin EXCEPT ![s] = pend[s].m]
    /\ pend' = [pend EXCEPT ![s] = None]
    /\ UNCHANGED <<settingsVars, claim, eff>>

StartRun(s) ==
    /\ claim[s] = None
    /\ stored[s] # None
    /\ Resolve(stored[s]).k = "found"
    /\ claim' = [claim EXCEPT ![s] = Claimed(Resolve(stored[s]).m)]
    /\ eff' = [eff EXCEPT ![s] = Claimed(Resolve(stored[s]).m)]
    /\ UNCHANGED <<settingsVars, pend, stored, origin>>

RunStep(s) ==
    /\ Variant = "unpinned"
    /\ claim[s] # None
    /\ eff' = [eff EXCEPT ![s] =
                 IF Resolve(stored[s]).k = "found"
                 THEN Claimed(Resolve(stored[s]).m)
                 ELSE [pin |-> None, chain |-> <<>>, role |-> None]]
    /\ UNCHANGED <<settingsVars, pend, stored, origin, claim>>

EndRun(s) ==
    /\ claim[s] # None
    /\ claim' = [claim EXCEPT ![s] = None]
    /\ eff' = [eff EXCEPT ![s] = None]
    /\ UNCHANGED <<settingsVars, pend, stored, origin>>

Next ==
    \/ \E p \in Provs, i \in Ids : AddConn(p, i) \/ AddModel(p, i) \/ RemoveModel(p, i)
    \/ \E p \in Provs : RemoveConn(p)
    \/ \E t \in Texts \cup {None} : SetStart(t) \/ SetRole(t)
    \/ \E fb \in FallbackSeqs : SetFallback(fb)
    \/ \E s \in Sessions : \E ref \in Texts \cup {None} : CreateSession(s, ref)
    \/ \E s \in Sessions : ResolveStore(s) \/ StartRun(s) \/ RunStep(s) \/ EndRun(s)
    \/ UNCHANGED vars

Spec == Init /\ [][Next]_vars

NoRebind ==
    \A s \in Sessions : stored[s] # None =>
        LET r == Resolve(stored[s]) IN r.k # "found" \/ r.m = origin[s]

NoGuess ==
    \A t \in Texts :
        (ByCanon(Confs, t) = {} /\ Resolve(t).k = "found") => Cardinality(Holders(Confs, t)) = 1

RunKeepsPin == \A s \in Sessions : claim[s] # None => eff[s] = claim[s]

DisplayRoundTrip ==
    \A c \in Confs : Resolve(Display(c)).k = "found" /\ Resolve(Display(c)).m = c

=============================================================================
