---------------------------- MODULE CredentialKey ----------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Writers, MaxNames, MaxCrash, Attempts, Toggles, CanRemove, OsStore, Variant

ASSUME Variant \in {"decided", "noLock", "recordBeforeKey", "markerBeforeKey", "recreateOnReadFailure", "plaintextFallback"}
ASSUME MaxNames \in Nat \ {0}
ASSUME MaxCrash \in Nat
ASSUME Attempts \in Nat \ {0}
ASSUME Toggles \in Nat
ASSUME CanRemove \in BOOLEAN
ASSUME OsStore \in BOOLEAN

KeyPrefix == "credential-key-"
MarkerFile == "credential-key.json"
LockName == "credential-key.lock"
CreationSteps == <<"read_marker_again", "write_os_item", "write_marker">>

Names == 1..MaxNames

VARIABLES marker, items, ever, records, lock, nextName, pc, ix, base, gen, key, todo, crashes, optIn, toggled, removed

vars == <<marker, items, ever, records, lock, nextName, pc, ix, base, gen, key, todo, crashes, optIn, toggled, removed>>

Order ==
    CASE Variant = "markerBeforeKey" -> <<"marker", "os", "unlock">>
      [] Variant = "recordBeforeKey" -> <<"rec0", "os", "marker", "unlock">>
      [] OTHER -> <<"os", "marker", "unlock">>

Init ==
    /\ marker = 0
    /\ items = {}
    /\ ever = {}
    /\ records = {}
    /\ lock = 0
    /\ nextName = 0
    /\ pc = [p \in Writers |-> "idle"]
    /\ ix = [p \in Writers |-> 1]
    /\ base = [p \in Writers |-> 0]
    /\ gen = [p \in Writers |-> 0]
    /\ key = [p \in Writers |-> 0]
    /\ todo = [p \in Writers |-> Attempts]
    /\ crashes = 0
    /\ optIn = FALSE
    /\ toggled = 0
    /\ removed = FALSE

Start(p) ==
    /\ pc[p] = "idle"
    /\ todo[p] > 0
    /\ todo' = [todo EXCEPT ![p] = @ - 1]
    /\ pc' = [pc EXCEPT ![p] = "fast"]
    /\ UNCHANGED <<marker, items, ever, records, lock, nextName, ix, base, gen, key, crashes, optIn, toggled, removed>>

ReadKeyOf(p, m) ==
    IF m \in items
    THEN /\ key' = [key EXCEPT ![p] = m]
         /\ pc' = [pc EXCEPT ![p] = "rec"]
    ELSE /\ pc' = [pc EXCEPT ![p] = "done"]
         /\ UNCHANGED key

Fast(p) ==
    /\ pc[p] = "fast"
    /\ IF optIn
       THEN /\ pc' = [pc EXCEPT ![p] = "rec"]
            /\ UNCHANGED <<base, key>>
       ELSE IF ~OsStore
            THEN IF Variant = "plaintextFallback"
                 THEN /\ pc' = [pc EXCEPT ![p] = "rec"]
                      /\ UNCHANGED <<base, key>>
                 ELSE /\ pc' = [pc EXCEPT ![p] = "done"]
                      /\ UNCHANGED <<base, key>>
            ELSE IF marker /= 0
                 THEN IF Variant = "recreateOnReadFailure" /\ marker \notin items
                      THEN /\ base' = [base EXCEPT ![p] = marker]
                           /\ pc' = [pc EXCEPT ![p] = "gen"]
                           /\ UNCHANGED key
                      ELSE /\ ReadKeyOf(p, marker)
                           /\ UNCHANGED base
                 ELSE IF Variant = "noLock"
                      THEN /\ base' = [base EXCEPT ![p] = 0]
                           /\ pc' = [pc EXCEPT ![p] = "gen"]
                           /\ UNCHANGED key
                      ELSE /\ pc' = [pc EXCEPT ![p] = "locking"]
                           /\ UNCHANGED <<base, key>>
    /\ UNCHANGED <<marker, items, ever, records, lock, nextName, ix, gen, todo, crashes, optIn, toggled, removed>>

Lock(p) ==
    /\ pc[p] = "locking"
    /\ lock = 0
    /\ lock' = p
    /\ pc' = [pc EXCEPT ![p] = "locked"]
    /\ UNCHANGED <<marker, items, ever, records, nextName, ix, base, gen, key, todo, crashes, optIn, toggled, removed>>

Reread(p) ==
    /\ pc[p] = "locked"
    /\ IF marker /= 0
       THEN /\ lock' = 0
            /\ ReadKeyOf(p, marker)
            /\ UNCHANGED base
       ELSE /\ base' = [base EXCEPT ![p] = 0]
            /\ pc' = [pc EXCEPT ![p] = "gen"]
            /\ UNCHANGED <<lock, key>>
    /\ UNCHANGED <<marker, items, ever, records, nextName, ix, gen, todo, crashes, optIn, toggled, removed>>

