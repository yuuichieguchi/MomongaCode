---------------------------- MODULE RequestPrefix ----------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
    MaxSteps, MaxCalls, Keep, Deferred, MaxCompactions, MaxClaims,
    MaxArrivals, MaxGovChanges, MaxModeChanges, Caps,
    ModeYield, OfferPerBuild, GovFirstInF, RerankMemories, RerenderPerBuild, RefModel

VARIABLES
    hist, arrivals, gov, memo, offer, offerMode, mode, loaded, pending,
    claim, phase, recorded, lastReq, since, evs, sent, alive, wrapping,
    loadDirty, step, nextId, cap, loads, loadBatches, toolBreaks,
    offerChanges, modeChanges, compactions

vars == <<hist, arrivals, gov, memo, offer, offerMode, mode, loaded, pending,
          claim, phase, recorded, lastReq, since, evs, sent, alive, wrapping,
          loadDirty, step, nextId, cap, loads, loadBatches, toolBreaks,
          offerChanges, modeChanges, compactions>>

NamedEvents == {"eviction", "compaction", "compaction_rejected", "governing_changed", "instructions_arrived", "instructions_replaced", "skill_activated", "tools_loaded", "claim", "wrap_up"}

Modes == {"normal", "plan"}

Snaps == {1, 2}

ArrivalKinds == {"instructions_arrived", "skill_activated"}

NoLimit == 1000

Min2(a, b) == IF a < b THEN a ELSE b

Range(s) == {s[i] : i \in DOMAIN s}

IsOut(it) == it.kind \in {"load", "work"}

Unprotected(it) == IsOut(it) /\ ~it.evicted /\ it.step <= step - Keep

Truncated(it) == IsOut(it) /\ it.form # 0 /\ it.size > it.form

Full(it) == IsOut(it) /\ ~it.evicted /\ ~Truncated(it)

Candidate(it) == IsOut(it) /\ ~it.evicted /\ it.step <= step - Keep /\ it.dupOf = 0

NoGain(h, i) == h[i].size = 1 \/ \E j \in DOMAIN h : h[j].dupOf = h[i].id

NextReferent(h, i) ==
    IF h[i].kind # "work" \/ ~Full(h[i])
        THEN 0
        ELSE LET earlier == {j \in 1..(i - 1) : h[j].kind = "work" /\ h[j].cls = h[i].cls /\ Full(h[j])}
             IN IF earlier = {} THEN 0 ELSE h[CHOOSE j \in earlier : \A k \in earlier : j <= k].id

Refs(h) == [i \in DOMAIN h |-> IF IsOut(h[i]) THEN [h[i] EXCEPT !.dupOf = NextReferent(h, i)] ELSE h[i]]

Retained(it) == it.step > step - Keep /\ it.kind # "task"

EndOfF == 4 + Len(arrivals)

Render(it) ==
    CASE it.kind = "task" -> <<"task">>
      [] it.kind = "sum" -> <<"sum", it.form>>
      [] it.kind = "resp" -> <<"resp", it.step>>
      [] it.evicted -> <<"out", it.id, "evicted">>
      [] it.dupOf # 0 -> <<"out", it.id, "ref", it.dupOf>>
      [] Truncated(it) -> <<"out", it.id, "trunc", it.form>>
      [] OTHER -> <<"out", it.id, "full", it.form>>

ToolsSlot(wrap, om, of, ld) == IF wrap THEN <<"tools", "none">> ELSE <<"tools", om, of, ld>>

ArrSlots(arr) == [i \in DOMAIN arr |-> <<"arr", i, arr[i].kind, arr[i].ver>>]

FZone(m, arr, g) ==
    IF GovFirstInF
        THEN << <<"gov", g>>, <<"memo", m>> >> \o ArrSlots(arr)
        ELSE << <<"memo", m>> >> \o ArrSlots(arr) \o << <<"gov", g>> >>

Req(wrap, om, of, ld, m, arr, g, h) ==
    << ToolsSlot(wrap, om, of, ld), <<"S">> >> \o FZone(m, arr, g) \o [i \in DOMAIN h |-> Render(h[i])]

IsWrapReq(r) == Len(r) > 0 /\ r[1] = <<"tools", "none">>

