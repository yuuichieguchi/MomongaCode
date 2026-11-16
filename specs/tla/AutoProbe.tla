--------------------------- MODULE AutoProbe ---------------------------
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

SingleProbePerKey == \A p, q \in probes : p.key = q.key /\ p.owner = "gw" /\ q.owner = "gw" => p = q

NoGuessedAnswer == \A x \in respLog : x.kind = "200" => x.src \in {"record", "memory"}

NoRecordGets503 == \A x \in respLog : ~x.recordPresent /\ ~x.memoryPresent /\ ~x.refused => x.kind = "503"
RetryAfterIsHonest == \A x \in respLog : x.kind = "503" => x.probingAfter \/ x.backoffAfter

RefusalGetsRemedy == \A x \in respLog : ~x.recordPresent /\ ~x.memoryPresent /\ x.refused => x.kind = "412"

NoProbeInBackoff == \A p \in probes : p.owner = "gw" => p.key \notin backoff

RecordUnderLock == recSrc # "unlocked"

RecordSeenAtOnce == \A x \in respLog : (x.recordPresent \/ x.memoryPresent) => x.kind = "200"

FailedWritesNothing == recSrc # "failed"

RecordMatchesKey ==
    \A x \in respLog :
        /\ x.kind = "200" /\ x.src # "memory" => x.recordMatchesWorld
        /\ x.src = "memory" => x.worldUnknown
        /\ ~x.staleGot412

RecordIsClean == recSrc # "tainted"

NoRecordUnderUnknown == rec # UnknownKey /\ recSrc # "unknown"

MemoryIsThisInstance == memSrc # "tainted"

=========================================================================
