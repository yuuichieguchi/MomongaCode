------------------------------ MODULE ModelRef ------------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Provs, Ids, Sessions, MaxEdits, None, DefTag, Managed, ServerOf, Servers, Reserved, KindFlips, PrintTable, Variant

ASSUME Variant \in {"decided", "storeDisplay", "lastWins", "unpinned", "noCascade", "storedBareName", "shortFirst", "displayShortOnly", "shortEverywhere", "noNorm",
                    "serveUnchecked", "forgetUsed", "flipNoNorm", "reclaimRepins", "roleLate"}
ASSUME DefTag \in [Provs -> BOOLEAN]
ASSUME Managed \in [Provs -> BOOLEAN]
ASSUME ServerOf \in [Provs -> Servers \cup {None}]
ASSUME Reserved \subseteq Provs
ASSUME KindFlips \in BOOLEAN /\ PrintTable \in BOOLEAN
ASSUME MaxEdits \in Nat
ASSUME \A i \in Ids : Len(i) >= 1

IdsPlain == {<<"x">>, <<"y">>}
IdsSlash == {<<"x">>, <<"p1", "x">>}
IdsTag == {<<"x">>, <<"x:latest">>, <<"y">>}
IdsSlashTag == {<<"x">>, <<"x:latest">>, <<"p1", "x">>}
DefTagMixed == [p \in Provs |-> p = "p1"]
DefTagNone == [p \in Provs |-> FALSE]
DefTagAll == [p \in Provs |-> TRUE]
ManagedNone == [p \in Provs |-> FALSE]
ManagedP2 == [p \in Provs |-> p = "p2"]
ServerOfNone == [p \in Provs |-> None]
ServerOfP2 == [p \in Provs |-> IF p = "p2" THEN "sv" ELSE None]

ShortK(kd, p, i) ==
    IF (kd[p] \/ Variant = "shortEverywhere") /\ i = <<"x:latest">> THEN <<"x">> ELSE None

NormK(kd, p, i) == IF kd[p] /\ Variant # "noNorm" /\ i = <<"x">> THEN <<"x:latest">> ELSE i

ONames == Ids \cup {<<"x:latest">> : i \in {j \in Ids : j = <<"x">>}}
AllNames == ONames \cup {<<"x">> : n \in {j \in ONames : j = <<"x:latest">>}}

Canon(c) == <<c.prov>> \o c.id
Texts == AllNames \cup {<<p>> \o n : p \in Provs, n \in AllNames}
Confs0 == {[prov |-> p, id |-> i] : p \in Provs, i \in ONames}

Slots == {"role", "classifier", "scope"}

VARIABLES conns, models, win, kind, declared, serving, start, slots, fallback, edits,
          pend, stored, origin, claim, eff, switched, origClaim

settingsVars == <<conns, models, win, kind, declared, start, slots, fallback, edits>>
sessionVars == <<pend, stored, origin, claim, eff, switched, origClaim>>
vars == <<conns, models, win, kind, declared, serving, start, slots, fallback, edits, pend, stored, origin, claim, eff, switched, origClaim>>

ConfsOf(cn, md) == UNION {{[prov |-> p, id |-> i] : i \in md[p]} : p \in cn}
Confs == ConfsOf(conns, models)

HoldersK(kd, cs, t) == {c \in cs : c.id = t \/ ShortK(kd, c.prov, c.id) = t}
ByCanon(cs, t) == {c \in cs : Canon(c) = t}
ByShortRefK(kd, cs, t) == {c \in cs : Len(t) >= 2 /\ t[1] = c.prov /\ ShortK(kd, c.prov, c.id) = Tail(t)}
ShortHoldersK(kd, cs, t) == {c \in cs : ShortK(kd, c.prov, c.id) = t}

ResolveK(kd, cs, t) ==
    IF ByCanon(cs, t) # {}
    THEN [k |-> "found", m |-> CHOOSE c \in ByCanon(cs, t) : TRUE]
    ELSE IF ByShortRefK(kd, cs, t) # {}
    THEN [k |-> "found", m |-> CHOOSE c \in ByShortRefK(kd, cs, t) : TRUE]
    ELSE IF Variant = "shortFirst" /\ ShortHoldersK(kd, cs, t) # {}
    THEN [k |-> "found", m |-> CHOOSE c \in ShortHoldersK(kd, cs, t) : TRUE]
    ELSE IF Cardinality(HoldersK(kd, cs, t)) = 1
    THEN [k |-> "found", m |-> CHOOSE c \in HoldersK(kd, cs, t) : TRUE]
    ELSE IF Cardinality(HoldersK(kd, cs, t)) = 0
    THEN [k |-> "missing"]
    ELSE IF Variant = "lastWins"
    THEN [k |-> "found", m |-> CHOOSE c \in HoldersK(kd, cs, t) : TRUE]
    ELSE [k |-> "ambiguous"]