CP(a, b) ==
    LET n == Min2(Len(a), Len(b))
        D == {i \in 1..n : a[i] # b[i]}
    IN IF D = {} THEN n ELSE (CHOOSE i \in D : \A j \in D : i <= j) - 1

FormsAt(h) == [i \in DOMAIN h |-> IF IsOut(h[i]) /\ ~h[i].evicted /\ (RerenderPerBuild \/ h[i].form = 0) THEN [h[i] EXCEPT !.form = cap] ELSE h[i]]

Task == [id |-> 0, kind |-> "task", step |-> 0, evicted |-> FALSE, dupOf |-> 0, form |-> 0, cls |-> 0, size |-> 1]

Summary == [id |-> 0, kind |-> "sum", step |-> 0, evicted |-> FALSE, dupOf |-> 0, form |-> "opaque", cls |-> 0, size |-> 1]

Rec(e, k) == /\ since' = Min2(since, k) /\ evs' = evs \cup {e}

NoRec == UNCHANGED <<since, evs>>

NoSend == sent' = "none"

Init ==
    /\ hist = << Task >>
    /\ arrivals = <<>>
    /\ gov = 0
    /\ memo = 0
    /\ offer = 1
    /\ offerMode = "normal"
    /\ mode = "normal"
    /\ loaded = <<>>
    /\ pending = {}
    /\ claim = 1
    /\ phase = "build"
    /\ recorded = <<>>
    /\ lastReq = <<>>
    /\ since = NoLimit
    /\ evs = {}
    /\ sent = "none"
    /\ alive = TRUE
    /\ wrapping = FALSE
    /\ loadDirty = FALSE
    /\ step = 0
    /\ nextId = 1
    /\ cap = CHOOSE c \in Caps : \A d \in Caps : c <= d
    /\ loads = 0
    /\ loadBatches = 0
    /\ toolBreaks = 0
    /\ offerChanges = 0
    /\ modeChanges = 0
    /\ compactions = 0

MemoChoices == IF RerankMemories THEN {1, 2} ELSE {IF memo = 0 THEN 1 ELSE memo}

Send(wrap, o, om, m, h) ==
    LET r == Req(wrap, om, o, loaded, m, arrivals, gov, h)
    IN /\ lastReq' = r
       /\ recorded' = r
       /\ toolBreaks' = toolBreaks + (IF lastReq # <<>> /\ lastReq[1] # r[1] THEN 1 ELSE 0)
       /\ memo' = m
       /\ offer' = o
       /\ offerMode' = om
       /\ hist' = h
       /\ since' = NoLimit
       /\ evs' = {}
       /\ loadDirty' = FALSE
       /\ phase' = "await"

Build ==
    /\ alive /\ phase = "build" /\ ~wrapping /\ step < MaxSteps
    /\ ~(ModeYield /\ mode # offerMode)
    /\ \E m \in MemoChoices, o \in (IF OfferPerBuild THEN Snaps ELSE {offer}) :
        Send(FALSE, o, IF OfferPerBuild THEN mode ELSE offerMode, m, Refs(FormsAt(hist)))
    /\ sent' = "build"
    /\ UNCHANGED <<arrivals, gov, mode, loaded, pending, claim, alive, wrapping, step, nextId, cap, loads, loadBatches, offerChanges, modeChanges, compactions>>

WrapUp ==
    /\ alive /\ phase = "build"
    /\ \E m \in MemoChoices : Send(TRUE, offer, offerMode, m, Refs(FormsAt(hist)))
    /\ wrapping' = TRUE
    /\ sent' = "wrapup"
    /\ UNCHANGED <<arrivals, gov, mode, loaded, pending, claim, alive, step, nextId, cap, loads, loadBatches, offerChanges, modeChanges, compactions>>

Respond ==
    /\ alive /\ phase = "await"
    /\ IF wrapping
        THEN /\ phase' = "done"
             /\ UNCHANGED <<hist, pending, step, nextId>>
        ELSE \E c \in 1..MaxCalls : \E nl \in 0..c :
                /\ phase' = "tools"
                /\ hist' = Append(hist, [id |-> 0, kind |-> "resp", step |-> step + 1, evicted |-> FALSE, dupOf |-> 0, form |-> 0, cls |-> 0, size |-> 1])
                /\ pending' = {[id |-> nextId + i, kind |-> IF i < nl THEN "load" ELSE "work"] : i \in 0..(c - 1)}
                /\ nextId' = nextId + c
                /\ step' = step + 1
    /\ recorded' = <<>>
    /\ NoRec /\ NoSend
    /\ UNCHANGED <<arrivals, gov, memo, offer, offerMode, mode, loaded, claim, lastReq, alive, wrapping, loadDirty, cap, loads, loadBatches, toolBreaks, offerChanges, modeChanges, compactions>>

WorkClasses == {x.cls : x \in {y \in Range(hist) : y.kind = "work"}}

ToolDone ==
    /\ alive /\ phase = "tools"
    /\ \E p \in pending :
        /\ pending' = pending \ {p}
        /\ phase' = IF pending \ {p} = {} THEN "build" ELSE "tools"
        /\ IF p.kind = "load"
            THEN \E t \in Deferred :
                    /\ hist' = Refs(Append(hist, [id |-> p.id, kind |-> "load", step |-> step, evicted |-> FALSE, dupOf |-> 0, form |-> 0, cls |-> p.id, size |-> 2]))
                    /\ IF t \in Range(loaded)
                        THEN /\ UNCHANGED <<loaded, loads, loadBatches, loadDirty>>
                             /\ NoRec
                        ELSE /\ loaded' = Append(loaded, t)
                             /\ loads' = loads + 1
                             /\ loadBatches' = loadBatches + (IF loadDirty THEN 0 ELSE 1)
                             /\ loadDirty' = TRUE
                             /\ Rec("tools_loaded", 0)
            ELSE \E c \in (IF RefModel THEN {p.id} \cup WorkClasses ELSE {p.id}), z \in (IF RefModel THEN 1..2 ELSE {2}) :
                    /\ hist' = Refs(Append(hist, [id |-> p.id, kind |-> "work", step |-> step, evicted |-> FALSE, dupOf |-> 0, form |-> 0, cls |-> c, size |-> z]))
                    /\ UNCHANGED <<loaded, loads, loadBatches, loadDirty>>
                    /\ NoRec
    /\ NoSend
    /\ UNCHANGED <<arrivals, gov, memo, offer, offerMode, mode, claim, recorded, lastReq, alive, wrapping, step, nextId, cap, toolBreaks, offerChanges, modeChanges, compactions>>

Evict ==
    /\ alive /\ phase = "build"
    /\ LET candidates == {i \in DOMAIN hist : Candidate(hist[i])}
       IN /\ candidates # {}
          /\ \E skipped \in SUBSET {i \in candidates : NoGain(hist, i)} :
                LET pool == candidates \ skipped
                IN /\ pool # {}
                   /\ LET first == CHOOSE i \in pool : \A j \in pool : i <= j
                          rendered == [i \in DOMAIN hist |->
                              IF i = first THEN [hist[i] EXCEPT !.evicted = TRUE]
                              ELSE IF IsOut(hist[i]) /\ ~hist[i].evicted /\ i > first THEN [hist[i] EXCEPT !.form = cap]
                              ELSE hist[i]]
                      IN /\ hist' = [i \in DOMAIN rendered |->
                                IF IsOut(rendered[i]) THEN [rendered[i] EXCEPT !.dupOf = NextReferent(rendered, i)] ELSE rendered[i]]
                         /\ Rec("eviction", EndOfF + first - 1)
    /\ NoSend
    /\ UNCHANGED <<arrivals, gov, memo, offer, offerMode, mode, loaded, pending, claim, phase, recorded, lastReq, alive, wrapping, loadDirty, step, nextId, cap, loads, loadBatches, toolBreaks, offerChanges, modeChanges, compactions>>

Compact ==
    /\ alive /\ phase = "build" /\ ~wrapping /\ compactions < MaxCompactions
    /\ LET kept == SelectSeq(hist, Retained)
       IN hist' = Refs(<< Task, Summary >> \o [i \in DOMAIN kept |->
            IF IsOut(kept[i])
                THEN [kept[i] EXCEPT !.form = IF kept[i].evicted THEN kept[i].form ELSE cap]
                ELSE kept[i]])
    /\ compactions' = compactions + 1
    /\ Rec("compaction", EndOfF)
    /\ NoSend
    /\ UNCHANGED <<arrivals, gov, memo, offer, offerMode, mode, loaded, pending, claim, phase, recorded, lastReq, alive, wrapping, loadDirty, step, nextId, cap, loads, loadBatches, toolBreaks, offerChanges, modeChanges>>

