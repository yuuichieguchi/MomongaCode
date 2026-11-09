--------------------------- MODULE AutoProbe ---------------------------
(***************************************************************************)
(* Model of the automatic probe of design-recorded-answers-2026-11-07.md,  *)
(* item Q18. A request for a toolCalling "auto" target that has no probe   *)
(* record starts one probe for the record key (single flight) and gets     *)
(* 503 target_probing with Retry-After. When the record is written, the    *)
(* next request sees it. A failed probe writes no record. A new key (a new *)
(* binary hash or OS build) starts a new probe. No capability is guessed.  *)
(*                                                                         *)
(* Code sources (the readers and writers of the modelled state)            *)
(*   the record: one file per target, packages/gateway/src/probe/record.ts *)
(*       :20 (recordPath), written by saveProbeRecord :58 (atomic private  *)
(*       write), read by loadProbeRecord :72, which answers null when the  *)
(*       stored binarySha256 or osBuild differ from the key. A new key     *)
(*       therefore overwrites the single slot: the model keeps one slot    *)
(*   the request handler: gateway/src/core/router.ts:200-204 (the readiness *)
(*       judge of a request with tools) and managed/fm-target.ts:199-223,  *)
(*       whose record is read once, when the target is created, by         *)
(*       loadProbeRecord (:205). The record is therefore a cache that only *)
(*       a gateway restart refreshes (ReadRecord = "cached")               *)
(*   the key: computed once at gateway start, gateway/src/process.ts:223-  *)
(*       233 (FmContext.binarySha256, osBuild, from managed/fm-record-     *)
(*       key.ts). The probe computes its own key when it starts,           *)
(*       gateway/src/probe/probe-fm.ts:35-39. The two can differ when the  *)
(*       binary or the OS changes while the gateway runs (KeyView =        *)
(*       "atStart")                                                        *)
(*   the probe runner: gateway/src/probe/probe-fm.ts:30-72 (probeManaged-  *)
(*       Fm: runProbe, then saveProbeRecord), run-probe.ts:143. It owns    *)
(*       the fm serve child (the finally at probe-fm.ts:72), which dies    *)
(*       with the gateway                                                  *)
(*   a second writer: the command momonga gateway probe, packages/cli/src/ *)
(*       commands/gateway.ts:100-125, runs probeManagedFm in the CLI       *)
(*       process, outside the gateway. It takes no lock (grep lock in that *)
(*       file: none). It is the actor Manual                               *)
(*   the gateway: one process per home by gateway.lock (foundation/src/    *)
(*       momonga-paths.ts:75); a crash loses the probes it owns            *)
(*   the key change: the fm binary replaced, or an OS update               *)
(*   a user cancel: a signal on the probe (probe-fm.ts:46 takes a signal)  *)
(*                                                                         *)
(* Abstractions: the steps inside a probe (it ends in success or failure   *)
(* at any time, which stands for the per-step limits and the overall limit *)
(* of run-probe.ts); the backoff after a failure (a delay before the next  *)
(* request may start a probe; a delay cannot break a safety property, and  *)
(* the response during it is not decided by the rule); the Retry-After     *)
(* value; the content of the record beyond its key and where it came from; *)
(* the requests' own content (only requests that need the capability are   *)
(* modelled); targets other than the one auto target (one record, one      *)
(* target); two gateways racing (gateway.lock makes it one); the crash of  *)
(* the CLI process, which is a cancel.                                     *)
(*                                                                         *)
(* Switches. The configuration AutoProbe is the design the model holds.    *)
(*   SingleFlight  who may start a probe while a probe for the key runs.   *)
(*                 "shared": nobody, the guard is visible to the gateway   *)
(*                 and to the CLI (a lock in the file system). "gateway":  *)
(*                 the gateway checks its own probes, the CLI does not     *)
(*                 (an in-process map). "none": nobody checks              *)
(*   KeyView       the key a request asks for. "perRequest": the key now.  *)
(*                 "atStart": the key read when the gateway started        *)
(*   ReadRecord    "fresh": a request reads the record. "cached": it reads *)
(*                 the copy taken when the gateway started                 *)
(*   Guess         a request with no record is answered 200 from a guess   *)
(*   Reject412     a request with no record is answered 412, no probe      *)
(*   FailWrites    a failed probe writes its record                        *)
(*   TaintCheck    a probe during which the key changed writes no record   *)
(*   Manual        the CLI command exists as an actor                      *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Keys,
    MaxProbes,
    MaxRequests,
    MaxKeyChanges,
    MaxCrashes,
    MaxCancels,
    SingleFlight,
    KeyView,
    ReadRecord,
    Guess,
    Reject412,
    FailWrites,
    TaintCheck,
    Manual

ASSUME /\ Cardinality(Keys) >= 2
       /\ MaxProbes \in Nat \ {0}
       /\ MaxRequests \in Nat \ {0}
       /\ MaxKeyChanges \in Nat
       /\ MaxCrashes \in Nat
       /\ MaxCancels \in Nat
       /\ SingleFlight \in {"shared", "gateway", "none"}
       /\ KeyView \in {"perRequest", "atStart"}
       /\ ReadRecord \in {"fresh", "cached"}
       /\ Guess \in BOOLEAN
       /\ Reject412 \in BOOLEAN
       /\ FailWrites \in BOOLEAN
       /\ TaintCheck \in BOOLEAN
       /\ Manual \in BOOLEAN

NoKey == "nokey"
Owners == {"gw", "cli"}

VARIABLES worldKey, gwKey, rec, recSrc, view, probes, started, gwUp,
          requests, changes, crashes, cancels, respLog

vars == <<worldKey, gwKey, rec, recSrc, view, probes, started, gwUp,
          requests, changes, crashes, cancels, respLog>>

(* worldKey   the binary hash and OS build as they are now                *)
(* gwKey      the key the gateway read when it started                    *)
(* rec        the key stored in the record file, NoKey when there is none *)
(* recSrc     how the stored record came about: "none", "ok" (a probe     *)
(*            that succeeded with the key unchanged), "failed", "tainted" *)
(* view       the key of the record the gateway read when it started      *)
(* probes     the running probes: id, key it measures, owner, tainted    *)
(*            (the key changed while it ran)                              *)
(* started    how many probes have started (the ids)                      *)
(* respLog    one record per answered request                             *)

Probe == [id : 1..MaxProbes, key : Keys, owner : Owners, tainted : BOOLEAN]

TypeOK ==
    /\ worldKey \in Keys /\ gwKey \in Keys
    /\ rec \in Keys \cup {NoKey}
    /\ view \in Keys \cup {NoKey}
    /\ recSrc \in {"none", "ok", "failed", "tainted"}
    /\ probes \subseteq Probe
    /\ started \in 0..MaxProbes
    /\ gwUp \in BOOLEAN
    /\ requests \in 0..MaxRequests
    /\ changes \in 0..MaxKeyChanges
    /\ crashes \in 0..MaxCrashes
    /\ cancels \in 0..MaxCancels

Init ==
    /\ \E k \in Keys : worldKey = k /\ gwKey = k
    /\ rec = NoKey /\ recSrc = "none" /\ view = NoKey
    /\ probes = {} /\ started = 0
    /\ gwUp = TRUE
    /\ requests = 0 /\ changes = 0 /\ crashes = 0 /\ cancels = 0
    /\ respLog = {}

HasProbe(k) == \E p \in probes : p.key = k

Blocked(k, owner) ==
    CASE SingleFlight = "shared" -> HasProbe(k)
      [] SingleFlight = "gateway" -> owner = "gw" /\ \E p \in probes : p.key = k /\ p.owner = "gw"
      [] OTHER -> FALSE

NewProbe(owner) ==
    [id |-> started + 1, key |-> worldKey, owner |-> owner, tainted |-> FALSE]

AskKey == IF KeyView = "perRequest" THEN worldKey ELSE gwKey

Seen == IF ReadRecord = "fresh" THEN rec ELSE view

StartsProbe == Seen # AskKey /\ ~Guess /\ ~Reject412 /\ ~Blocked(AskKey, "gw") /\ started < MaxProbes

Request ==
    /\ gwUp /\ requests < MaxRequests
    /\ Seen = AskKey \/ Guess \/ Reject412 \/ StartsProbe \/ Blocked(AskKey, "gw")
    /\ requests' = requests + 1
    /\ LET k == AskKey
           present == (rec = k)
           seen == (Seen = k)
           startIt == StartsProbe
           probesAfter == IF startIt THEN probes \cup {NewProbe("gw")} ELSE probes
           kind == IF seen \/ Guess THEN "200" ELSE IF Reject412 THEN "412" ELSE "503"
           src == IF seen THEN "record" ELSE "guess"
       IN /\ probes' = probesAfter
          /\ started' = IF startIt THEN started + 1 ELSE started
          /\ respLog' = respLog \cup
               {[kind |-> kind,
                 src |-> src,
                 recordPresent |-> present,
                 recordMatchesWorld |-> (rec = worldKey),
                 probingAfter |-> (\E p \in probesAfter : p.key = k)]}
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, gwUp, changes, crashes, cancels>>

ManualStart ==
    /\ Manual /\ started < MaxProbes
    /\ ~Blocked(worldKey, "cli")
    /\ probes' = probes \cup {NewProbe("cli")}
    /\ started' = started + 1
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, gwUp, requests, changes, crashes, cancels, respLog>>

EndProbe(p, ok) ==
    /\ p \in probes
    /\ probes' = probes \ {p}
    /\ IF ok /\ (~p.tainted \/ ~TaintCheck)
       THEN /\ rec' = p.key
            /\ recSrc' = IF p.tainted THEN "tainted" ELSE "ok"
       ELSE IF ~ok /\ FailWrites
            THEN /\ rec' = p.key /\ recSrc' = "failed"
            ELSE UNCHANGED <<rec, recSrc>>
    /\ UNCHANGED <<worldKey, gwKey, view, started, gwUp, requests, changes, crashes, cancels, respLog>>

Succeed(p) == EndProbe(p, TRUE)
Fail(p) == EndProbe(p, FALSE)

Cancel(p) ==
    /\ p \in probes /\ cancels < MaxCancels
    /\ probes' = probes \ {p}
    /\ cancels' = cancels + 1
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, started, gwUp, requests, changes, crashes, respLog>>

KeyChange ==
    /\ changes < MaxKeyChanges
    /\ \E k \in Keys \ {worldKey} : worldKey' = k
    /\ changes' = changes + 1
    /\ probes' = {[p EXCEPT !.tainted = TRUE] : p \in probes}
    /\ UNCHANGED <<gwKey, rec, recSrc, view, started, gwUp, requests, crashes, cancels, respLog>>

Crash ==
    /\ gwUp /\ crashes < MaxCrashes
    /\ gwUp' = FALSE
    /\ crashes' = crashes + 1
    /\ probes' = {p \in probes : p.owner = "cli"}
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, started, requests, changes, cancels, respLog>>

Restart ==
    /\ ~gwUp
    /\ gwUp' = TRUE
    /\ gwKey' = worldKey
    /\ view' = rec
    /\ UNCHANGED <<worldKey, rec, recSrc, probes, started, requests, changes, crashes, cancels, respLog>>

Next ==
    \/ Request
    \/ ManualStart
    \/ \E p \in probes : Succeed(p) \/ Fail(p) \/ Cancel(p)
    \/ KeyChange
    \/ Crash
    \/ Restart

Spec == Init /\ [][Next]_vars /\ WF_vars(Restart)

(* P1: at most one probe per record key at a time *)
SingleProbePerKey == \A p, q \in probes : p.key = q.key => p = q

(* P2: no response is built from a guessed capability *)
NoGuessedAnswer == \A x \in respLog : x.kind = "200" => x.src = "record"

(* P3: a request with no record gets 503, never 412 or 200, and the 503    *)
(* is true: a probe for the key it asked about is running                  *)
NoRecordGets503 == \A x \in respLog : ~x.recordPresent => x.kind = "503"
RetryAfterIsHonest == \A x \in respLog : x.kind = "503" => x.probingAfter

(* P4: after the record is written, the next request sees it *)
RecordSeenAtOnce == \A x \in respLog : x.recordPresent => x.kind = "200"

(* P5: a failed probe never writes a record *)
FailedWritesNothing == recSrc # "failed"

(* P6: a record answers only for the key it was measured under, so a new   *)
(* key is never served from an old measurement                             *)
RecordMatchesKey == \A x \in respLog : x.kind = "200" => x.recordMatchesWorld

(* P7: a measurement that spanned a key change is not recorded *)
RecordIsClean == recSrc # "tainted"

=========================================================================