StoredK(kd, cs, t) ==
    IF Variant \in {"storeDisplay", "storedBareName"}
    THEN ResolveK(kd, cs, t)
    ELSE IF ByCanon(cs, t) # {}
    THEN [k |-> "found", m |-> CHOOSE c \in ByCanon(cs, t) : TRUE]
    ELSE [k |-> "missing"]

ShownNameK(kd, c) == IF ShortK(kd, c.prov, c.id) # None THEN ShortK(kd, c.prov, c.id) ELSE c.id

DisplayK(kd, cs, c) ==
    IF Variant = "displayShortOnly" THEN ShownNameK(kd, c)
    ELSE IF ResolveK(kd, cs, ShownNameK(kd, c)).k = "found" /\ ResolveK(kd, cs, ShownNameK(kd, c)).m = c THEN ShownNameK(kd, c)
    ELSE IF ResolveK(kd, cs, <<c.prov>> \o ShownNameK(kd, c)).k = "found" /\ ResolveK(kd, cs, <<c.prov>> \o ShownNameK(kd, c)).m = c THEN <<c.prov>> \o ShownNameK(kd, c)
    ELSE Canon(c)

Short(p, i) == ShortK(kind, p, i)
Resolve(t) == ResolveK(kind, Confs, t)
StoredResolve(t) == StoredK(kind, Confs, t)
Display(c) == DisplayK(kind, Confs, c)
ByShortRef(cs, t) == ByShortRefK(kind, cs, t)
Holders(cs, t) == HoldersK(kind, cs, t)

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

ServedOK(m) == Variant = "serveUnchecked" \/ ~Managed[m.prov] \/ serving[m.prov] = m.id
Served(m) == ~Managed[m.prov] \/ serving[m.prov] = m.id

FallbackSeqs == {<<>>} \cup {<<a>> : a \in Texts} \cup {<<a, b>> : a \in Texts, b \in Texts}

ValidK(kd, dc, cn, md, st, sl, fb) ==
    LET cs == ConfsOf(cn, md) IN
    /\ \A p \in cn : md[p] # {} /\ (Managed[p] => Cardinality(md[p]) = 1 /\ ServerOf[p] \in dc)
    /\ IF st = None THEN TRUE ELSE ResolveK(kd, cs, st).k = "found"
    /\ \A k \in Slots : IF sl[k] = None THEN TRUE ELSE ResolveK(kd, cs, sl[k]).k = "found"
    /\ \A k \in 1..Len(fb) : ResolveK(kd, cs, fb[k]).k = "found"

TypeOK ==
    /\ conns \subseteq Provs
    /\ models \in [Provs -> SUBSET ONames]
    /\ \A p \in Provs : p \notin conns => models[p] = {}
    /\ start \in Texts \cup {None}
    /\ slots \in [Slots -> Texts \cup {None}]
    /\ win \in [Provs -> [ONames -> {1, 2}]]
    /\ kind \in [Provs -> BOOLEAN]
    /\ declared \subseteq Servers
    /\ serving \in [Provs -> ONames \cup {None}]
    /\ fallback \in FallbackSeqs
    /\ edits \in 0..MaxEdits
    /\ stored \in [Sessions -> Texts \cup {None}]
    /\ origin \in [Sessions -> Confs0 \cup {None}]
    /\ switched \in [Sessions -> BOOLEAN]

Init ==
    /\ conns = {}
    /\ models = [p \in Provs |-> {}]
    /\ start = None /\ slots = [k \in Slots |-> None] /\ fallback = <<>>
    /\ win = [p \in Provs |-> [i \in ONames |-> 1]]
    /\ kind = DefTag
    /\ declared = {}
    /\ serving = [p \in Provs |-> None]
    /\ edits = 0
    /\ pend = [s \in Sessions |-> None]
    /\ stored = [s \in Sessions |-> None]
    /\ origin = [s \in Sessions |-> None]
    /\ claim = [s \in Sessions |-> None]
    /\ eff = [s \in Sessions |-> None]
    /\ switched = [s \in Sessions |-> FALSE]
    /\ origClaim = [s \in Sessions |-> None]

Applied(cn, md, wn, kd, dc, sv, st, sl, fb) ==
    /\ conns' = cn /\ models' = md /\ win' = wn /\ kind' = kd /\ declared' = dc /\ serving' = sv
    /\ start' = st /\ slots' = sl /\ fallback' = fb
    /\ edits' = edits + 1
    /\ UNCHANGED sessionVars