RejectCompaction ==
    /\ alive /\ phase = "await"
    /\ \E i \in DOMAIN hist : hist[i].kind = "sum" /\ hist[i].form = "opaque"
    /\ hist' = [i \in DOMAIN hist |-> IF hist[i].kind = "sum" THEN [hist[i] EXCEPT !.form = "text"] ELSE hist[i]]
    /\ phase' = "build"
    /\ recorded' = <<>>
    /\ Rec("compaction_rejected", EndOfF)
    /\ NoSend
    /\ UNCHANGED <<arrivals, gov, memo, offer, offerMode, mode, loaded, pending, claim, lastReq, alive, wrapping, loadDirty, step, nextId, cap, loads, loadBatches, toolBreaks, offerChanges, modeChanges, compactions>>

Arrive ==
    /\ alive /\ phase # "done"
    /\ \/ /\ Len(arrivals) < MaxArrivals
           /\ \E a \in ArrivalKinds :
                /\ arrivals' = Append(arrivals, [kind |-> a, ver |-> 0])
                /\ Rec(a, 3 + Len(arrivals))
       \/ \E i \in DOMAIN arrivals :
            /\ arrivals[i].kind = "instructions_arrived" /\ arrivals[i].ver = 0
            /\ arrivals' = [arrivals EXCEPT ![i].ver = 1]
            /\ Rec("instructions_replaced", 2 + i)
    /\ NoSend
    /\ UNCHANGED <<hist, gov, memo, offer, offerMode, mode, loaded, pending, claim, phase, recorded, lastReq, alive, wrapping, loadDirty, step, nextId, cap, loads, loadBatches, toolBreaks, offerChanges, modeChanges, compactions>>

