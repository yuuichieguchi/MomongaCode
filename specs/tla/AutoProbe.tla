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
(*   the record: one file per target,                                      *)
(*       packages/gateway/src/probe/record.ts (managedRecordPath, saveProbeRecord, loadProbeRecord) *)
(*       written by saveProbeRecord (atomic private write), read by        *)
(*       loadProbeRecord, which answers null when the stored binarySha256  *)
(*       or osBuild differ from the key. A new key therefore overwrites the *)
(*       single slot: the model keeps one slot                             *)
(*   the request handler:                                                  *)
(*       packages/gateway/src/managed/target.ts (readRecorded, servingKey) *)
(*       computes the key and reads the record on every capabilities or    *)
(*       count request; with no record it starts the probe and answers     *)
(*       503 target_probing                                                *)
(*       (packages/gateway/src/probe/auto-probe.ts (targetProbingError)).  *)
(*       The model listing shows the alias probing                         *)
(*       (packages/gateway/src/server/capability-listing.ts (isTargetProbingError, probingOf)). *)
(*       ReadRecord = "fresh"                                              *)
(*   the key: packages/gateway/src/process.ts (readKey) per request, from  *)
(*       packages/gateway/src/probe/probe-fm.ts (managedKeyReader) (the    *)
(*       binary sha256 and the OS build). KeyView = "perRequest"           *)
(*   the probe runner:                                                     *)
(*       packages/gateway/src/probe/auto-probe.ts (createAutoProbe, recordProbe, measureAndRecord, ProbeKeyChangedError) *)
(*       the measurement without a lock                                    *)
(*       (packages/gateway/src/probe/probe-fm.ts (measureManagedServer),   *)
(*       which owns its server child), then the probe lock of the key, the *)
(*       key read again, and saveProbeRecord only when it is unchanged     *)
(*       (TaintCheck, otherwise ProbeKeyChangedError); a failure saves     *)
(*       nothing. SaveLock                                                 *)
(*   a second writer: the command momonga gateway probe,                   *)
(*       packages/cli/src/commands/gateway.ts (probeModel, probeManagedFm) *)
(*       runs probeManagedFm in the CLI process through the same           *)
(*       recordProbe: it measures beside a gateway flight of the same key  *)
(*       and takes the same probe lock (acquireProbeLock: one kernel file  *)
(*       lock per record key) only around its key check and save. It is    *)
(*       the actor Manual. The single flight is the gateway's own map      *)
(*       (createAutoProbe, starting): SingleFlight = "gateway"             *)
(*   the endpoint writers:                                                 *)
(*       packages/gateway/src/probe/probe-endpoint.ts (endpointProbeSubject, probeEndpointTarget) *)
(*       and packages/gateway/src/probe/ollama.ts (ollamaProbeSubject, probeOllamaTarget) *)
(*       go through the same recordProbe and createAutoProbe, with the     *)
(*       lock of their record                                              *)
(*       (packages/gateway/src/probe/endpoint-record.ts (endpointLockKeyOf)); *)
(*       their targets read the record per request                         *)
(*       (packages/gateway/src/probe/endpoint-target.ts (createProbedEndpointTarget, recordForIdentity), *)
(*       packages/gateway/src/probe/ollama-target.ts (createProbedOllamaTarget, recordForIdentity)) *)
(*   the precondition check: one interface,                                *)
(*       packages/gateway/src/probe/auto-probe.ts (ProbePrecondition)      *)
(*       declared by each adapter:                                         *)
(*       packages/gateway/src/probe/probe-fm.ts (managedPrecondition),     *)
(*       packages/gateway/src/probe/probe-endpoint.ts (endpointPrecondition) *)
(*       (the server lists the model), and                                 *)
(*       packages/gateway/src/probe/ollama.ts (ollamaPrecondition) (GET    *)
(*       /api/tags lists it); a definite refusal answers 412               *)
(*       target_not_ready with the adapter's remedy                        *)
(*   the backoff: createAutoProbe keeps one Retry-After interval per key   *)
(*       after a probe that started and failed, in gateway memory          *)
(*   the gateway: one process per home by its generation lock              *)
(*       (packages/foundation/src/momonga-paths.ts (GenerationProcessRole, locks)); *)
(*       a crash loses the probes it owns                                  *)
(*   the key change: the binary replaced, or an OS update                  *)
(*   a user cancel: the signal of measureManagedServer (an interrupt of the *)
(*       CLI, or the gateway closing through createAutoProbe close)        *)
(*   the gateway close: packages/gateway/src/process.ts (createAutoProbe)  *)
(*       runs the close of the auto probe and the stop of the probe's      *)
(*       servers alongside the gateway close, and the signal also ends a   *)
(*       start of the probe's server that waits on health                  *)
(*       (packages/gateway/src/managed/server.ts (createManagedServer, waitUntilReady)). *)
(*       Both are the cancel above at any time, which the model already    *)
(*       allows, so the model does not change                              *)
(*                                                                         *)
(* Abstractions: the steps inside a probe (it ends in success or failure   *)
(* at any time, which stands for the per-step limits and the overall limit *)
(* of packages/gateway/src/probe/run-probe.ts (runProbe)); the backoff     *)
(* after a failure (a delay before the next                                *)
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
(*                 "gateway": the gateway checks its own probes, the CLI   *)
(*                 does not (an in-process map). "none": nobody checks     *)
(*   KeyView       the key a request asks for. "perRequest": the key now.  *)
(*                 "atStart": the key read when the gateway started        *)
(*   ReadRecord    "fresh": a request reads the record. "cached": it reads *)
(*                 the copy taken when the gateway started                 *)
(*   Guess         a request with no record is answered 200 from a guess   *)
(*   Reject412     a request with no record is answered 412, no probe      *)
(*   FailWrites    a failed probe writes its record                        *)
(*   TaintCheck    a probe during which the key changed writes no record   *)
(*   Manual        the CLI command exists as an actor                      *)
(*   HostKeyed     the key includes the host identity (binary sha256 and    *)
(*                 OS build): an OS update changes the key. FALSE is an     *)
(*                 endpoint key (the settings' endpoint and model, with     *)
(*                 the record matched to the identity the server reports)   *)
(*   SaveLock      every probe takes the probe lock of its key around its   *)
(*                 key check and save, never over the measurement; one     *)
(*                 rule for every key kind                                  *)
(*   PreconditionCheck a request checks the preconditions first, and a     *)
(*                 definite refusal answers 412 with the remedy at once    *)
(*   RejectStale   a request whose record was measured under another key   *)
(*                 (another fm binary or OS build, another server identity *)
(*                 or digest) is answered 412, no probe                    *)
(*   Backoff       after a probe that started and failed, the gateway      *)
(*                 starts no probe of that key for one Retry-After interval *)
(*                 and answers 503 target_probe_failed in it               *)
(*   Unreadable    a key component may be unreadable (the binary missing,  *)
(*                 the OS build reader failing, a platform with no reader) *)
(*   UnknownWrites a result measured under an unknown key is written to    *)
(*                 the record store                                        *)
(*                                                                         *)
(* An unknown key (design-managed-servers-2026-11-09.md, section 17 item   *)
(* 10, which replaces section 6.3). A key with a component that cannot be  *)
(* read is UnknownKey. The one rule: a probe result is read from or        *)
(* written to the record store only under a key whose every component was  *)
(* read. Under UnknownKey a request reads no record; the gateway measures  *)
(* the running server instance by the same automatic probe (503 with       *)
(* Retry-After while it runs), keeps the result in memory for that         *)
(* instance only (mem), and measures again when the instance starts again  *)
(* (InstanceRestart, and the gateway's own Crash and Restart). The flight  *)
(* under UnknownKey is the gateway's in-memory flight: no lock file names  *)
(* an unknown key, and the CLI keeps nothing from such a measurement. A    *)
(* probe that spans a key change or an instance start keeps nothing.      *)
(*                                                                         *)
(* Why AutoProbe.endpoint sets Unreadable FALSE (section 17 item 14). The  *)
(* key of this model (Keys, worldKey) is what a current record must match. *)
(* For a managed server it is the record key itself, the binary's sha256   *)
(* and the OS build; both are read from the host, and either read can fail *)
(* (Unreadable). For an endpoint, the record key of section 6.1 is the     *)
(* settings' endpoint and model                                            *)
(* (packages/config/src/probe-record-key.ts (EndpointProbeKey, endpointKeyOf)). *)
(* Nothing in it is read from the host, so it is never unknown,            *)
(* and the unknown-key path of item 10 cannot arise for an endpoint        *)
(* target. The model's key of an endpoint stands for the identity the      *)
(* server reports, which a record must match                               *)
(* (packages/gateway/src/probe/record.ts (recordForIdentity); "The key     *)
(* source" below). A failed                                                *)
(* read of that identity, like any failed request to the endpoint, is the  *)
(* existing transient error described below, not an unknown key.           *)
(*                                                                         *)
(* Flights per key, instances elsewhere (section 17 items 3 and 12). The   *)
(* probes of this model are flights per record key, with the record lock  *)
(* of each key (SingleProbePerKey). A probe instance is an owner and a     *)
(* target, and a flight under a newer key waits for the running flight of  *)
(* its instance before it starts its server; that wait is ManagedServer.tla *)
(* (InstanceWait, OneLiveChild). Here it only delays the flight's end,     *)
(* which EndProbe, at any time, already covers.                            *)
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
(* the server reports another identity (chat-completions: the identity of  *)
(* the listed model; ollama: the model digest), at any time (BinaryChange  *)
(* stands for an identity change of every adapter). A record of another    *)
(* key is no record: the request takes the probe path, never a 412 for the *)
(* mismatch (packages/gateway/src/probe/record.ts (recordForIdentity)).    *)
(*                                                                         *)
(* An identity read that failed (a labelled outbound error) is not an      *)
(* action of the model. The request fails with that transient error; the  *)
(* code sets the current identity to unknown before each read, so the      *)
(* failure writes no record, starts no probe and leaves no key behind      *)
(* (packages/gateway/test/identity-read-failure.test.ts (createProbedEndpointTarget, createProbedOllamaTarget)). *)
(* The step changes                                                        *)
(* only an answer that is neither 200 nor 412, which RecordMatchesKey does *)
(* not constrain. A key kept from an earlier read is KeyView "atStart",    *)
(* whose evidence AutoProbe.keyAtStart already violates RecordMatchesKey.  *)
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
    HostKeyed,
    SaveLock,
    PreconditionCheck,
    RejectStale,
    Backoff,
    MaxRefusalChanges,
    Unreadable,
    UnknownWrites

ASSUME /\ Cardinality(Keys) >= 2
       /\ MaxProbes \in Nat \ {0}
       /\ MaxRequests \in Nat \ {0}
       /\ MaxKeyChanges \in Nat
       /\ MaxCrashes \in Nat
       /\ MaxCancels \in Nat
       /\ SingleFlight \in {"gateway", "none"}
       /\ KeyView \in {"perRequest", "atStart"}
       /\ ReadRecord \in {"fresh", "cached"}
       /\ Guess \in BOOLEAN
       /\ Reject412 \in BOOLEAN
       /\ FailWrites \in BOOLEAN
       /\ TaintCheck \in BOOLEAN
       /\ Manual \in BOOLEAN
       /\ HostKeyed \in BOOLEAN
       /\ SaveLock \in BOOLEAN
       /\ PreconditionCheck \in BOOLEAN
       /\ RejectStale \in BOOLEAN
       /\ Backoff \in BOOLEAN
       /\ MaxRefusalChanges \in Nat
       /\ Unreadable \in BOOLEAN
       /\ UnknownWrites \in BOOLEAN

NoKey == "nokey"
UnknownKey == "unknown"
KeySpace == IF Unreadable THEN Keys \cup {UnknownKey} ELSE Keys
Owners == {"gw", "cli"}

VARIABLES worldKey, gwKey, rec, recSrc, view, probes, started, gwUp,
          requests, changes, crashes, cancels, respLog,
          refused, refusals, backoff, mem, memSrc

vars == <<worldKey, gwKey, rec, recSrc, view, probes, started, gwUp,
          requests, changes, crashes, cancels, respLog,
          refused, refusals, backoff, mem, memSrc>>

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
(* mem        the result kept in gateway memory for the running instance  *)
(*            under an unknown key                                        *)
(* memSrc     how mem came about: "none", "ok", "tainted"                 *)

Probe == [id : 1..MaxProbes, key : KeySpace, owner : Owners, tainted : BOOLEAN, locked : BOOLEAN]

Locks == SaveLock

TypeOK ==
    /\ worldKey \in KeySpace /\ gwKey \in KeySpace
    /\ rec \in KeySpace \cup {NoKey}
    /\ view \in KeySpace \cup {NoKey}
    /\ recSrc \in {"none", "ok", "failed", "tainted", "unlocked", "unknown"}
    /\ probes \subseteq Probe
    /\ started \in 0..MaxProbes
    /\ gwUp \in BOOLEAN
    /\ requests \in 0..MaxRequests
    /\ changes \in 0..MaxKeyChanges
    /\ crashes \in 0..MaxCrashes
    /\ cancels \in 0..MaxCancels
    /\ refused \in BOOLEAN
    /\ refusals \in 0..MaxRefusalChanges
    /\ backoff \subseteq KeySpace
    /\ mem \in BOOLEAN
    /\ memSrc \in {"none", "ok", "tainted"}

Init ==
    /\ \E k \in Keys : worldKey = k /\ gwKey = k
    /\ rec = NoKey /\ recSrc = "none" /\ view = NoKey
    /\ probes = {} /\ started = 0
    /\ gwUp = TRUE
    /\ requests = 0 /\ changes = 0 /\ crashes = 0 /\ cancels = 0
    /\ respLog = {}
    /\ refused = FALSE /\ refusals = 0 /\ backoff = {}
    /\ mem = FALSE /\ memSrc = "none"

HasProbe(k) == \E p \in probes : p.key = k

GatewayFlight(k, owner) == owner = "gw" /\ \E p \in probes : p.key = k /\ p.owner = "gw"

Blocked(k, owner) == SingleFlight # "none" /\ GatewayFlight(k, owner)

NewProbe(owner) ==
    [id |-> started + 1, key |-> worldKey, owner |-> owner, tainted |-> FALSE, locked |-> Locks /\ worldKey # UnknownKey]

AskKey == IF KeyView = "perRequest" THEN worldKey ELSE gwKey

Seen == IF ReadRecord = "fresh" THEN rec ELSE view

Unknown == AskKey = UnknownKey

Hit == IF Unknown THEN mem ELSE Seen = AskKey

Refuses == PreconditionCheck /\ refused

Waits == Backoff /\ AskKey \in backoff

StaleRejected == RejectStale /\ ~Unknown /\ rec # NoKey /\ Seen # AskKey /\ rec # AskKey

StartsProbe == ~Hit /\ ~Guess /\ ~Reject412 /\ ~StaleRejected /\ ~Refuses /\ ~Waits /\ ~Blocked(AskKey, "gw") /\ started < MaxProbes

Request ==
    /\ gwUp /\ requests < MaxRequests
    /\ Hit \/ Guess \/ Reject412 \/ StaleRejected \/ Refuses \/ Waits \/ StartsProbe \/ Blocked(AskKey, "gw")
    /\ requests' = requests + 1
    /\ LET k == AskKey
           present == ~Unknown /\ rec = k
           startIt == StartsProbe
           probesAfter == IF startIt THEN probes \cup {NewProbe("gw")} ELSE probes
           kind == IF Hit \/ Guess THEN "200" ELSE IF Reject412 \/ StaleRejected \/ Refuses THEN "412" ELSE "503"
           src == IF Hit THEN (IF Unknown THEN "memory" ELSE "record") ELSE "guess"
       IN /\ probes' = probesAfter
          /\ started' = IF startIt THEN started + 1 ELSE started
          /\ respLog' = respLog \cup
               {[kind |-> kind,
                 code |-> IF kind # "503" THEN "none" ELSE IF Waits THEN "target_probe_failed" ELSE "target_probing",
                 src |-> src,
                 recordPresent |-> present,
                 memoryPresent |-> Unknown /\ mem,
                 worldUnknown |-> worldKey = UnknownKey,
                 recordMatchesWorld |-> (rec = worldKey),
                 staleGot412 |-> (kind = "412" /\ ~refused /\ rec # NoKey /\ rec # k),
                 refused |-> refused,
                 backoffAfter |-> (k \in backoff),
                 probingAfter |-> (\E p \in probesAfter : p.key = k)]}
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, gwUp, changes, crashes, cancels, refused, refusals, backoff, mem, memSrc>>

ManualStart ==
    /\ Manual /\ started < MaxProbes
    /\ ~Blocked(worldKey, "cli")
    /\ probes' = probes \cup {NewProbe("cli")}
    /\ started' = started + 1
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, gwUp, requests, changes, crashes, cancels, respLog, refused, refusals, backoff, mem, memSrc>>

Keeps(p, ok) == ok /\ (~p.tainted \/ ~TaintCheck)

EndProbe(p, ok) ==
    /\ p \in probes
    /\ probes' = probes \ {p}
    /\ IF p.key = UnknownKey
       THEN /\ IF Keeps(p, ok) /\ UnknownWrites
               THEN /\ rec' = p.key /\ recSrc' = "unknown"
               ELSE UNCHANGED <<rec, recSrc>>
            /\ IF Keeps(p, ok) /\ p.owner = "gw"
               THEN /\ mem' = TRUE /\ memSrc' = IF p.tainted THEN "tainted" ELSE "ok"
               ELSE UNCHANGED <<mem, memSrc>>
       ELSE /\ IF Keeps(p, ok)
               THEN /\ rec' = p.key
                    /\ recSrc' = IF p.tainted THEN "tainted" ELSE IF ~p.locked THEN "unlocked" ELSE "ok"
               ELSE IF ~ok /\ FailWrites
                    THEN /\ rec' = p.key /\ recSrc' = "failed"
                    ELSE UNCHANGED <<rec, recSrc>>
            /\ UNCHANGED <<mem, memSrc>>
    /\ backoff' = IF ~ok /\ p.owner = "gw" THEN backoff \cup {p.key} ELSE backoff
    /\ UNCHANGED <<worldKey, gwKey, view, started, gwUp, requests, changes, crashes, cancels, respLog, refused, refusals>>

Succeed(p) == EndProbe(p, TRUE)
Fail(p) == EndProbe(p, FALSE)

Cancel(p) ==
    /\ p \in probes /\ cancels < MaxCancels
    /\ probes' = probes \ {p}
    /\ cancels' = cancels + 1
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, started, gwUp, requests, changes, crashes, respLog, refused, refusals, backoff, mem, memSrc>>

ChangeKey ==
    /\ changes < MaxKeyChanges
    /\ \E k \in KeySpace \ {worldKey} : worldKey' = k
    /\ changes' = changes + 1
    /\ probes' = {[p EXCEPT !.tainted = TRUE] : p \in probes}
    /\ UNCHANGED <<gwKey, rec, recSrc, view, started, gwUp, requests, crashes, cancels, respLog, refused, refusals, backoff, mem, memSrc>>

BinaryChange == ChangeKey

OsUpdate == HostKeyed /\ ~gwUp /\ ChangeKey

KeyChange == BinaryChange \/ OsUpdate

UnknownFlight(p) == p.key = UnknownKey /\ p.owner = "gw"

InstanceRestart ==
    /\ Unreadable /\ gwUp
    /\ (mem \/ \E p \in probes : UnknownFlight(p) /\ ~p.tainted)
    /\ mem' = FALSE /\ memSrc' = "none"
    /\ probes' = {IF UnknownFlight(p) THEN [p EXCEPT !.tainted = TRUE] ELSE p : p \in probes}
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, started, gwUp, requests, changes, crashes, cancels, respLog, refused, refusals, backoff>>

Refuse ==
    /\ ~refused /\ refusals < MaxRefusalChanges
    /\ refused' = TRUE /\ refusals' = refusals + 1
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, probes, started, gwUp, requests, changes, crashes, cancels, respLog, backoff, mem, memSrc>>

Fix ==
    /\ refused /\ refusals < MaxRefusalChanges
    /\ refused' = FALSE /\ refusals' = refusals + 1
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, probes, started, gwUp, requests, changes, crashes, cancels, respLog, backoff, mem, memSrc>>

BackoffEnds(k) ==
    /\ k \in backoff
    /\ backoff' = backoff \ {k}
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, probes, started, gwUp, requests, changes, crashes, cancels, respLog, refused, refusals, mem, memSrc>>

Crash ==
    /\ gwUp /\ crashes < MaxCrashes
    /\ gwUp' = FALSE
    /\ crashes' = crashes + 1
    /\ probes' = {p \in probes : p.owner = "cli"}
    /\ mem' = FALSE /\ memSrc' = "none"
    /\ UNCHANGED <<worldKey, gwKey, rec, recSrc, view, started, requests, changes, cancels, respLog, refused, refusals, backoff>>

Restart ==
    /\ ~gwUp
    /\ gwUp' = TRUE
    /\ gwKey' = worldKey
    /\ view' = rec
    /\ backoff' = {}
    /\ UNCHANGED <<worldKey, rec, recSrc, probes, started, requests, changes, crashes, cancels, respLog, refused, refusals, mem, memSrc>>

Next ==
    \/ Request
    \/ ManualStart
    \/ \E p \in probes : Succeed(p) \/ Fail(p) \/ Cancel(p)
    \/ KeyChange
    \/ Refuse
    \/ Fix
    \/ \E k \in KeySpace : BackoffEnds(k)
    \/ InstanceRestart
    \/ Crash
    \/ Restart

Spec == Init /\ [][Next]_vars /\ WF_vars(Restart)

(* P1: at most one gateway flight per record key at a time (the gateway's map); a CLI probe may measure beside it *)
SingleProbePerKey == \A p, q \in probes : p.key = q.key /\ p.owner = "gw" /\ q.owner = "gw" => p = q

(* P2: no response is built from a guessed capability *)
NoGuessedAnswer == \A x \in respLog : x.kind = "200" => x.src \in {"record", "memory"}

(* P3: a request with no record gets 503, never 412 or 200, and the 503    *)
(* is true: a probe for the key it asked about is running                  *)
NoRecordGets503 == \A x \in respLog : ~x.recordPresent /\ ~x.memoryPresent /\ ~x.refused => x.kind = "503"
RetryAfterIsHonest == \A x \in respLog : x.kind = "503" => x.probingAfter \/ x.backoffAfter

(* P8: a definite refusal of a precondition answers 412 with the remedy at *)
(* once, never "probing"                                                   *)
RefusalGetsRemedy == \A x \in respLog : ~x.recordPresent /\ ~x.memoryPresent /\ x.refused => x.kind = "412"

(* P9: no gateway probe of a key starts inside its backoff interval        *)
NoProbeInBackoff == \A p \in probes : p.owner = "gw" => p.key \notin backoff

(* P10: every record is written by a probe that held the lock of its key  *)
RecordUnderLock == recSrc # "unlocked"

(* P4: after the record is written, or the result kept in memory under an *)
(* unknown key, the next request sees it                                   *)
RecordSeenAtOnce == \A x \in respLog : (x.recordPresent \/ x.memoryPresent) => x.kind = "200"

(* P5: a failed probe never writes a record *)
FailedWritesNothing == recSrc # "failed"

(* P6: a record answers only for the key it was measured under, so a new   *)
(* key is never served from an old measurement, and a changed key starts  *)
(* a new probe: a record of another key never answers 412 for itself      *)
RecordMatchesKey ==
    \A x \in respLog :
        /\ x.kind = "200" /\ x.src # "memory" => x.recordMatchesWorld
        /\ x.src = "memory" => x.worldUnknown
        /\ ~x.staleGot412

(* P7: a measurement that spanned a key change is not recorded *)
RecordIsClean == recSrc # "tainted"

(* P11: no record is written under an unknown key (section 17 item 10) *)
NoRecordUnderUnknown == rec # UnknownKey /\ recSrc # "unknown"

(* P12: a result kept in memory was measured on the running instance under *)
(* the key it answers for: a probe that spanned a key change or an instance *)
(* start keeps nothing                                                      *)
MemoryIsThisInstance == memSrc # "tainted"

=========================================================================