EditedAll(cn, md, wn, kd, dc, sv, st, sl, fb) ==
    /\ edits < MaxEdits
    /\ ValidK(kd, dc, cn, md, st, sl, fb)
    /\ Applied(cn, md, wn, kd, dc, sv, st, sl, fb)

Edited(cn, md, wn, st, sl, fb) == EditedAll(cn, md, wn, kind, declared, serving, st, sl, fb)

Dropped(M) == [p \in Provs |-> [i \in ONames |-> IF [prov |-> p, id |-> i] \in M THEN 1 ELSE win[p][i]]]

RefersTo(M, t) == t # None /\ Resolve(t).k = "found" /\ Resolve(t).m \in M

CascadedStart(M) == IF Variant # "noCascade" /\ RefersTo(M, start) THEN None ELSE start
CascadedSlots(M) == [k \in Slots |-> IF Variant # "noCascade" /\ RefersTo(M, slots[k]) THEN None ELSE slots[k]]
CascadedFallback(M) ==
    LET Keep(t) == Variant = "noCascade" \/ ~RefersTo(M, t)
    IN SelectSeq(fallback, Keep)

Removed(cn, md, M) ==
    /\ edits < MaxEdits
    /\ Variant = "noCascade" \/ ValidK(kind, declared, cn, md, CascadedStart(M), CascadedSlots(M), CascadedFallback(M))
    /\ Applied(cn, md, Dropped(M), kind, declared, serving, CascadedStart(M), CascadedSlots(M), CascadedFallback(M))

AddConn(p, i) ==
    LET n == NormK(DefTag, p, i) IN
    /\ p \notin conns
    /\ EditedAll(conns \cup {p}, [models EXCEPT ![p] = {n}], win, [kind EXCEPT ![p] = DefTag[p]], declared,
                 IF Managed[p] THEN [serving EXCEPT ![p] = n] ELSE serving, start, slots, fallback)

AddModel(p, i) ==
    /\ p \in conns /\ ~Managed[p] /\ NormK(kind, p, i) \notin models[p]
    /\ Edited(conns, [models EXCEPT ![p] = @ \cup {NormK(kind, p, i)}], win, start, slots, fallback)

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
    /\ p \in conns /\ q \notin conns
    /\ Managed[q] = Managed[p] /\ ServerOf[q] = ServerOf[p]
    /\ q \in Reserved => kind[p] = DefTag[q]
    /\ EditedAll((conns \ {p}) \cup {q},
                 [models EXCEPT ![q] = models[p], ![p] = {}],
                 [win EXCEPT ![q] = win[p], ![p] = [i \in ONames |-> 1]],
                 [kind EXCEPT ![q] = kind[p], ![p] = DefTag[p]],
                 declared,
                 [serving EXCEPT ![q] = serving[p], ![p] = None],
                 Renamed(p, q, start),
                 [k \in Slots |-> Renamed(p, q, slots[k])],
                 [k \in 1..Len(fallback) |-> Renamed(p, q, fallback[k])])

SetKind(p, b) ==
    LET kd == [kind EXCEPT ![p] = b]
        renamed == IF Variant = "flipNoNorm" THEN models[p] ELSE {NormK(kd, p, i) : i \in models[p]}
        wn == IF Variant = "flipNoNorm" THEN win[p]
              ELSE [j \in ONames |-> IF \E i \in models[p] : NormK(kd, p, i) = j THEN win[p][CHOOSE i \in models[p] : NormK(kd, p, i) = j] ELSE 1]
    IN /\ KindFlips /\ p \in conns /\ p \notin Reserved /\ ~Managed[p] /\ b # kind[p]
       /\ Variant = "flipNoNorm" \/ Cardinality(renamed) = Cardinality(models[p])
       /\ EditedAll(conns, [models EXCEPT ![p] = renamed], [win EXCEPT ![p] = wn], kd, declared, serving, start, slots, fallback)

DeclareServer(sv) ==
    /\ sv \notin declared
    /\ EditedAll(conns, models, win, kind, declared \cup {sv}, serving, start, slots, fallback)

ForgetServer(sv) ==
    /\ sv \in declared
    /\ \/ /\ Variant = "forgetUsed"
          /\ edits < MaxEdits
          /\ Applied(conns, models, win, kind, declared \ {sv}, serving, start, slots, fallback)
       \/ /\ Variant # "forgetUsed"
          /\ \A p \in conns : ~(Managed[p] /\ ServerOf[p] = sv)
          /\ EditedAll(conns, models, win, kind, declared \ {sv}, serving, start, slots, fallback)

ServerLists(p, j) ==
    /\ Managed[p] /\ p \in conns /\ j # serving[p]
    /\ serving' = [serving EXCEPT ![p] = j]
    /\ UNCHANGED <<settingsVars, sessionVars>>

CreateSession(s, ref) ==
    LET r == IF ref = None THEN StartModel ELSE Resolve(ref) IN
    /\ pend[s] = None
    /\ r.k = "found"
    /\ pend' = [pend EXCEPT ![s] = [m |-> r.m, disp |-> Display(r.m)]]
    /\ UNCHANGED <<settingsVars, serving, stored, origin, claim, eff, switched, origClaim>>

ResolveStore(s) ==
    /\ pend[s] # None
    /\ stored' = [stored EXCEPT ![s] = IF Variant = "storeDisplay" THEN pend[s].disp ELSE Canon(pend[s].m)]
    /\ origin' = [origin EXCEPT ![s] = pend[s].m]
    /\ pend' = [pend EXCEPT ![s] = None]
    /\ UNCHANGED <<settingsVars, serving, claim, eff, switched, origClaim>>

ChangeSessionModel(s, ref) ==
    LET r == Resolve(ref) IN
    /\ pend[s] = None
    /\ r.k = "found"
    /\ stored' = [stored EXCEPT ![s] = IF Variant = "storeDisplay" THEN Display(r.m) ELSE Canon(r.m)]
    /\ origin' = [origin EXCEPT ![s] = r.m]
    /\ switched' = [switched EXCEPT ![s] = switched[s] \/ claim[s] # None]
    /\ UNCHANGED <<settingsVars, serving, pend, claim, eff, origClaim>>

StartRun(s) ==
    /\ claim[s] = None
    /\ stored[s] # None
    /\ StoredResolve(stored[s]).k = "found"
    /\ ServedOK(StoredResolve(stored[s]).m)
    /\ claim' = [claim EXCEPT ![s] = Claimed(StoredResolve(stored[s]).m)]
    /\ eff' = [eff EXCEPT ![s] = Claimed(StoredResolve(stored[s]).m)]
    /\ origClaim' = [origClaim EXCEPT ![s] = Claimed(StoredResolve(stored[s]).m)]
    /\ switched' = [switched EXCEPT ![s] = FALSE]
    /\ UNCHANGED <<settingsVars, serving, pend, stored, origin>>

RunStep(s) ==
    /\ Variant \in {"unpinned", "roleLate"}
    /\ claim[s] # None
    /\ eff' = [eff EXCEPT ![s] =
                 IF Variant = "roleLate"
                 THEN [eff[s] EXCEPT !.role = RoleModel]
                 ELSE IF StoredResolve(stored[s]).k = "found" /\ ServedOK(StoredResolve(stored[s]).m)
                 THEN Claimed(StoredResolve(stored[s]).m)
                 ELSE [pin |-> None, chain |-> <<>>, role |-> None]]
    /\ UNCHANGED <<settingsVars, serving, pend, stored, origin, claim, switched, origClaim>>