GovChange ==
    /\ alive /\ phase # "done" /\ gov < MaxGovChanges
    /\ gov' = gov + 1
    /\ Rec("governing_changed", 3 + Len(arrivals))
    /\ NoSend
    /\ UNCHANGED <<hist, arrivals, memo, offer, offerMode, mode, loaded, pending, claim, phase, recorded, lastReq, alive, wrapping, loadDirty, step, nextId, cap, loads, loadBatches, toolBreaks, offerChanges, modeChanges, compactions>>

ModeChanged ==
    /\ phase # "done" /\ modeChanges < MaxModeChanges
    /\ \E m \in Modes \ {mode} : mode' = m
    /\ modeChanges' = modeChanges + 1
    /\ NoRec /\ NoSend
    /\ UNCHANGED <<hist, arrivals, gov, memo, offer, offerMode, loaded, pending, claim, phase, recorded, lastReq, alive, wrapping, loadDirty, step, nextId, cap, loads, loadBatches, toolBreaks, offerChanges, compactions>>

CapacityChanged ==
    /\ phase = "build"
    /\ \E c \in Caps \ {cap} : cap' = c
    /\ NoRec /\ NoSend
    /\ UNCHANGED <<hist, arrivals, gov, memo, offer, offerMode, mode, loaded, pending, claim, phase, recorded, lastReq, alive, wrapping, loadDirty, step, nextId, loads, loadBatches, toolBreaks, offerChanges, modeChanges, compactions>>

StartClaim(snap) ==
    /\ claim < MaxClaims
    /\ claim' = claim + 1
    /\ offer' = snap
    /\ offerMode' = mode
    /\ offerChanges' = offerChanges + (IF snap # offer \/ mode # offerMode THEN 1 ELSE 0)
    /\ Rec("claim", IF snap # offer \/ mode # offerMode THEN 0 ELSE Len(lastReq))

Yield ==
    /\ alive /\ phase = "build"
    /\ StartClaim(offer)
    /\ NoSend
    /\ UNCHANGED <<hist, arrivals, gov, memo, mode, loaded, pending, phase, recorded, lastReq, alive, wrapping, loadDirty, step, nextId, cap, loads, loadBatches, toolBreaks, modeChanges, compactions>>

YieldOnMode ==
    /\ ModeYield /\ mode # offerMode
    /\ alive /\ phase = "build"
    /\ StartClaim(offer)
    /\ NoSend
    /\ UNCHANGED <<hist, arrivals, gov, memo, mode, loaded, pending, phase, recorded, lastReq, alive, wrapping, loadDirty, step, nextId, cap, loads, loadBatches, toolBreaks, modeChanges, compactions>>

Crash ==
    /\ alive /\ phase # "done" /\ claim < MaxClaims
    /\ alive' = FALSE
    /\ NoRec /\ NoSend
    /\ UNCHANGED <<hist, arrivals, gov, memo, offer, offerMode, mode, loaded, pending, claim, phase, recorded, lastReq, wrapping, loadDirty, step, nextId, cap, loads, loadBatches, toolBreaks, offerChanges, modeChanges, compactions>>

Reclaim ==
    /\ ~alive
    /\ \E snapshotChanged \in BOOLEAN : StartClaim(IF snapshotChanged THEN 3 - offer ELSE offer)
    /\ alive' = TRUE
    /\ IF phase = "await"
        THEN /\ lastReq' = recorded
             /\ sent' = "resend"
        ELSE /\ UNCHANGED lastReq
             /\ NoSend
    /\ UNCHANGED <<hist, arrivals, gov, memo, mode, loaded, pending, phase, recorded, wrapping, loadDirty, step, nextId, cap, loads, loadBatches, toolBreaks, modeChanges, compactions>>

Terminated == phase = "done" /\ UNCHANGED vars

Next ==
    \/ Build \/ WrapUp \/ Respond \/ ToolDone \/ Evict \/ Compact \/ RejectCompaction
    \/ Arrive \/ GovChange \/ ModeChanged \/ CapacityChanged
    \/ YieldOnMode \/ Yield \/ Crash \/ Reclaim
    \/ Terminated

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------

DeferredSymmetry == Permutations(Deferred)

TypeOK ==
    /\ phase \in {"build", "await", "tools", "done"}
    /\ sent \in {"none", "build", "wrapup", "resend"}
    /\ evs \subseteq NamedEvents
    /\ claim \in 1..MaxClaims
    /\ mode \in Modes /\ offerMode \in Modes
    /\ offer \in Snaps
    /\ cap \in Caps
    /\ since \in 0..NoLimit
    /\ step \in 0..MaxSteps
    /\ Len(loaded) <= Cardinality(Deferred)
    /\ \A i \in DOMAIN hist : hist[i].kind \in {"task", "sum", "resp", "load", "work"}

PrefixStable ==
    [][sent' \in {"build", "wrapup"} =>
        CP(lastReq, lastReq') >= Min2(Len(lastReq), Min2(since, IF sent' = "wrapup" /\ ~IsWrapReq(lastReq) THEN 0 ELSE NoLimit))]_vars

