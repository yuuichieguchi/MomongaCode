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
(*   - Resolve(text), for a text a person types or writes by hand: the   *)
(*     Canon of a configured model first (so a typed "p1/x" that is both  *)
(*     a Canon and the own name of another model is the Canon); else the  *)
(*     one configured model with that own name; several -> ambiguous;     *)
(*     none -> missing                                                     *)
(*   - StoredResolve(text), for a value the product stored (a session or  *)
(*     child run model, a run pin): the Canon of a configured model or    *)
(*     nothing; the bare-name rule never applies to a stored value        *)
(*   - Display(c): the own name when exactly one configured model has it  *)
(*     and it equals no configured Canon, else the Canon                  *)
(*   - what a session keeps is the Canon of the resolved model (3.9)      *)
(*   - a run pins the Canon, the chain and the role it resolved at its    *)
(*     claim and keeps them (3.10, R06-76); the chain of a model is the   *)
(*     model followed by the resolved fallback entries, without repeats   *)
(*                                                                         *)
(* The short form (R10-model-names-approved, design 2.2.1-2.2.2)          *)
(*   - DefTag[p]: the kind of server p has a default tag; Short(p, i) is  *)
(*     "x" exactly when DefTag[p] and i is "x:latest" (a table; "x" and   *)
(*     "x:latest" stand for every untagged and tagged own name)           *)
(*   - Norm(p, i): an own name "x" under a DefTag server is stored as     *)
(*     "x:latest"; a duplicate after normalising is refused               *)
(*   - Holders(t): the models whose own name or whose short form is t,    *)
(*     looked up together                                                  *)
(*   - Resolve (typed): 1 the Canon of a configured model; 2 P/short of   *)
(*     a model of server P; 3 the holders of a bare text: one, several    *)
(*     (ambiguous), none                                                    *)
(*   - Display(c): the first of short-or-own-name, P/short-or-own-name,   *)
(*     the Canon that Resolve maps to c                                    *)
(*   - the kind travels with the server, so SetProvider renames only to a *)
(*     name of the same DefTag (ModelRef.rename.cfg gives both servers a  *)
(*     default tag; ModelRef.slash.cfg gives none)                         *)
(*   - Sessions has one element in every configuration: every property is *)
(*     per session and sessions share only the settings                    *)
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
(*   the product writer editModelsSettings (design 4.9, R10-tui-first),   *)
(*     one atomic write under the settings lock that the loader checks;   *)
(*     its operations are the actions AddConn, AddModel,                   *)
(*     RemoveModelCascade and RemoveConnCascade (the entry and every       *)
(*     reference to it - start, fallback entries, roles, classifier,       *)
(*     billing scope - in the same write), SetFallback (add, remove and    *)
(*     reorder are one action: the whole list is rewritten), SetStart,     *)
(*     SetRole (roles, classifier and billing scope are three slots of     *)
(*     one kind), SetModelField (a number of one model entry) and          *)
(*     SetProvider (renames a server: the writer rewrites every settings   *)
(*     reference to the server\'s models to the new name in the same       *)
(*     write; stored references are not rewritten, so each then resolves   *)
(*     to nothing, never to another model)                                  *)
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
(*   - the jobs that hold a model (compaction, reflection, analysis,      *)
(*     classifier, billing scope) are three slots with the resolution of  *)
(*     start; the slot "role" stands for the roles pinned at the claim    *)
(*   - SetModelField stands for every number of a model entry (window,    *)
(*     output limit, tool calling, concurrency): one field of two values; *)
(*     it changes no identity and no reference                             *)
(*   - SetProvider with a name that is already used is refused by the     *)
(*     writer (a taken name), so the target name is a free atom; removing *)
(*     the name (the derived name takes over) is the same rename           *)
(*   - IdsPlain (one-segment ids) and IdsSlash (an own name may contain   *)
(*     "/", so it can equal the Canon of another model) are the two       *)
(*     instances; the other characters of ids are I-N1's                   *)
(*                                                                         *)
(* WriterKeepsLoadable (I-N14): the settings in force are loadable: every *)
(*   reference (start, fallback entries, roles, classifier, billing       *)
(*   scope) resolves to one configured model. Hand edits cannot break it   *)
(*   (a file that does not load is not applied: SettingsHealth.tla), so    *)
(*   only a product write can.                                              *)
(*                                                                         *)
(* Variants (every Variant other than "decided" is a wrong rule)          *)
(*   storeDisplay  the session keeps the display name, not the Canon      *)
(*   lastWins      a bare name held by several models resolves to one of  *)
(*                 them (file order) instead of being refused              *)
(*   shortFirst    the short form is looked up before an exact own name   *)
(*   displayShortOnly the display is the short form or own name only      *)
(*   shortEverywhere Short is applied to a server without a default tag   *)
(*   noNorm        an own name "x" under a DefTag server is kept as written *)
(*   storedBareName a stored value is resolved by the typed rule (Canon  *)
(*                 first, then a unique own name); it breaks NoRebind     *)
(*                 once an own name looks like another model's Canon      *)
(*                 (Ids <- IdsSlash)                                       *)
(*   noCascade     a product removal deletes the entry only and the write *)
(*                 is not checked by the loader, so references are left   *)
(*   unpinned      a run resolves its model, chain and role again at      *)
(*                 every step instead of keeping the claim's                *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Provs, Ids, Sessions, MaxEdits, None, DefTag, Variant

ASSUME Variant \in {"decided", "storeDisplay", "lastWins", "unpinned", "noCascade", "storedBareName", "shortFirst", "displayShortOnly", "shortEverywhere", "noNorm"}
ASSUME DefTag \in [Provs -> BOOLEAN]
ASSUME MaxEdits \in Nat
ASSUME \A i \in Ids : Len(i) >= 1

IdsPlain == {<<"x">>, <<"y">>}
IdsSlash == {<<"x">>, <<"p1", "x">>}
IdsTag == {<<"x">>, <<"x:latest">>, <<"y">>}
IdsSlashTag == {<<"x">>, <<"x:latest">>, <<"p1", "x">>}
DefTagMixed == [p \in Provs |-> p = "p1"]
DefTagNone == [p \in Provs |-> FALSE]
DefTagAll == [p \in Provs |-> TRUE]

Short(p, i) ==
    IF (DefTag[p] \/ Variant = "shortEverywhere") /\ i = <<"x:latest">> THEN <<"x">> ELSE None

Norm(p, i) == IF DefTag[p] /\ Variant # "noNorm" /\ i = <<"x">> THEN <<"x:latest">> ELSE i
ONames == {Norm(p, i) : p \in Provs, i \in Ids}
AllNames == ONames \cup ({Short(p, n) : p \in Provs, n \in ONames} \ {None})

Canon(c) == <<c.prov>> \o c.id
Texts == AllNames \cup {<<p>> \o n : p \in Provs, n \in AllNames}
Confs0 == {[prov |-> p, id |-> i] : p \in Provs, i \in ONames}

Slots == {"role", "classifier", "scope"}

VARIABLES conns, models, win, start, slots, fallback, edits, pend, stored, origin, claim, eff

settingsVars == <<conns, models, win, start, slots, fallback, edits>>
sessionVars == <<pend, stored, origin, claim, eff>>
vars == <<conns, models, win, start, slots, fallback, edits, pend, stored, origin, claim, eff>>

ConfsOf(cn, md) == UNION {{[prov |-> p, id |-> i] : i \in md[p]} : p \in cn}
Confs == ConfsOf(conns, models)

Holders(cs, t) == {c \in cs : c.id = t \/ Short(c.prov, c.id) = t}
ByCanon(cs, t) == {c \in cs : Canon(c) = t}
ByShortRef(cs, t) == {c \in cs : Len(t) >= 2 /\ t[1] = c.prov /\ Short(c.prov, c.id) = Tail(t)}
ShortHolders(cs, t) == {c \in cs : Short(c.prov, c.id) = t}

ResolveIn(cs, t) ==
    IF ByCanon(cs, t) # {}
    THEN [k |-> "found", m |-> CHOOSE c \in ByCanon(cs, t) : TRUE]
    ELSE IF ByShortRef(cs, t) # {}
    THEN [k |-> "found", m |-> CHOOSE c \in ByShortRef(cs, t) : TRUE]
    ELSE IF Variant = "shortFirst" /\ ShortHolders(cs, t) # {}
    THEN [k |-> "found", m |-> CHOOSE c \in ShortHolders(cs, t) : TRUE]
    ELSE IF Cardinality(Holders(cs, t)) = 1
    THEN [k |-> "found", m |-> CHOOSE c \in Holders(cs, t) : TRUE]
    ELSE IF Cardinality(Holders(cs, t)) = 0
    THEN [k |-> "missing"]
    ELSE IF Variant = "lastWins"
    THEN [k |-> "found", m |-> CHOOSE c \in Holders(cs, t) : TRUE]
    ELSE [k |-> "ambiguous"]

Resolve(t) == ResolveIn(Confs, t)

StoredResolve(t) ==
    IF Variant \in {"storeDisplay", "storedBareName"}
    THEN Resolve(t)
    ELSE IF ByCanon(Confs, t) # {}
    THEN [k |-> "found", m |-> CHOOSE c \in ByCanon(Confs, t) : TRUE]
    ELSE [k |-> "missing"]

ShownName(c) == IF Short(c.prov, c.id) # None THEN Short(c.prov, c.id) ELSE c.id

Display(c) ==
    IF Variant = "displayShortOnly" THEN ShownName(c)
    ELSE IF Resolve(ShownName(c)).k = "found" /\ Resolve(ShownName(c)).m = c THEN ShownName(c)
    ELSE IF Resolve(<<c.prov>> \o ShownName(c)).k = "found" /\ Resolve(<<c.prov>> \o ShownName(c)).m = c THEN <<c.prov>> \o ShownName(c)
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
RoleModel == IF slots["role"] = None THEN None ELSE Resolve(slots["role"]).m

Claimed(m) == [pin |-> m, chain |-> Chain(m), role |-> RoleModel]

FallbackSeqs == {<<>>} \cup {<<a>> : a \in Texts} \cup {<<a, b>> : a \in Texts, b \in Texts}

Valid(cn, md, st, sl, fb) ==
    LET cs == ConfsOf(cn, md) IN
    /\ IF st = None THEN TRUE ELSE ResolveIn(cs, st).k = "found"
    /\ \A k \in Slots : IF sl[k] = None THEN TRUE ELSE ResolveIn(cs, sl[k]).k = "found"
    /\ \A k \in 1..Len(fb) : ResolveIn(cs, fb[k]).k = "found"

TypeOK ==
    /\ conns \subseteq Provs
    /\ models \in [Provs -> SUBSET ONames]
    /\ \A p \in Provs : p \notin conns => models[p] = {}
    /\ start \in Texts \cup {None}
    /\ slots \in [Slots -> Texts \cup {None}]
    /\ win \in [Provs -> [ONames -> {1, 2}]]
    /\ fallback \in FallbackSeqs
    /\ edits \in 0..MaxEdits
    /\ stored \in [Sessions -> Texts \cup {None}]
    /\ origin \in [Sessions -> Confs0 \cup {None}]

Init ==
    /\ conns = {}
    /\ models = [p \in Provs |-> {}]
    /\ start = None /\ slots = [k \in Slots |-> None] /\ fallback = <<>>
    /\ win = [p \in Provs |-> [i \in ONames |-> 1]]
    /\ edits = 0
    /\ pend = [s \in Sessions |-> None]
    /\ stored = [s \in Sessions |-> None]
    /\ origin = [s \in Sessions |-> None]
    /\ claim = [s \in Sessions |-> None]
    /\ eff = [s \in Sessions |-> None]

Applied(cn, md, wn, st, sl, fb) ==
    /\ conns' = cn /\ models' = md /\ win' = wn /\ start' = st /\ slots' = sl /\ fallback' = fb
    /\ edits' = edits + 1
    /\ UNCHANGED sessionVars

Edited(cn, md, wn, st, sl, fb) ==
    /\ edits < MaxEdits
    /\ Valid(cn, md, st, sl, fb)
    /\ Applied(cn, md, wn, st, sl, fb)

Dropped(M) == [p \in Provs |-> [i \in ONames |-> IF [prov |-> p, id |-> i] \in M THEN 1 ELSE win[p][i]]]

RefersTo(M, t) == t # None /\ Resolve(t).k = "found" /\ Resolve(t).m \in M

CascadedStart(M) == IF Variant # "noCascade" /\ RefersTo(M, start) THEN None ELSE start
CascadedSlots(M) == [k \in Slots |-> IF Variant # "noCascade" /\ RefersTo(M, slots[k]) THEN None ELSE slots[k]]
CascadedFallback(M) ==
    LET Keep(t) == Variant = "noCascade" \/ ~RefersTo(M, t)
    IN SelectSeq(fallback, Keep)

Removed(cn, md, M) ==
    /\ edits < MaxEdits
    /\ Variant = "noCascade" \/ Valid(cn, md, CascadedStart(M), CascadedSlots(M), CascadedFallback(M))
    /\ Applied(cn, md, Dropped(M), CascadedStart(M), CascadedSlots(M), CascadedFallback(M))

AddConn(p, i) ==
    /\ p \notin conns
    /\ Edited(conns \cup {p}, [models EXCEPT ![p] = {Norm(p, i)}], win, start, slots, fallback)

AddModel(p, i) ==
    /\ p \in conns /\ Norm(p, i) \notin models[p]
    /\ Edited(conns, [models EXCEPT ![p] = @ \cup {Norm(p, i)}], win, start, slots, fallback)

RemoveConn(p) ==
    /\ p \in conns
    /\ Edited(conns \ {p}, [models EXCEPT ![p] = {}], Dropped({[prov |-> p, id |-> i] : i \in models[p]}), start, slots, fallback)

RemoveModel(p, i) ==
    /\ p \in conns /\ i \in models[p]
    /\ Edited(conns, [models EXCEPT ![p] = @ \ {i}], Dropped({[prov |-> p, id |-> i]}), start, slots, fallback)

RemoveModelCascade(p, i) ==
    /\ p \in conns /\ i \in models[p]
    /\ Removed(IF models[p] = {i} THEN conns \ {p} ELSE conns, [models EXCEPT ![p] = @ \ {i}], {[prov |-> p, id |-> i]})

RemoveConnCascade(p) ==
    /\ p \in conns
    /\ Removed(conns \ {p}, [models EXCEPT ![p] = {}], {[prov |-> p, id |-> i] : i \in models[p]})

SetStart(t) ==
    /\ t # start
    /\ Edited(conns, models, win, t, slots, fallback)

SetRole(k, t) ==
    /\ t # slots[k]
    /\ Edited(conns, models, win, start, [slots EXCEPT ![k] = t], fallback)

SetFallback(fb) ==
    /\ fb # fallback
    /\ Edited(conns, models, win, start, slots, fb)

SetModelField(p, i, v) ==
    /\ p \in conns /\ i \in models[p] /\ v # win[p][i]
    /\ Edited(conns, models, [win EXCEPT ![p][i] = v], start, slots, fallback)

Renamed(p, q, t) ==
    IF t # None /\ ((\E c \in ByCanon(Confs, t) : c.prov = p) \/ (ByCanon(Confs, t) = {} /\ Len(t) >= 2 /\ t[1] = p /\ ByShortRef(Confs, t) # {}))
    THEN <<q>> \o Tail(t)
    ELSE t

SetProvider(p, q) ==
    /\ p \in conns /\ q \notin conns /\ DefTag[q] = DefTag[p]
    /\ Edited((conns \ {p}) \cup {q},
               [models EXCEPT ![q] = models[p], ![p] = {}],
               [win EXCEPT ![q] = win[p], ![p] = [i \in ONames |-> 1]],
               Renamed(p, q, start),
               [k \in Slots |-> Renamed(p, q, slots[k])],
               [k \in 1..Len(fallback) |-> Renamed(p, q, fallback[k])])

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
    /\ StoredResolve(stored[s]).k = "found"
    /\ claim' = [claim EXCEPT ![s] = Claimed(StoredResolve(stored[s]).m)]
    /\ eff' = [eff EXCEPT ![s] = Claimed(StoredResolve(stored[s]).m)]
    /\ UNCHANGED <<settingsVars, pend, stored, origin>>

RunStep(s) ==
    /\ Variant = "unpinned"
    /\ claim[s] # None
    /\ eff' = [eff EXCEPT ![s] =
                 IF StoredResolve(stored[s]).k = "found"
                 THEN Claimed(StoredResolve(stored[s]).m)
                 ELSE [pin |-> None, chain |-> <<>>, role |-> None]]
    /\ UNCHANGED <<settingsVars, pend, stored, origin, claim>>

EndRun(s) ==
    /\ claim[s] # None
    /\ claim' = [claim EXCEPT ![s] = None]
    /\ eff' = [eff EXCEPT ![s] = None]
    /\ UNCHANGED <<settingsVars, pend, stored, origin>>

Next ==
    \/ \E p \in Provs, i \in Ids : AddConn(p, i) \/ AddModel(p, i)
    \/ \E p \in Provs, i \in ONames : RemoveModel(p, i) \/ RemoveModelCascade(p, i)
    \/ \E p \in Provs : RemoveConn(p) \/ RemoveConnCascade(p)
    \/ \E p \in Provs, q \in Provs : SetProvider(p, q)
    \/ \E p \in Provs, i \in ONames, v \in {1, 2} : SetModelField(p, i, v)
    \/ \E t \in Texts \cup {None} : SetStart(t)
    \/ \E k \in Slots, t \in Texts \cup {None} : SetRole(k, t)
    \/ \E fb \in FallbackSeqs : SetFallback(fb)
    \/ \E s \in Sessions : \E ref \in Texts \cup {None} : CreateSession(s, ref)
    \/ \E s \in Sessions : ResolveStore(s) \/ StartRun(s) \/ RunStep(s) \/ EndRun(s)
    \/ UNCHANGED vars

Spec == Init /\ [][Next]_vars

NoRebind ==
    \A s \in Sessions : stored[s] # None =>
        LET r == StoredResolve(stored[s]) IN r.k # "found" \/ r.m = origin[s]

NoGuess ==
    \A t \in Texts :
        (ByCanon(Confs, t) = {} /\ ByShortRef(Confs, t) = {} /\ Resolve(t).k = "found") => Cardinality(Holders(Confs, t)) = 1

ShortOnlyWithDefaultTag == \A c \in Confs : Short(c.prov, c.id) # None => DefTag[c.prov]

OneOwnNamePerModel == \A c \in Confs : DefTag[c.prov] => c.id # <<"x">>

RunKeepsPin == \A s \in Sessions : claim[s] # None => eff[s] = claim[s]

DisplayRoundTrip ==
    \A c \in Confs : Resolve(Display(c)).k = "found" /\ Resolve(Display(c)).m = c

WriterKeepsLoadable == Valid(conns, models, start, slots, fallback)

=============================================================================