ReclaimRun(s) ==
    /\ claim[s] # None
    /\ \/ /\ Variant = "reclaimRepins"
          /\ IF StoredResolve(stored[s]).k = "found"
             THEN /\ claim' = [claim EXCEPT ![s] = Claimed(StoredResolve(stored[s]).m)]
                  /\ eff' = [eff EXCEPT ![s] = Claimed(StoredResolve(stored[s]).m)]
                  /\ origClaim' = origClaim
             ELSE /\ claim' = [claim EXCEPT ![s] = None]
                  /\ eff' = [eff EXCEPT ![s] = None]
                  /\ origClaim' = [origClaim EXCEPT ![s] = None]
          /\ switched' = [switched EXCEPT ![s] = FALSE]
       \/ /\ Variant # "reclaimRepins"
          /\ \/ /\ ~switched[s] /\ ServedOK(claim[s].pin)
                /\ UNCHANGED <<claim, eff, origClaim, switched>>
             \/ /\ switched[s] \/ ~ServedOK(claim[s].pin)
                /\ claim' = [claim EXCEPT ![s] = None]
                /\ eff' = [eff EXCEPT ![s] = None]
                /\ origClaim' = [origClaim EXCEPT ![s] = None]
                /\ switched' = [switched EXCEPT ![s] = FALSE]
    /\ UNCHANGED <<settingsVars, serving, pend, stored, origin>>

