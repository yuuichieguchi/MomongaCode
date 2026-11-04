---------------------------- MODULE RequestPrefix ----------------------------
(***************************************************************************)
(* Design model of the request prefix of one MomongaCode run (token/       *)
(* t2-t5-design.md, revision 4, sections 1, 4 and 9). A request is the    *)
(* concatenation tools || S || F || H, modelled as a sequence of slots.    *)
(* It describes what the design says the code does.                        *)
(*                                                                         *)
(* Code sources modelled                                                   *)
(*   packages/context/src/build-context.ts  assembly, eviction,            *)
(*       compaction, references, frozen forms                              *)
(*   packages/runtime/src/worker/*  context-step, model-step,              *)
(*       claim-runner (offer, recovery, the mode yield)                    *)
(*   the loader of deferred tool definitions                               *)
(*                                                                         *)
(* Abstractions (a proof holds only for this model):                       *)
(*   - token sizes: Evict takes any k >= 1 of the oldest unprotected       *)
(*     outputs; the arithmetic is Z3's                                     *)
(*   - item content, child runs, TTLs, the wire mapping and time           *)
(*   - S is one constant slot; an output is "big" at every cap, so its     *)
(*     first form is the cap of the build that renders it                  *)
(*   - an Arrive appends one entry to F; a replacement of an entry by an   *)
(*     edited file is not modelled                                         *)
(*   - a call that completes appends its output to the history at once;    *)
(*     the outputs of parallel calls complete in any order                 *)
(*   - the duplicate of an output is the oldest earlier work output that   *)
(*     is still shown in full                                              *)
(*                                                                         *)
(* Additions to the variables of section 9: id on every item, step, alive, *)
(* wrapping, loadDirty, nextId, modeChanges, compactions, cap, form, evs,  *)
(* sent, prefixOk; cut is the evicted flags of the items. PrefixStable is  *)
(* the state predicate prefixOk, set by each request that is built: the    *)
(* harness reads a refutation only from a violated invariant.              *)
(*                                                                         *)
(* Configurations (scripts/tlc.sh <name>, specs/tla/<name>.cfg)            *)
(*   RequestPrefix              every property, ModeYield = TRUE: holds    *)
(*   RequestPrefix.noModeYield  ModeYield = FALSE, OfferMatchesMode not    *)
(*                              checked: holds                             *)
(*   RequestPrefix.offerPerBuild   the offer recomputed at every build:    *)
(*                              PrefixStable refuted                       *)
(*   RequestPrefix.govFirst     the governing block first in F:            *)
(*                              PrefixStable refuted                       *)
(*   RequestPrefix.rerank       memories ranked at every build:            *)
(*                              PrefixStable refuted                       *)
(*   RequestPrefix.rerenderPerBuild  forms recomputed from cap at every    *)
(*                              build: PrefixStable refuted                *)
(*   RequestPrefix.deep         the next larger MaxSteps: holds            *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    MaxSteps, MaxCalls, Keep, Deferred, MaxCompactions, MaxClaims,
    MaxArrivals, MaxGovChanges, MaxModeChanges, Caps,
    ModeYield, OfferPerBuild, GovFirstInF, RerankMemories, RerenderPerBuild

VARIABLES
    hist, arrivals, gov, memo, offer, offerMode, mode, loaded, pending,
    claim, phase, recorded, lastReq, since, evs, sent, alive, wrapping,
    loadDirty, step, nextId, cap, loads, loadBatches, toolBreaks,
    offerChanges, modeChanges, compactions, prefixOk

vars == <<hist, arrivals, gov, memo, offer, offerMode, mode, loaded, pending,
          claim, phase, recorded, lastReq, since, evs, sent, alive, wrapping,
          loadDirty, step, nextId, cap, loads, loadBatches, toolBreaks,
          offerChanges, modeChanges, compactions, prefixOk>>

NamedEvents == {"eviction", "compaction", "compaction_rejected", "governing_changed", "instructions_arrived", "skill_activated", "tools_loaded", "claim", "wrap_up"}

Modes == {"normal", "plan"}

Snaps == {1, 2}

ArrivalKinds == {"instructions_arrived", "skill_activated"}

NoLimit == 1000

Min2(a, b) == IF a < b THEN a ELSE b

Range(s) == {s[i] : i \in DOMAIN s}

IsOut(it) == it.kind \in {"load", "work"}

Unprotected(it) == IsOut(it) /\ ~it.evicted /\ it.step <= step - Keep

Retained(it) == it.step > step - Keep /\ it.kind # "task"

EndOfF == 4 + Len(arrivals)

Render(it) ==
    CASE it.kind = "task" -> <<"task">>
      [] it.kind = "sum" -> <<"sum", it.form>>
      [] it.kind = "resp" -> <<"resp", it.step>>
      [] it.evicted -> <<"out", it.id, "evicted">>
      [] it.dupOf # 0 -> <<"out", it.id, "ref", it.dupOf>>
      [] OTHER -> <<"out", it.id, "full", it.form>>

ToolsSlot(wrap, om, of, ld) == IF wrap THEN <<"tools", "none">> ELSE <<"tools", om, of, ld>>

ArrSlots(arr) == [i \in DOMAIN arr |-> <<"arr", i, arr[i]>>]

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

Task == [id |-> 0, kind |-> "task", step |-> 0, evicted |-> FALSE, dupOf |-> 0, form |-> 0]

Summary == [id |-> 0, kind |-> "sum", step |-> 0, evicted |-> FALSE, dupOf |-> 0, form |-> "opaque"]

Rec(e, k) == /\ since' = Min2(since, k) /\ evs' = evs \cup {e}

NoRec == UNCHANGED <<since, evs>>

NoSend == sent' = "none" /\ prefixOk' = TRUE

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
    /\ prefixOk = TRUE

MemoChoices == IF RerankMemories THEN {1, 2} ELSE {IF memo = 0 THEN 1 ELSE memo}

Send(wrap, o, om, m, h) ==
    LET r == Req(wrap, om, o, loaded, m, arrivals, gov, h)
    IN /\ lastReq' = r
       /\ prefixOk' = (CP(lastReq, r) >= Min2(Len(lastReq), Min2(since, IF wrap /\ ~IsWrapReq(lastReq) THEN 0 ELSE NoLimit)))
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
        Send(FALSE, o, IF OfferPerBuild THEN mode ELSE offerMode, m, FormsAt(hist))
    /\ sent' = "build"
    /\ UNCHANGED <<arrivals, gov, mode, loaded, pending, claim, alive, wrapping, step, nextId, cap, loads, loadBatches, offerChanges, modeChanges, compactions>>

WrapUp ==
    /\ alive /\ phase = "build"
    /\ \E m \in MemoChoices : Send(TRUE, offer, offerMode, m, FormsAt(hist))
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
                /\ hist' = Append(hist, [id |-> 0, kind |-> "resp", step |-> step + 1, evicted |-> FALSE, dupOf |-> 0, form |-> 0])
                /\ pending' = {[id |-> nextId + i, kind |-> IF i < nl THEN "load" ELSE "work"] : i \in 0..(c - 1)}
                /\ nextId' = nextId + c
                /\ step' = step + 1
    /\ recorded' = <<>>
    /\ NoRec /\ NoSend
    /\ UNCHANGED <<arrivals, gov, memo, offer, offerMode, mode, loaded, claim, lastReq, alive, wrapping, loadDirty, cap, loads, loadBatches, toolBreaks, offerChanges, modeChanges, compactions>>

DupCandidates == {it.id : it \in {x \in Range(hist) : x.kind = "work" /\ ~x.evicted /\ x.dupOf = 0}}

OldestDup == IF DupCandidates = {} THEN 0 ELSE CHOOSE d \in DupCandidates : \A e \in DupCandidates : d <= e

ToolDone ==
    /\ alive /\ phase = "tools"
    /\ \E p \in pending :
        /\ pending' = pending \ {p}
        /\ phase' = IF pending \ {p} = {} THEN "build" ELSE "tools"
        /\ IF p.kind = "load"
            THEN \E t \in Deferred :
                    /\ hist' = Append(hist, [id |-> p.id, kind |-> "load", step |-> step, evicted |-> FALSE, dupOf |-> 0, form |-> 0])
                    /\ IF t \in Range(loaded)
                        THEN /\ UNCHANGED <<loaded, loads, loadBatches, loadDirty>>
                             /\ NoRec
                        ELSE /\ loaded' = Append(loaded, t)
                             /\ loads' = loads + 1
                             /\ loadBatches' = loadBatches + (IF loadDirty THEN 0 ELSE 1)
                             /\ loadDirty' = TRUE
                             /\ Rec("tools_loaded", 0)
            ELSE \E d \in {0, OldestDup} :
                    /\ hist' = Append(hist, [id |-> p.id, kind |-> "work", step |-> step, evicted |-> FALSE, dupOf |-> d, form |-> 0])
                    /\ UNCHANGED <<loaded, loads, loadBatches, loadDirty>>
                    /\ NoRec
    /\ NoSend
    /\ UNCHANGED <<arrivals, gov, memo, offer, offerMode, mode, claim, recorded, lastReq, alive, wrapping, step, nextId, cap, toolBreaks, offerChanges, modeChanges, compactions>>

UnprotectedIdx == {i \in DOMAIN hist : Unprotected(hist[i])}

Evict ==
    /\ alive /\ phase = "build"
    /\ UnprotectedIdx # {}
    /\ \E k \in 1..Cardinality(UnprotectedIdx) :
        LET gone == {i \in UnprotectedIdx : Cardinality({j \in UnprotectedIdx : j <= i}) <= k}
            first == CHOOSE i \in gone : \A j \in gone : i <= j
            goneIds == {hist[i].id : i \in gone}
        IN /\ hist' = [i \in DOMAIN hist |->
                IF i \in gone THEN [hist[i] EXCEPT !.evicted = TRUE]
                ELSE IF IsOut(hist[i]) /\ ~hist[i].evicted /\ i > first
                    THEN [hist[i] EXCEPT !.form = cap, !.dupOf = IF hist[i].dupOf \in goneIds THEN 0 ELSE hist[i].dupOf]
                ELSE IF IsOut(hist[i]) /\ hist[i].dupOf \in goneIds
                    THEN [hist[i] EXCEPT !.dupOf = 0]
                ELSE hist[i]]
           /\ Rec("eviction", EndOfF + first - 1)
    /\ NoSend
    /\ UNCHANGED <<arrivals, gov, memo, offer, offerMode, mode, loaded, pending, claim, phase, recorded, lastReq, alive, wrapping, loadDirty, step, nextId, cap, loads, loadBatches, toolBreaks, offerChanges, modeChanges, compactions>>

Compact ==
    /\ alive /\ phase = "build" /\ ~wrapping /\ compactions < MaxCompactions
    /\ LET kept == SelectSeq(hist, Retained)
           keptIds == {it.id : it \in Range(kept)}
       IN hist' = << Task, Summary >> \o [i \in DOMAIN kept |->
            IF IsOut(kept[i])
                THEN [kept[i] EXCEPT !.form = IF kept[i].evicted THEN kept[i].form ELSE cap,
                                     !.dupOf = IF kept[i].dupOf \in keptIds THEN kept[i].dupOf ELSE 0]
                ELSE kept[i]]
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
    /\ alive /\ phase # "done" /\ Len(arrivals) < MaxArrivals
    /\ \E a \in ArrivalKinds :
        /\ arrivals' = Append(arrivals, a)
        /\ Rec(a, 3 + Len(arrivals))
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
             /\ prefixOk' = TRUE
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

PrefixStable == prefixOk

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
            \A j \in 1..(i - 1) : Unprotected(hist[j]) => hist'[j].evicted]_vars

ResendUnchanged ==
    [][sent' = "resend" => (lastReq' = lastReq /\ lastReq' = recorded)]_vars

RefShowsFullReferent ==
    /\ \A i \in DOMAIN hist : (IsOut(hist[i]) /\ ~hist[i].evicted /\ hist[i].dupOf # 0) =>
        \E j \in 1..(i - 1) : hist[j].id = hist[i].dupOf /\ IsOut(hist[j]) /\ ~hist[j].evicted /\ hist[j].dupOf = 0
    /\ \A i \in DOMAIN lastReq : (lastReq[i][1] = "out" /\ lastReq[i][3] = "ref") =>
        \E j \in 1..(i - 1) : lastReq[j][1] = "out" /\ lastReq[j][2] = lastReq[i][4] /\ lastReq[j][3] = "full"

FAppendOnly ==
    [][/\ SubSeq(arrivals', 1, Len(arrivals)) = arrivals
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