Gen(p) ==
    /\ pc[p] = "gen"
    /\ nextName < MaxNames
    /\ nextName' = nextName + 1
    /\ gen' = [gen EXCEPT ![p] = nextName + 1]
    /\ ix' = [ix EXCEPT ![p] = 1]
    /\ pc' = [pc EXCEPT ![p] = "creating"]
    /\ UNCHANGED <<marker, items, ever, records, lock, base, key, todo, crashes, optIn, toggled, removed>>

Creating(p) ==
    /\ pc[p] = "creating"
    /\ LET step == Order[ix[p]]
       IN /\ CASE step = "os" ->
                    /\ items' = items \cup {gen[p]}
                    /\ ever' = ever \cup {gen[p]}
                    /\ UNCHANGED <<marker, records, lock, key, pc>>
               [] step = "marker" ->
                    /\ marker' = gen[p]
                    /\ UNCHANGED <<items, ever, records, lock, key, pc>>
               [] step = "rec0" ->
                    /\ records' = records \cup {[key |-> gen[p], kind |-> "enc"]}
                    /\ UNCHANGED <<marker, items, ever, lock, key, pc>>
               [] step = "unlock" ->
                    /\ lock' = IF lock = p THEN 0 ELSE lock
                    /\ key' = [key EXCEPT ![p] = gen[p]]
                    /\ pc' = [pc EXCEPT ![p] = "rec"]
                    /\ UNCHANGED <<marker, items, ever, records>>
          /\ ix' = [ix EXCEPT ![p] = @ + 1]
    /\ UNCHANGED <<nextName, base, gen, todo, crashes, optIn, toggled, removed>>

Rec(p) ==
    /\ pc[p] = "rec"
    /\ pc' = [pc EXCEPT ![p] = "idle"]
    /\ IF optIn \/ (Variant = "plaintextFallback" /\ key[p] = 0)
       THEN records' = records \cup {[key |-> 0, kind |-> "plain"]}
       ELSE IF key[p] /= 0 /\ key[p] \in items
            THEN records' = records \cup {[key |-> key[p], kind |-> "enc"]}
            ELSE records' = records
    /\ key' = [key EXCEPT ![p] = 0]
    /\ UNCHANGED <<marker, items, ever, lock, nextName, ix, base, gen, todo, crashes, optIn, toggled, removed>>

Finish(p) ==
    /\ pc[p] = "done"
    /\ pc' = [pc EXCEPT ![p] = "idle"]
    /\ key' = [key EXCEPT ![p] = 0]
    /\ UNCHANGED <<marker, items, ever, records, lock, nextName, ix, base, gen, todo, crashes, optIn, toggled, removed>>

Crash(p) ==
    /\ pc[p] /= "idle"
    /\ crashes < MaxCrash
    /\ crashes' = crashes + 1
    /\ pc' = [pc EXCEPT ![p] = "idle"]
    /\ lock' = IF lock = p THEN 0 ELSE lock
    /\ key' = [key EXCEPT ![p] = 0]
    /\ UNCHANGED <<marker, items, ever, records, nextName, ix, base, gen, todo, optIn, toggled, removed>>

UserRemovesItem(n) ==
    /\ CanRemove
    /\ n \in items
    /\ items' = items \ {n}
    /\ removed' = TRUE
    /\ UNCHANGED <<marker, ever, records, lock, nextName, pc, ix, base, gen, key, todo, crashes, optIn, toggled>>

UserRemovesMarker ==
    /\ CanRemove
    /\ marker /= 0
    /\ marker' = 0
    /\ removed' = TRUE
    /\ UNCHANGED <<items, ever, records, lock, nextName, pc, ix, base, gen, key, todo, crashes, optIn, toggled>>

UserTogglesPlaintext ==
    /\ toggled < Toggles
    /\ toggled' = toggled + 1
    /\ optIn' = ~optIn
    /\ UNCHANGED <<marker, items, ever, records, lock, nextName, pc, ix, base, gen, key, todo, crashes, removed>>

Next ==
    \/ \E p \in Writers : Start(p) \/ Fast(p) \/ Lock(p) \/ Reread(p) \/ Gen(p) \/ Creating(p) \/ Rec(p) \/ Finish(p) \/ Crash(p)
    \/ \E n \in Names : UserRemovesItem(n)
    \/ UserRemovesMarker
    \/ UserTogglesPlaintext

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ marker \in 0..MaxNames
    /\ items \subseteq Names
    /\ ever \subseteq Names
    /\ items \subseteq ever
    /\ lock \in {0} \cup Writers
    /\ \A r \in records : r.kind \in {"enc", "plain"}

RecordsReadable ==
    ~removed =>
        \A r \in records : r.kind = "enc" => (r.key = marker /\ r.key \in items)

KeyBeforeRecord ==
    \A r \in records : r.kind = "enc" => r.key \in ever

MarkerImpliesKey ==
    marker /= 0 => (marker \in ever /\ (~removed => marker \in items))

UnreadableNeverRecreates ==
    \A p \in Writers : pc[p] = "creating" => base[p] = 0

MarkerWrittenOnce ==
    [][marker' /= marker => (marker = 0 \/ marker' = 0)]_vars

NoPlaintextUnlessOptIn ==
    [][\A r \in records' \ records : r.kind = "plain" => optIn]_vars

===============================================================================