EndRun(s) ==
    /\ claim[s] # None
    /\ claim' = [claim EXCEPT ![s] = None]
    /\ eff' = [eff EXCEPT ![s] = None]
    /\ origClaim' = [origClaim EXCEPT ![s] = None]
    /\ switched' = [switched EXCEPT ![s] = FALSE]
    /\ UNCHANGED <<settingsVars, serving, pend, stored, origin>>

Next ==
    \/ \E p \in Provs, i \in Ids : AddConn(p, i) \/ AddModel(p, i)
    \/ \E p \in Provs, i \in ONames : RemoveModel(p, i) \/ RemoveModelCascade(p, i)
    \/ \E p \in Provs : RemoveConn(p) \/ RemoveConnCascade(p)
    \/ \E p \in Provs, q \in Provs : SetProvider(p, q)
    \/ \E p \in Provs, b \in BOOLEAN : SetKind(p, b)
    \/ \E sv \in Servers : DeclareServer(sv) \/ ForgetServer(sv)
    \/ \E p \in Provs, j \in ONames : ServerLists(p, j)
    \/ \E p \in Provs, i \in ONames, v \in {1, 2} : SetModelField(p, i, v)
    \/ \E t \in Texts \cup {None} : SetStart(t)
    \/ \E k \in Slots, t \in Texts \cup {None} : SetRole(k, t)
    \/ \E fb \in FallbackSeqs : SetFallback(fb)
    \/ \E s \in Sessions : \E ref \in Texts \cup {None} : CreateSession(s, ref)
    \/ \E s \in Sessions : \E ref \in Texts : ChangeSessionModel(s, ref)
    \/ \E s \in Sessions : ResolveStore(s) \/ StartRun(s) \/ RunStep(s) \/ ReclaimRun(s) \/ EndRun(s)
    \/ UNCHANGED vars

Spec == Init /\ [][Next]_vars

NoRebind ==
    \A s \in Sessions : stored[s] # None =>
        LET r == StoredResolve(stored[s]) IN r.k # "found" \/ r.m = origin[s]

NoGuess ==
    \A t \in Texts :
        (ByCanon(Confs, t) = {} /\ ByShortRef(Confs, t) = {} /\ Resolve(t).k = "found") => Cardinality(Holders(Confs, t)) = 1

ShortOnlyWithDefaultTag == \A c \in Confs : Short(c.prov, c.id) # None => kind[c.prov]

OneOwnNamePerModel == \A c \in Confs : kind[c.prov] => c.id # <<"x">>

RunKeepsPin == \A s \in Sessions : claim[s] # None => eff[s] = claim[s]

ResumeKeepsPin == \A s \in Sessions : claim[s] # None => claim[s] = origClaim[s]

DisplayRoundTrip ==
    \A c \in Confs : Resolve(Display(c)).k = "found" /\ Resolve(Display(c)).m = c

WriterKeepsLoadable == ValidK(kind, declared, conns, models, start, slots, fallback)

ServedIsNamed ==
    [][\A s \in Sessions : (claim'[s] # None /\ claim'[s] # claim[s]) => Served(claim'[s].pin)]_vars

SettingsOf(cn, md) == [conns |-> cn, models |-> md]

TableSettings ==
    UNION {{SettingsOf(cn, md) :
              md \in {m \in [Provs -> SUBSET ONames] :
                        /\ \A p \in Provs : p \notin cn => m[p] = {}
                        /\ \A p \in cn : m[p] # {} /\ \A i \in m[p] : NormK(DefTag, p, i) = i}} :
           cn \in SUBSET Provs}

ResolutionTable ==
    {[settings |-> st,
      typed |-> {[text |-> t, outcome |-> LET r == ResolveK(DefTag, ConfsOf(st.conns, st.models), t) IN
                     IF r.k = "found" THEN [k |-> "found", prov |-> r.m.prov, id |-> r.m.id] ELSE [k |-> r.k]] : t \in Texts},
      stored |-> {[text |-> t, outcome |-> LET r == StoredK(DefTag, ConfsOf(st.conns, st.models), t) IN
                     IF r.k = "found" THEN [k |-> "found", prov |-> r.m.prov, id |-> r.m.id] ELSE [k |-> r.k]] : t \in Texts},
      display |-> {[prov |-> c.prov, id |-> c.id, text |-> DisplayK(DefTag, ConfsOf(st.conns, st.models), c)] : c \in ConfsOf(st.conns, st.models)}] :
      st \in TableSettings}

ASSUME PrintTable => PrintT(<<"MODELREF-TABLE", [defaultTag |-> DefTag, rows |-> ResolutionTable]>>)

=============================================================================
