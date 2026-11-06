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
(*   the request handler: gateway/src/managed/fm-target.ts (readRecorded) *)
(*       computes the key and reads the record on every capabilities or   *)
(*       count request; with no record it starts the probe and answers    *)
(*       503 target_probing (gateway/src/probe/auto-probe.ts,             *)
(*       targetProbingError). The model listing shows the alias probing    *)
(*       (gateway/src/server/app.ts). ReadRecord = "fresh"                 *)
(*   the key: gateway/src/process.ts (readRecordKey) per request, from     *)
(*       managed/fm-record-key.ts (the binary sha256 and the OS build).    *)
(*       KeyView = "perRequest"                                            *)
(*   the probe runner: gateway/src/probe/auto-probe.ts (createAutoProbe,   *)
(*       recordProbe): the probe lock of the key, the measurement          *)
(*       (probe-fm.ts measureManagedFm, which owns its fm serve child),    *)
(*       the key read again, and saveProbeRecord only when it is unchanged *)
(*       (TaintCheck); a failure saves nothing                             *)
(*   a second writer: the command momonga gateway probe, packages/cli/src/ *)
(*       commands/gateway.ts (probeFm), runs probeManagedFm in the CLI     *)
(*       process, which goes through the same recordProbe and the same     *)
(*       probe lock (acquireProbeLock: one kernel file lock per record key *)
(*       beside the records, held per open file, so it also excludes a     *)
(*       second holder in the same process). It is the actor Manual, and   *)
(*       SingleFlight = "shared"                                           *)
(*   the endpoint writers: packages/gateway/src/probe/probe-endpoint.ts    *)
(*       (endpointProbeSubject, the CLI probeEndpointTarget) and           *)
(*       probe/ollama.ts (ollamaProbeSubject, probeOllamaTarget) go        *)
(*       through the same recordProbe and createAutoProbe, with the lock   *)
(*       of their record (endpointLockKeyOf); their targets read the       *)
(*       record per request (endpoint-target.ts, ollama-target.ts)         *)
(*   the precondition check: one interface, ProbePrecondition (boundMs,    *)
(*       check), declared by each adapter: fmPrecondition (probe-fm.ts:    *)
(*       fm license --status and fm available, within healthTimeoutMs),    *)
(*       endpointPrecondition (the server lists the model), and            *)
(*       ollamaPrecondition (GET /api/tags lists it); a definite refusal   *)
(*       answers 412 target_not_ready with the adapter's remedy            *)
(*   the backoff: createAutoProbe keeps one Retry-After interval per key   *)
(*       after a probe that started and failed, in gateway memory          *)
(*   the gateway: one process per home by gateway.lock (foundation/src/    *)
(*       momonga-paths.ts:75); a crash loses the probes it owns            *)
(*   the key change: the fm binary replaced, or an OS update               *)
(*   a user cancel: the signal of measureManagedFm (an interrupt of the    *)
(*       CLI, or the gateway closing through createAutoProbe close)        *)
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
(*   Adapter       the adapter of the probed target: "fm", or "endpoint"   *)
(*                 (a chat-completions or ollama target with toolCalling   *)
(*                 auto, whose key is the server identity of the model)    *)
(*   EndpointLocked an endpoint probe takes the probe lock of its key, as  *)
(*                 the fm probe does                                       *)
(*   PreconditionCheck a request checks the preconditions first, and a     *)
(*                 definite refusal answers 412 with the remedy at once    *)
(*   Backoff       after a probe that started and failed, the gateway      *)
(*                 starts no probe of that key for one Retry-After interval *)
(*                                                                         *)
(* Failure kinds. A definite refusal of a precondition (the licence is not *)
(* agreed, the model is not available, the binary is missing) is the world *)
(* state refused, which the user toggles (Refuse, Fix); it is not          *)
(* remembered. A probe that started and failed is Fail; a gateway probe    *)
(* that fails puts its key in backoff until BackoffEnds (one interval). A  *)
(* stop of the gateway (Crash) ends its probes without a failure: no       *)
(* backoff, and the in-memory backoff is gone after Restart.               *)
(*                                                                         *)
(* The key source. The fm key is the binary sha256 and the OS build. The   *)
(* gateway caches it by the binary's file identity (device, inode, size,   *)
(* modification time), so a replaced binary is seen by the next request.   *)
(* The OS build is read with the cache and can change only by an OS        *)
(* update, which restarts the machine and so the gateway: OsUpdate is      *)
(* enabled only while the gateway is down. An endpoint key changes when    *)
(* the server reports another identity, at any time (BinaryChange stands   *)
(* for both).                                                              *)
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
    Manual,
    Adapter,
    EndpointLocked,
    PreconditionCheck,
    Backoff,
    MaxRefusalChanges

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
       /\ Adapter \in {"fm", "endpoint"}
       /\ EndpointLocked \in BOOLEAN
       /\ PreconditionCheck \in BOOLEAN
       /\ Backoff \in BOOLEAN
       /\ MaxRefusalChanges \in Nat

NoKey == "nokey"
Owners == {"gw", "cli"}

VARIABLES worldKey, gwKey, rec, recSrc, view, probes, started, gwUp,
          requests, changes, crashes, cancels, respLog,
          refused, refusals, backoff

vars == <<worldKey, gwKey, rec, recSrc, view, probes, started, gwUp,
          requests, changes, crashes, cancels, respLog,
          refused, refusals, backoff>>

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

Probe == [id : 1..MaxProbes, key : Keys, owner : Owners, tainted : BOOLEAN, locked : BOOLEAN]

Locks == Adapter = "fm" \/ EndpointLocked

TypeOK ==
    /\ worldKey \in Keys /\ gwKey \in Keys
    /\ rec \in Keys \cup {NoKey}
    /\ view \in Keys \cup {NoKey}
    /\ recSrc \in {"none", "ok", "failed", "tainted", "unlocked"}
    /\ probes \subseteq Probe
    /\ started \in 0..MaxProbes
    /\ gwUp \in BOOLEAN
    /\ requests \in 0..MaxRequests
    /\ changes \in 0..MaxKeyChanges
    /\ crashes \in 0..MaxCrashes
    /\ cancels \in 0..MaxCancels
    /\ refused \in BOOLEAN
    /\ refusals \in 0..MaxRefusalChanges
    /\ backoff \subseteq Keys

Init ==
    /\ \E k \in Keys : worldKey = k /\ gwKey = k
    /\ rec = NoKey /\ recSrc = "none" /\ view = NoKey
    /\ probes = {} /\ started = 0
    /\ gwUp = TRUE
    /\ requests = 0 /\ changes = 0 /\ crashes = 0 /\ cancels = 0
    /\ respLog = {}
    /\ refused = FALSE /\ refusals = 0 /\ backoff = {}

HasProbe(k) == \E p \in probes : p.key = k

Blocked(k, owner) ==
    CASE SingleFlight = "shared" -> Locks /\ \E p \in probes : p.key = k /\ p.locked
      [] SingleFlight = "gateway" -> owner = "gw" /\ \E p \in probes : p.key = k /\ p.owner = "gw"
      [] OTHER -> FALSE

NewProbe(owner) ==
    [id |-> started + 1, key |-> worldKey, owner |-> owner, tainted |-> FALSE, locked |-> Locks]

AskKey == IF KeyView = "perRequest" THEN worldKey ELSE gwKey

Seen == IF ReadRecord = "fresh" THEN rec ELSE view

Refuses == PreconditionCheck /\ refused

Waits == Backoff /\ AskKey \in backoff

StartsProbe == Seen # AskKey /\ ~Guess /\ ~Reject412 /\ ~Refuses /\ ~Waits /\ ~Blocked(AskKey, "gw") /\ started < MaxProbes

Request ==
    /\ gwUp /\ requests < MaxRequests
    /\ Seen = AskKey \/ Guess \/ Reject412 \/ Refuses \/ Waits \/ StartsProbe \/ Blocked(AskKey, "gw")
    /\ requests' = requests + 1
    /\ LET k == AskKey
           present == (rec = k)
           seen == (Seen = k)
           startIt == StartsProbe
           probesAfter == IF startIt THEN probes \cup {NewProbe("gw")} ELSE probes
           kind == IF seen \/ Guess THEN "200" ELSE IF Reject412 \/ Refuses THEN "412" ELSE "503"
           src == IF seen THEN "record" ELSE "guess"
       IN /\ probes' = probesAfter
          /\ started' = IF startIt THEN started + 1 ELSE started
          /\ respLog' = respLog \cup
               {[kind |-> kind,
                 src |-> src,
                 recordPresent |-> present,
                 recordMatchesWorld |-> (rec = worldKey),
                 refused |-> refused,
                 backoffAfter |-> (k \in backoff),
                 probingAfter |-> (\E p \in probesAfter : p.key = k)]}
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, gwUp, changes, crashes, cancels, refused, refusals, backoff>>

ManualStart ==
    /\ Manual /\ started < MaxProbes
    /\ ~Blocked(worldKey, "cli")
    /\ probes' = probes \cup {NewProbe("cli")}
    /\ started' = started + 1
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, gwUp, requests, changes, crashes, cancels, respLog, refused, refusals, backoff>>

EndProbe(p, ok) ==
    /\ p \in probes
    /\ probes' = probes \ {p}
    /\ IF ok /\ (~p.tainted \/ ~TaintCheck)
       THEN /\ rec' = p.key
            /\ recSrc' = IF p.tainted THEN "tainted" ELSE IF ~p.locked THEN "unlocked" ELSE "ok"
       ELSE IF ~ok /\ FailWrites
            THEN /\ rec' = p.key /\ recSrc' = "failed"
            ELSE UNCHANGED <<rec, recSrc>>
    /\ backoff' = IF ~ok /\ p.owner = "gw" THEN backoff \cup {p.key} ELSE backoff
    /\ UNCHANGED <<worldKey, gwKey, view, started, gwUp, requests, changes, crashes, cancels, respLog, refused, refusals>>

Succeed(p) == EndProbe(p, TRUE)
Fail(p) == EndProbe(p, FALSE)

Cancel(p) ==
    /\ p \in probes /\ cancels < MaxCancels
    /\ probes' = probes \ {p}
    /\ cancels' = cancels + 1
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, started, gwUp, requests, changes, crashes, respLog, refused, refusals, backoff>>

ChangeKey ==
    /\ changes < MaxKeyChanges
    /\ \E k \in Keys \ {worldKey} : worldKey' = k
    /\ changes' = changes + 1
    /\ probes' = {[p EXCEPT !.tainted = TRUE] : p \in probes}
    /\ UNCHANGED <<gwKey, rec, recSrc, view, started, gwUp, requests, crashes, cancels, respLog, refused, refusals, backoff>>

BinaryChange == ChangeKey

OsUpdate == Adapter = "fm" /\ ~gwUp /\ ChangeKey

KeyChange == BinaryChange \/ OsUpdate

Refuse ==
    /\ ~refused /\ refusals < MaxRefusalChanges
    /\ refused' = TRUE /\ refusals' = refusals + 1
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, probes, started, gwUp, requests, changes, crashes, cancels, respLog, backoff>>

Fix ==
    /\ refused /\ refusals < MaxRefusalChanges
    /\ refused' = FALSE /\ refusals' = refusals + 1
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, probes, started, gwUp, requests, changes, crashes, cancels, respLog, backoff>>

BackoffEnds(k) ==
    /\ k \in backoff
    /\ backoff' = backoff \ {k}
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, probes, started, gwUp, requests, changes, crashes, cancels, respLog, refused, refusals>>

Crash ==
    /\ gwUp /\ crashes < MaxCrashes
    /\ gwUp' = FALSE
    /\ crashes' = crashes + 1
    /\ probes' = {p \in probes : p.owner = "cli"}
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, started, requests, changes, cancels, respLog, refused, refusals, backoff>>

Restart ==
    /\ ~gwUp
    /\ gwUp' = TRUE
    /\ gwKey' = worldKey
    /\ view' = rec
    /\ backoff' = {}
    /\ UNCHANGED <<worldKey, rec, recSrc, probes, started, requests, changes, crashes, cancels, respLog, refused, refusals>>

Next ==
    \/ Request
    \/ ManualStart
    \/ \E p \in probes : Succeed(p) \/ Fail(p) \/ Cancel(p)
    \/ KeyChange
    \/ Refuse
    \/ Fix
    \/ \E k \in Keys : BackoffEnds(k)
    \/ Crash
    \/ Restart

Spec == Init /\ [][Next]_vars /\ WF_vars(Restart)

(* P1: at most one probe per record key at a time *)
SingleProbePerKey == \A p, q \in probes : p.key = q.key => p = q

(* P2: no response is built from a guessed capability *)
NoGuessedAnswer == \A x \in respLog : x.kind = "200" => x.src = "record"

(* P3: a request with no record gets 503, never 412 or 200, and the 503    *)
(* is true: a probe for the key it asked about is running                  *)
NoRecordGets503 == \A x \in respLog : ~x.recordPresent /\ ~x.refused => x.kind = "503"
RetryAfterIsHonest == \A x \in respLog : x.kind = "503" => x.probingAfter \/ x.backoffAfter

(* P8: a definite refusal of a precondition answers 412 with the remedy at *)
(* once, never "probing"                                                   *)
RefusalGetsRemedy == \A x \in respLog : ~x.recordPresent /\ x.refused => x.kind = "412"

(* P9: no gateway probe of a key starts inside its backoff interval        *)
NoProbeInBackoff == \A p \in probes : p.owner = "gw" => p.key \notin backoff

(* P10: every record is written by a probe that held the lock of its key  *)
RecordUnderLock == recSrc # "unlocked"

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