WrapBreak == IF wrapping THEN 1 ELSE 0

LoadBreaksOnce == toolBreaks <= loadBatches + offerChanges + WrapBreak

LoadedPersist ==
    [][/\ SubSeq(loaded', 1, Len(loaded)) = loaded
       /\ sent' = "build" => lastReq'[1] = <<"tools", offerMode', offer', loaded'>>]_vars

NoProtectedEvicted ==
    [][compactions' = compactions =>
        \A i \in DOMAIN hist : (~hist[i].evicted /\ hist'[i].evicted) => (IsOut(hist[i]) /\ hist[i].step <= step - Keep)]_vars

OldestFirst ==
    [][compactions' = compactions =>
        \A i \in DOMAIN hist : (~hist[i].evicted /\ hist'[i].evicted) =>
            \A j \in 1..(i - 1) : Candidate(hist[j]) => (hist'[j].evicted \/ NoGain(hist, j))]_vars

ResendUnchanged ==
    [][sent' = "resend" => (lastReq' = lastReq /\ lastReq' = recorded)]_vars

RefNeverEvicted == \A i \in DOMAIN hist : hist[i].evicted => hist[i].dupOf = 0

RefShowsFullReferent ==
    /\ \A i \in DOMAIN hist : (IsOut(hist[i]) /\ ~hist[i].evicted /\ hist[i].dupOf # 0) =>
        \E j \in 1..(i - 1) : hist[j].id = hist[i].dupOf /\ Full(hist[j]) /\ hist[j].dupOf = 0
    /\ \A i \in DOMAIN lastReq : (lastReq[i][1] = "out" /\ lastReq[i][3] = "ref") =>
        \E j \in 1..(i - 1) : lastReq[j][1] = "out" /\ lastReq[j][2] = lastReq[i][4] /\ lastReq[j][3] = "full"

FAppendOnly ==
    [][/\ \/ SubSeq(arrivals', 1, Len(arrivals)) = arrivals
          \/ /\ Len(arrivals') = Len(arrivals)
             /\ \E i \in DOMAIN arrivals : arrivals' = [arrivals EXCEPT ![i].ver = arrivals[i].ver + 1]
       /\ (memo # 0 => memo' = memo)]_vars

WrapUpIsLast ==
    [][(IsWrapReq(lastReq) /\ sent' \in {"build", "wrapup"}) => (sent' = "wrapup" /\ "compaction_rejected" \in evs)]_vars

OfferMatchesMode ==
    [][sent' = "build" => mode = offerMode']_vars

FormsChangeOnlyAfterBreak ==
    [][compactions' = compactions =>
        \A i \in DOMAIN hist :
            (IsOut(hist[i]) /\ hist[i].form # 0 /\ hist'[i].form # hist[i].form) =>
                \E j \in 1..i : ~hist[j].evicted /\ hist'[j].evicted]_vars

=============================================================================
