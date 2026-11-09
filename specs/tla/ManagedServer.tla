--------------------------- MODULE ManagedServer ---------------------------
(***************************************************************************)
(* Managed local model servers (design-managed-servers-2026-11-09.md,      *)
(* sections 11, 16 and 17, items 1 to 15; design-update-no-interrupt-      *)
(* 2026-11-07.md, section 18 (I5): instances per generation).              *)
(* An instance is an owner, a target and a purpose, with its own socket    *)
(* and marker directory (managed items 4, 8, 12, 13; 18.2.1). The owner is *)
(* a generation's gateway (scope g) or the CLI, which lies outside every    *)
(* generation (scope 0, managed item 13, 18.2.7). Per scope and target     *)
(* there are three instances and four flights:                             *)
(*   instance "s"  the serving instance, owned by the gateway; its one     *)
(*                 flight is also called "s"                               *)
(*   instance "g"  the gateway's probe instance; flights "p1" and "p3".    *)
(*                 "p3" is a second gateway flight of the target under a   *)
(*                 newer key, started while "p1" still runs under the      *)
(*                 older key (a key change taints the running flight)      *)
(*   instance "c"  the CLI's probe instance (item 13), in another process; *)
(*                 its flight "p2"                                         *)
(* The children on an instance are the live children of its flights       *)
(* (alive) and the children an earlier owner left in its socket and       *)
(* marker directory (orphan). The state of an instance is kept under its  *)
(* key, KeyS(scope): the image of the instance path of 18.2.1. With the   *)
(* product's key, KeyS is the scope itself; the evidence SharedKey maps    *)
(* every generation to one key, as the path without a generation would.    *)
(*                                                                         *)
(* Generations (I5, 18.2.2). A generation g has a gateway gw[g]: none,     *)
(* up or down. It retires (ret[g]) when a newer generation has started     *)
(* (the role poll of 18.1; Retire). A retiring gateway accepts no new      *)
(* call and starts no flight (rule 3, 4.2.3, 18.1): StartServe and a       *)
(* gateway ProbeStart need ~ret. The accepted calls of a generation are    *)
(* calls[g][t], at most MaxCalls; a call is accepted only while serving    *)
(* (Accept), and it ends by its own bound (CallEnd). A restart of a child  *)
(* by its timer (TimerFires) needs a serving gateway or an accepted call   *)
(* that needs the child (18.1.5, GwNoRestartRetiring). Two generations of  *)
(* one target run in parallel: a flight of generation g waits only for the *)
(* running flight of its own instance (InstanceWait), never for another    *)
(* generation's (rule 4, 18.2.2). The probe record lock is outside this    *)
(* model (18.3), so the per-key switch SingleFlight relates only flights   *)
(* that share a lock (Locked, below).                                      *)
(*                                                                         *)
(* Item 12: one flight of an instance runs at a time. A flight under a     *)
(* newer key takes its record key's lock (the per-key kernel lock stays    *)
(* for the record, P10 and P11 in AutoProbe.tla), then waits ("wait") for  *)
(* the running flight of its instance, and enters when that flight has     *)
(* ended. The wait has no clock of its own: it ends when the running       *)
(* flight ends, and every state of that flight ends at its own bound       *)
(* (WaitsEnd). The claim of the socket is not that exclusion: the evidence *)
(* sharedProbeSocket (InstanceWait FALSE) has two flights of one target    *)
(* under different keys both pass their claims on the instance's one       *)
(* socket and marker directory before either child holds the socket        *)
(* (packages/gateway/src/managed/fm-serve.ts:244-271, claimSocketPath: the *)
(* reap, then the socket check), and both spawn: OneLiveChild is violated. *)
(* The instance name recurs across starts, because the start-time reap of  *)
(* the same instance is what removes an orphan (StartAfterOrphanServes is  *)
(* per instance); a name per flight, such as a key digest, never recurs    *)
(* once the key changes.                                                   *)
(*                                                                         *)
(* Item 13: the CLI's instance has its own socket and marker directory     *)
(* outside every generation, so no generation reaper and no supervisor     *)
(* reap touches it (the supervisor's reap of a gone gateway never cuts a   *)
(* CLI measurement; 18.4 A16 and T-I5-14). Its orphans are removed by its  *)
(* own stop (StopEnd) and by the start-time reap of its next start (the    *)
(* claim). Today the CLI's probe has one socket for every target and no    *)
(* marker directory (packages/cli/src/commands/gateway.ts:14,169-188, so   *)
(* fm-serve.ts:125-129 spawns it without a group); the model states the    *)
(* design.                                                                 *)
(*                                                                         *)
(* Item 15 and decision 12: a survivor is retried a bounded number of      *)
(* times, then the person is told. The first attempt to stop a child is    *)
(* its own stop (StopEnd; for a gateway that crashed, the supervisor's     *)
(* reap). A child that survives it is a survivor, and every later reap of  *)
(* it is a retry: the start-time reap of the instance's next start (the    *)
(* claim) and the supervisor's reap of a gone gateway (SupervisorReap).    *)
(* Each retry that keeps it spends one of the instance's Retries (decision *)
(* 12: once at each of four occasions, four in all). When they are spent   *)
(* the person is told the survivor's marker and /markers ignore (Told),    *)
(* and no reap signals it again. StartAfterOrphanServes: a claim that      *)
(* recurs is followed again and again by a spawn, or the person has been   *)
(* told. It holds by the bound on the retries, not by assuming that the OS *)
(* eventually stops the survivor: a reap that keeps the survivor may       *)
(* recur, and with BoundedRetries FALSE (the evidence retryEveryStart) it  *)
(* recurs forever with nobody told.                                        *)
(*                                                                         *)
(* Design gap found in the code (item 15). The managed start-time reap     *)
(* does not follow decision 12. fm-serve.ts:244-247 (claimSocketPath)      *)
(* calls reapStaleFmGroups (fm-processes.ts:95-96), the generic            *)
(* reapMarkerDirectory (packages/foundation/src/process-markers.ts:506),   *)
(* which retries a kept marker at every start of the instance with no      *)
(* count (claimRetry and the attempt record, foundation/src/platform/      *)
(* marker-record.ts:3,62, are not used for managed markers) and reports it *)
(* only as a log warning, "... kept: process ... still hold it after       *)
(* cleanup; the next start will retry" (process-markers.ts:431, through    *)
(* onWarning to logger.warn, packages/gateway/src/process.ts:675,698). The *)
(* claim ignores the reap's kept count (fm-serve.ts:247). The supervisor's *)
(* reap of a gone gateway's markers is the same: a kept marker is only     *)
(* logged (packages/supervisor/src/child-manager.ts:519-528). /markers     *)
(* ignore accepts only markers under paths.markers.tools                   *)
(* (packages/runtime/src/service/markers.ts:15,20). The tool markers do    *)
(* follow decision 12 (packages/tools/src/marker-guard.ts:9-33,108-143).   *)
(* The holding configurations state the design (BoundedRetries TRUE).      *)
(*                                                                         *)
(* Actors, derived from the code. The managed code of this branch is the   *)
(* fm-serve.ts form; the generation-keyed form (managedInstancePaths,      *)
(* momonga-paths.ts:179-187; the server, target and precondition files)    *)
(* is on feat/product. Lines cite this branch unless marked feat/product.  *)
(*   gateway process per generation: process.ts:626-629 (closeAdapters),   *)
(*     :649-653 (closeProbes, the probe serves stopped with the close),    *)
(*     :794-796 (closeTogether); Close, Crash, GwUp, GwStart               *)
(*   role poll of run/current (18.1; new in I5, feat/product has none):    *)
(*     Retire; the gateway's refusal of a new call: StartServe and         *)
(*     ProbeStart need ~ret                                                *)
(*   accepted calls (18.1, 18.4 A2): Accept, CallEnd                       *)
(*   serving child: managed/fm-serve.ts:288-300 (launch), :322-357         *)
(*     (terminate: SIGTERM, grace, SIGKILL, grace, finalize), :359-387     *)
(*     (waitUntilHealthy), managed/fm-processes.ts:65-91 (own group, the   *)
(*     marker as fd 3); Spawn, Ready, ChildCrash, ExpireSpawn, ExpireReady *)
(*   start path: fm-serve.ts:469-502 (performStart), :504-521 (begin: the  *)
(*     failure count reset), :244-271 (claimSocketPath: the start-time     *)
(*     reap of the marker directory, then the socket check); StartServe,   *)
(*     PreOk, PreBad, ClaimOk, ClaimKept, ClaimBusy, Hang                  *)
(*   the start-time reap: fm-processes.ts:95-96, the generic reaper        *)
(*     foundation/src/process-markers.ts:388-438 and :506-537, which       *)
(*     signals every holder of every marker in the directory (a sibling    *)
(*     flight's live child too) and may end with a marker kept (:431);     *)
(*     ClaimOk is the confirmed reap, ClaimKept the kept one; its scope is *)
(*     the instance's own key (ReapOwnGenerationOnly; feat/product's       *)
(*     instance path is the generation's own)                              *)
(*   restart timer and budget: fm-serve.ts:399-414 (scheduleRestart),      *)
(*     :416-422 (armStableTimer after restartResetMs), :424-464            *)
(*     (runRestart, which claims as the start does, :441-442); TimerFires, *)
(*     WindowDone                                                          *)
(*   precondition cache C1 (section 7.1): fm-serve.ts:235-242, read and    *)
(*     written by the start and by the health route (fm-target.ts:289,     *)
(*     fm-serve.ts:568-578); PreOk, PreBad, Health                         *)
(*   request path: fm-target.ts:266,275 (ensureRunning), fm-serve.ts:      *)
(*     539-547; StartServe. ensureRunning returns the endpoint only in     *)
(*     running (fm-serve.ts:540-541, :500-501), so P4 (answers only after  *)
(*     readiness) holds by the shape of the start (item 15), pinned by a   *)
(*     unit test, not by TLC                                               *)
(*   gateway probe flights: probe/auto-probe.ts:135-213 (createAutoProbe,  *)
(*     the per-key lock :154), probe/probe-fm.ts:57-93 (each flight starts *)
(*     and stops its own serve), process.ts:686-700; ProbeStart, Enter,    *)
(*     ExpireMeasure                                                       *)
(*   CLI probe: packages/cli/src/commands/gateway.ts:169-188, the same     *)
(*     recordProbe and kernel lock (probe/auto-probe.ts:40-49, 90-94);     *)
(*     its interrupt (Cancel) and its process killed without its stop      *)
(*     (CliCrash: the kernel lock is released, the child stays)            *)
(*   supervisor reap of a gone gateway's managed servers: close-grace      *)
(*     design revision 6, packages/supervisor/src/child-manager.ts:519-528 *)
(*     (reapManagedServers, called from handleExit :536,541): after the    *)
(*     gateway child is gone by any path, the supervisor reaps             *)
(*     paths.markers.targets with the generic reaper at the reaper's own   *)
(*     bound (foundation/src/process-contract.ts:90,                       *)
(*     managedServerReapBoundMs) before it counts the child stopped and    *)
(*     starts the next one; SupervisorReap, then GwUp.                     *)
(*     Item 12 of the managed design (section 18) and 18.4 A16: the        *)
(*     supervisor reaps only its own generation's markers/g<N>/targets/.   *)
(*     THE DEPARTURE: child-manager.ts:528 still reaps paths.markers.targets *)
(*     of every generation (feat/product too). The model has the designed  *)
(*     rule (the reap of one generation's keys); the code is a step 5 fix. *)
(*   key change (a binary replaced, an OS update): KeyChange taints the    *)
(*     flights that run; a newer key may start its own flight              *)
(*   the precondition world (licence, availability): Refuse, Fix           *)
(*                                                                         *)
(* Actors stated as unable to affect the properties:                       *)
(*   the probe record and its key (probe/record.ts): P10 and P11 are       *)
(*     AutoProbe.tla's (section 17 item 2); here a key change only frees   *)
(*     the per-key lock for the newer key                                  *)
(*   other marker users (runtime background jobs, MCP, tools): they use    *)
(*     other marker directories and write none of these variables          *)
(*   config readers and test fakes: the targets are constants; a fake      *)
(*     stands in for the child                                             *)
(*   the generation reaper (L2, 14.5; orphans.ts:120) and the start-up     *)
(*     reap of dead generations (H3): they remove a dead generation's      *)
(*     directories under the reap's claims; they are LeftoverCleanup.tla's *)
(*     and their removal of an instance's socket is modelled there (18.9a) *)
(*   the replay adapter's recording directory (18.4 A18): not reached by   *)
(*     the product gateway                                                 *)
(*   the runtime's gateway client (18.4 A2): its model calls are the       *)
(*     accepted calls of Accept; the refusal it maps to a yield (18.1.3)   *)
(*     changes no variable here                                            *)
(*   two targets that share one key share one lock: that removes           *)
(*     interleavings only (AutoProbe.tla, SingleProbePerKey per key); the  *)
(*     targets of this model have distinct keys                            *)
(*   two CLI processes probing one target: two flights of the instance     *)
(*     "c", which wait for each other by the same instance rule that "p1"  *)
(*     and "p3" follow; the model checks the rule on the gateway's pair    *)
(*     and gives "c" one flight                                            *)
(*   /markers ignore: it changes none of these variables (the survivor     *)
(*     still holds its socket); it is the person's answer after Told       *)
(*                                                                         *)
(* Abstractions. Time is nondeterministic: each wait ends by its own       *)
(* completion or by its asking limit (A1). The child's readiness, crash    *)
(* and exit are environment events (A2). A live child holds its socket, so *)
(* the claim's socket check sees every live child on its key. A measurement *)
(* ends in a report, a failure or its limit, which have the same effect    *)
(* here (A6). Generations are scopes (A4): a generation's gateway, its     *)
(* instances and its calls; the content of a call is not modelled, and a  *)
(* call is one counter. Marker file contents and the reaper's signalling   *)
(* are ProcessMarker.tla and ProcessStop.tla (A5). The retries of an       *)
(* instance are one count (tries) for its survivors: in the holding        *)
(* configurations an instance has at most one child on it (OneLiveChild),  *)
(* so the count is that survivor's attempt record. Which of decision 12's  *)
(* four occasions a retry is (before the next process or file call, the    *)
(* periodic check, start-up, shutdown) is not modelled; every retry of the *)
(* model spends one, so the model admits more retries at one occasion than *)
(* the product makes, never more retries in all.                           *)
(*                                                                         *)
(* Fairness and the environment. The asking limits, the stops, the        *)
(* restart timer, the instance's entry after its wait, the end of the      *)
(* claim, the supervisor's reap, the end of a call and the role poll are   *)
(* weakly fair; nothing is strongly fair. The environment's events are     *)
(* bounded, each by its own counter: gateway closes (MaxCloses), gateway   *)
(* crashes, CLI cancels and kills, key changes, child crashes and refusal  *)
(* toggles. A close or a crash may cut a claim (the model's Close moves it *)
(* to stopping; in the code the claim runs to its own outcome first,       *)
(* fm-serve.ts:483-485 and :441-442, and the stop waits for the pending    *)
(* start, :561-562); with the closes bounded, a claim that recurs ends by  *)
(* its own outcome, and weak fairness does not choose that outcome: the    *)
(* kept reap stays possible each time. A behaviour with more closes than   *)
(* MaxCloses is not checked.                                               *)
(*                                                                         *)
(* Footprints (ReapOwnGenerationOnly, GwNoRestartRetiring, P6). Three      *)
(* history flags are set by the step that does what the property forbids: *)
(* foreignReap by a claim whose reap touches another key (its orphans or   *)
(* its live children), restartRetiring by a timer restart at a retiring    *)
(* gateway with no accepted call. The guards of the actions never let      *)
(* those steps happen in the holding configurations, so the flags stay     *)
(* FALSE in every state of them; each evidence configuration makes the     *)
(* step possible (ReapOther, RetiringRestart) and the property fails.      *)
(* GenerationIsolation (P6) is a state property: a live child of a         *)
(* generation sits on that generation's key (SharedKey violates it).       *)
(*                                                                         *)
(* Dropped evidence. ManagedServer.stopDuringStart (a stop that does not   *)
(* abort a start in progress) is not a configuration. With the start that  *)
(* outlives its stop modelled as the code would run it, it launches only   *)
(* while its gateway process lives (the process is gone before the         *)
(* supervisor reaps and starts the next one), and its child is an orphan   *)
(* of the serving instance that the next start's reap and the supervisor's *)
(* reap remove; it then holds every property of this model, so it shows    *)
(* nothing. The stop's duration with a pending start (fm-serve.ts:561-562) *)
(* is close-grace arithmetic (packages/verify/test/proofs/                 *)
(* shutdown-bounds.test.ts), not a TLC property. The model has the code's  *)
(* rule: a stop aborts a start (fm-serve.ts:549-552, :484-485).            *)
(*                                                                         *)
(* Configurations and what they leave uncovered.                           *)
(*   every-run, holding (Gens = {1}, the one generation of the earlier     *)
(*   pass; MaxCalls 0, the mutants FALSE):                                 *)
(*     ManagedServer: safety; one target, one restart, one child crash,    *)
(*       two gateway closes, one gateway crash, one key change, two        *)
(*       refusal toggles, one cancel, both gateway flights, Retries 4      *)
(*     ManagedServer.live: liveness; two gateway closes, one gateway crash *)
(*       and one cancel, so orphans of a stopped gateway, of a crashed     *)
(*       gateway and of a killed CLI; one gateway flight, no key change    *)
(*     ManagedServer.liveWait: liveness; both gateway flights and one key  *)
(*       change, so the wait of item 12; one gateway close, no crash and   *)
(*       no cancel                                                         *)
(*     ManagedServer.gens: safety; two generations of one target, one      *)
(*       call, one child crash, one gateway close and one gateway crash    *)
(*       (instances per generation, P6, ReapOwnGenerationOnly,             *)
(*       GwNoRestartRetiring; the retiring of gateway 1 by gateway 2)      *)
(*   deep, holding:                                                        *)
(*     ManagedServer.deep: safety; two restarts and two child crashes      *)
(*       added to ManagedServer's events, Retries 4                        *)
(*     ManagedServer.twoTargets: safety; two targets, one gateway close,   *)
(*       one gateway flight, no other event (with a gateway crash added it *)
(*       passed the 30 CPU-minute bound of a run)                          *)
(*     ManagedServer.deepLive: liveness; the events of live and liveWait   *)
(*       together, with one gateway close                                  *)
(*   every-run, evidence (each violates the property named in its cfg):    *)
(*     ManagedServer.sharedAcrossGenerations: SharedKey, P6 (exit 12)      *)
(*     ManagedServer.reapOtherGeneration: ReapOther, ReapOwnGenerationOnly *)
(*       (exit 12)                                                         *)
(*     ManagedServer.retiringRestarts: RetiringRestart,                    *)
(*       GwNoRestartRetiring (exit 12)                                     *)
(*   Retries is 1 in the liveness configurations and in twoTargets. The    *)
(*   liveness of StartAfterOrphanServes needs the count finite, not its    *)
(*   value, and 1 is the smallest finite count. twoTargets checks what two *)
(*   targets share, not the retries. The safety configurations             *)
(*   ManagedServer and deep use the product's 4, which the drift test      *)
(*   ties to the code (RETRY_KINDS).                                       *)
(*   Not covered by TLC: section 16.1's deep shape (two targets with three *)
(*   restarts and every event, and liveness over two targets) does not     *)
(*   finish within the 30 CPU-minute bound of a run. A restart budget of   *)
(*   three is the arithmetic of RM5 (packages/verify/test/proofs/          *)
(*   managed-bounds.test.ts). Two targets share no variable but the        *)
(*   gateway's up and down, the supervisor's reap and the precondition     *)
(*   world, which twoTargets checks for safety only, with one close and no *)
(*   crash. Not checked: liveness with a child crash, a refusal toggle or  *)
(*   two restarts; two key changes; more than one cancel or gateway crash; *)
(*   more than two gateway closes in any configuration; Retries above 1    *)
(*   under liveness; liveness over two generations; two generations with a *)
(*   key change, a cancel or a refusal toggle.                             *)
(*                                                                         *)
(* Switches. The holding configurations set the design.                    *)
(*   Gens           the generations of the target; {1} is the one-generation *)
(*                  model of the earlier pass                              *)
(*   MaxCalls       the accepted calls a generation may have open; 0: none  *)
(*   GwFlights      1: the gateway runs one flight per target; 2: also a   *)
(*                  second flight under a newer key ("p3")                 *)
(*   SingleFlight   "key": a flight starts only when every other flight    *)
(*                  that shares its lock is idle or runs under an older key *)
(*                  (tainted); "none": no lock. Flights of two generations *)
(*                  do not share the record lock (18.3), so they never     *)
(*                  wait for each other by this switch                     *)
(*   InstanceWait   a flight waits for the running flight of its instance  *)
(*                  (item 12); FALSE: it goes on at once                   *)
(*   ReapOnStart    the claim reaps the marker directory first             *)
(*   BoundedRetries a survivor gets Retries retries, then the person is    *)
(*                  told and no reap signals it again (decision 12);       *)
(*                  FALSE: every claim and every supervisor reap retries   *)
(*                  it and nobody is told (the code today)                 *)
(*   Retries        the retries of decision 12 (four)                      *)
(*   CacheRefusal   a refused precondition is cached                       *)
(*   ResetOnReady   the failure count resets on every ready, not after a   *)
(*                  stable window                                          *)
(*   ClaimBounded   the claim's reap and socket check end at their bound   *)
(*   SharedKey      mutant: every generation's instances use one key (the  *)
(*                  path of 18.2.1 without the generation)                 *)
(*   ReapOther      mutant: a start's reap also clears the other           *)
(*                  generations' keys                                      *)
(*   RetiringRestart mutant: a timer restart at a retiring gateway without *)
(*                  an accepted call                                       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Targets,
    Gens,
    MaxRestarts,
    MaxChildCrashes,
    MaxGwCrashes,
    MaxKeyChanges,
    MaxRefusals,
    MaxCancels,
    MaxCloses,
    MaxCalls,
    GwFlights,
    SingleFlight,
    InstanceWait,
    ReapOnStart,
    BoundedRetries,
    Retries,
    CacheRefusal,
    ResetOnReady,
    ClaimBounded,
    SharedKey,
    ReapOther,
    RetiringRestart,
    CliEvents

ASSUME /\ Gens \subseteq Nat \ {0} /\ Gens # {}
       /\ MaxRestarts \in Nat \ {0}
       /\ MaxChildCrashes \in Nat
       /\ MaxGwCrashes \in Nat
       /\ MaxKeyChanges \in Nat
       /\ MaxRefusals \in Nat
       /\ MaxCancels \in Nat
       /\ MaxCloses \in Nat
       /\ MaxCalls \in Nat
       /\ GwFlights \in {1, 2}
       /\ SingleFlight \in {"key", "none"}
       /\ InstanceWait \in BOOLEAN
       /\ ReapOnStart \in BOOLEAN
       /\ BoundedRetries \in BOOLEAN
       /\ Retries \in Nat \ {0}
       /\ CacheRefusal \in BOOLEAN
       /\ ResetOnReady \in BOOLEAN
       /\ ClaimBounded \in BOOLEAN
       /\ SharedKey \in BOOLEAN
       /\ ReapOther \in BOOLEAN
       /\ RetiringRestart \in BOOLEAN
       /\ CliEvents \in BOOLEAN

Scopes == {0} \cup Gens
MinGen == CHOOSE g \in Gens : \A h \in Gens : g <= h
Flights == {"s", "p1", "p2", "p3"}
Probes == {"p1", "p2", "p3"}
GwOwned == {"s", "p1", "p3"}
Insts == {"s", "g", "c"}
GwInsts == {"s", "g"}
InstOf(f) == CASE f = "s" -> "s" [] f = "p2" -> "c" [] OTHER -> "g"
States == {"idle", "wait", "pre", "claim", "spawn", "ready", "running", "measure", "backoff", "stopping", "failed"}
Waiting == {"wait", "pre", "claim", "spawn", "ready", "measure", "backoff", "stopping"}
Gone == {"idle", "failed"}
Free == {"idle", "wait"}
GwStates == {"none", "up", "down"}

KeyS(s) == IF s = 0 \/ ~SharedKey THEN s ELSE MinGen
ReapKeys(s) == IF ReapOther /\ s # 0 THEN {KeyS(g) : g \in Gens} ELSE {KeyS(s)}
Locked(s, r) == s = r \/ s = 0 \/ r = 0
Partner(f) == IF f = "p1" THEN "p3" ELSE "p1"

VARIABLES
    gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls,
    st, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped,
    foreignReap, restartRetiring

vars == <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, st, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring>>

AliveOn(k, t, n) == Cardinality({sf \in Scopes \X Flights : KeyS(sf[1]) = k /\ InstOf(sf[2]) = n /\ alive[sf[1]][t][sf[2]] = 1})
OnInst(s, t, n) == orphan[KeyS(s)][t][n] + AliveOn(KeyS(s), t, n)
InstanceBusy(s, t, f) == InstOf(f) = "g" /\ st[s][t][Partner(f)] \notin Free
Told(k, t, n) == BoundedRetries /\ tries[k][t][n] = Retries
MayReap(s, t, n) == ReapOnStart /\ ~Told(KeyS(s), t, n)
Spend(k, t, n) == IF BoundedRetries THEN tries[k][t][n] + 1 ELSE tries[k][t][n]
ForeignFootprint(s, t, n) == \E k \in ReapKeys(s) \ {KeyS(s)} : orphan[k][t][n] > 0 \/ AliveOn(k, t, n) > 0
FailTarget(s, t) == IF cc[s][t] >= MaxRestarts THEN "failed" ELSE "backoff"
EndOf(s, t, f) == IF f = "s" THEN FailTarget(s, t) ELSE "idle"
ClearedPre(s, t, f) == [pre EXCEPT ![s][t] = IF f = "s" THEN "unknown" ELSE pre[s][t]]
ProbeGate(s, f) == IF f = "p2" THEN s = 0 /\ CliEvents ELSE s \in Gens /\ gw[s] = "up" /\ ~ret[s]

TypeOK ==
    /\ gw \in [Gens -> GwStates]
    /\ ret \in [Gens -> BOOLEAN]
    /\ reaped \in [Gens -> BOOLEAN]
    /\ gwCrashes \in 0..MaxGwCrashes
    /\ childCrashes \in 0..MaxChildCrashes
    /\ keyChanges \in 0..MaxKeyChanges
    /\ refusals \in 0..MaxRefusals
    /\ cancels \in 0..MaxCancels
    /\ closes \in 0..MaxCloses
    /\ calls \in [Scopes -> [Targets -> 0..MaxCalls]]
    /\ st \in [Scopes -> [Targets -> [Flights -> States]]]
    /\ alive \in [Scopes -> [Targets -> [Flights -> 0..1]]]
    /\ orphan \in [Scopes -> [Targets -> [Insts -> 0..3]]]
    /\ tries \in [Scopes -> [Targets -> [Insts -> 0..Retries]]]
    /\ taint \in [Scopes -> [Targets -> [Flights -> BOOLEAN]]]
    /\ hung \in [Scopes -> [Targets -> [Flights -> BOOLEAN]]]
    /\ cond \in {"ok", "bad"}
    /\ pre \in [Scopes -> [Targets -> {"unknown", "met", "refused"}]]
    /\ cc \in [Scopes -> [Targets -> 0..MaxRestarts]]
    /\ gt \in [Scopes -> [Targets -> 0..MaxRestarts]]
    /\ foreignReap \in BOOLEAN
    /\ restartRetiring \in BOOLEAN

Init ==
    /\ gw = [g \in Gens |-> IF g = MinGen THEN "up" ELSE "none"]
    /\ ret = [g \in Gens |-> FALSE]
    /\ reaped = [g \in Gens |-> TRUE]
    /\ gwCrashes = 0 /\ childCrashes = 0 /\ keyChanges = 0 /\ refusals = 0 /\ cancels = 0 /\ closes = 0
    /\ calls = [s \in Scopes |-> [t \in Targets |-> 0]]
    /\ st = [s \in Scopes |-> [t \in Targets |-> [f \in Flights |-> "idle"]]]
    /\ alive = [s \in Scopes |-> [t \in Targets |-> [f \in Flights |-> 0]]]
    /\ orphan = [s \in Scopes |-> [t \in Targets |-> [n \in Insts |-> 0]]]
    /\ tries = [s \in Scopes |-> [t \in Targets |-> [n \in Insts |-> 0]]]
    /\ taint = [s \in Scopes |-> [t \in Targets |-> [f \in Flights |-> FALSE]]]
    /\ hung = [s \in Scopes |-> [t \in Targets |-> [f \in Flights |-> FALSE]]]
    /\ cond = "ok"
    /\ pre = [s \in Scopes |-> [t \in Targets |-> "unknown"]]
    /\ cc = [s \in Scopes |-> [t \in Targets |-> 0]]
    /\ gt = [s \in Scopes |-> [t \in Targets |-> 0]]
    /\ foreignReap = FALSE
    /\ restartRetiring = FALSE

StartServe(s, t) ==
    /\ s \in Gens /\ gw[s] = "up" /\ ~ret[s]
    /\ st[s][t]["s"] \in Gone /\ pre[s][t] # "refused"
    /\ st' = [st EXCEPT ![s][t]["s"] = IF pre[s][t] = "met" THEN "claim" ELSE "pre"]
    /\ pre' = [pre EXCEPT ![s][t] = "unknown"]
    /\ cc' = [cc EXCEPT ![s][t] = 0]
    /\ gt' = [gt EXCEPT ![s][t] = 0]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, reaped, foreignReap, restartRetiring>>

Health(s, t) ==
    /\ s \in Gens /\ gw[s] = "up" /\ pre[s][t] = "unknown"
    /\ pre' = [pre EXCEPT ![s][t] = IF cond = "ok" THEN "met" ELSE IF CacheRefusal THEN "refused" ELSE "unknown"]
    /\ pre' # pre
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, st, alive, orphan, tries, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring>>

PreOk(s, t, f) ==
    /\ st[s][t][f] = "pre" /\ cond = "ok"
    /\ st' = [st EXCEPT ![s][t][f] = "claim"]
    /\ pre' = [pre EXCEPT ![s][t] = IF f = "s" THEN "met" ELSE pre[s][t]]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring>>

PreBad(s, t, f) ==
    /\ st[s][t][f] = "pre" /\ cond = "bad"
    /\ st' = [st EXCEPT ![s][t][f] = "idle"]
    /\ pre' = [pre EXCEPT ![s][t] = IF f = "s" /\ CacheRefusal THEN "refused" ELSE pre[s][t]]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring>>

ClaimOk(s, t, f) ==
    LET n == InstOf(f)
        k == KeyS(s)
    IN
    /\ st[s][t][f] = "claim" /\ ~hung[s][t][f] /\ (OnInst(s, t, n) = 0 \/ MayReap(s, t, n))
    /\ st' = [st EXCEPT ![s][t][f] = "spawn"]
    /\ foreignReap' = foreignReap \/ ForeignFootprint(s, t, n)
    /\ orphan' = [s2 \in Scopes |-> [t2 \in Targets |-> [n2 \in Insts |->
            IF t2 = t /\ n2 = n /\ s2 \in ReapKeys(s) THEN 0 ELSE orphan[s2][t2][n2]]]]
    /\ tries' = [tries EXCEPT ![k][t][n] = 0]
    /\ alive' = [s2 \in Scopes |-> [t2 \in Targets |-> [p \in Flights |->
            IF t2 = t /\ InstOf(p) = n /\ KeyS(s2) \in ReapKeys(s) THEN 0 ELSE alive[s2][t2][p]]]]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, taint, hung, cond, pre, cc, gt, reaped, restartRetiring>>

ClaimKept(s, t, f) ==
    LET n == InstOf(f)
        k == KeyS(s)
    IN
    /\ st[s][t][f] = "claim" /\ ~hung[s][t][f] /\ OnInst(s, t, n) > 0 /\ MayReap(s, t, n)
    /\ st' = [st EXCEPT ![s][t][f] = EndOf(s, t, f)]
    /\ pre' = ClearedPre(s, t, f)
    /\ tries' = [tries EXCEPT ![k][t][n] = Spend(k, t, n)]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring>>

ClaimBusy(s, t, f) ==
    LET n == InstOf(f)
    IN
    /\ st[s][t][f] = "claim" /\ ~hung[s][t][f] /\ OnInst(s, t, n) > 0 /\ ~MayReap(s, t, n)
    /\ st' = [st EXCEPT ![s][t][f] = EndOf(s, t, f)]
    /\ pre' = ClearedPre(s, t, f)
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring>>

ClaimEnd(s, t, f) == ClaimOk(s, t, f) \/ ClaimKept(s, t, f) \/ ClaimBusy(s, t, f)

Hang(s, t, f) ==
    /\ ~ClaimBounded /\ st[s][t][f] = "claim" /\ ~hung[s][t][f]
    /\ hung' = [hung EXCEPT ![s][t][f] = TRUE]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, st, alive, orphan, tries, taint, cond, pre, cc, gt, reaped, foreignReap, restartRetiring>>

Spawn(s, t, f) ==
    /\ st[s][t][f] = "spawn"
    /\ st' = [st EXCEPT ![s][t][f] = "ready"]
    /\ alive' = [alive EXCEPT ![s][t][f] = 1]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring>>

Ready(s, t, f) ==
    /\ st[s][t][f] = "ready" /\ alive[s][t][f] = 1
    /\ st' = [st EXCEPT ![s][t][f] = IF f = "s" THEN "running" ELSE "measure"]
    /\ cc' = [cc EXCEPT ![s][t] = IF f = "s" /\ ResetOnReady THEN 0 ELSE cc[s][t]]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, pre, gt, reaped, foreignReap, restartRetiring>>

ChildCrash(s, t, f) ==
    /\ childCrashes < MaxChildCrashes /\ alive[s][t][f] = 1 /\ st[s][t][f] \in {"ready", "running", "measure"}
    /\ childCrashes' = childCrashes + 1
    /\ alive' = [alive EXCEPT ![s][t][f] = 0]
    /\ st' = [st EXCEPT ![s][t][f] = EndOf(s, t, f)]
    /\ pre' = ClearedPre(s, t, f)
    /\ UNCHANGED <<gw, ret, gwCrashes, keyChanges, refusals, cancels, closes, calls, orphan, tries, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring>>

ExpirePre(s, t, f) ==
    /\ st[s][t][f] = "pre"
    /\ st' = [st EXCEPT ![s][t][f] = "idle"]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring>>

ExpireSpawn(s, t, f) ==
    /\ st[s][t][f] = "spawn"
    /\ st' = [st EXCEPT ![s][t][f] = EndOf(s, t, f)]
    /\ pre' = ClearedPre(s, t, f)
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring>>

ExpireReady(s, t, f) ==
    /\ st[s][t][f] = "ready"
    /\ alive' = [alive EXCEPT ![s][t][f] = 0]
    /\ st' = [st EXCEPT ![s][t][f] = EndOf(s, t, f)]
    /\ pre' = ClearedPre(s, t, f)
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, orphan, tries, taint, hung, cond, cc, gt, reaped, foreignReap, restartRetiring>>

ExpireMeasure(s, t, f) ==
    /\ f \in Probes /\ st[s][t][f] = "measure"
    /\ st' = [st EXCEPT ![s][t][f] = "stopping"]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring>>

Expire(s, t, f) == ExpirePre(s, t, f) \/ ExpireSpawn(s, t, f) \/ ExpireReady(s, t, f) \/ ExpireMeasure(s, t, f)

TimerFires(s, t) ==
    /\ s \in Gens /\ st[s][t]["s"] = "backoff"
    /\ (~ret[s] \/ calls[s][t] > 0 \/ RetiringRestart)
    /\ st' = [st EXCEPT ![s][t]["s"] = "pre"]
    /\ pre' = [pre EXCEPT ![s][t] = "unknown"]
    /\ cc' = [cc EXCEPT ![s][t] = cc[s][t] + 1]
    /\ gt' = [gt EXCEPT ![s][t] = gt[s][t] + 1]
    /\ restartRetiring' = restartRetiring \/ (ret[s] /\ calls[s][t] = 0)
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, reaped, foreignReap>>

WindowDone(s, t) ==
    /\ st[s][t]["s"] = "running" /\ (cc[s][t] > 0 \/ gt[s][t] > 0)
    /\ cc' = [cc EXCEPT ![s][t] = 0]
    /\ gt' = [gt EXCEPT ![s][t] = 0]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, st, alive, orphan, tries, taint, hung, cond, pre, reaped, foreignReap, restartRetiring>>

Accept(s, t) ==
    /\ s \in Gens /\ gw[s] = "up" /\ ~ret[s] /\ calls[s][t] < MaxCalls
    /\ calls' = [calls EXCEPT ![s][t] = calls[s][t] + 1]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, st, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring>>

CallEnd(s, t) ==
    /\ calls[s][t] > 0
    /\ calls' = [calls EXCEPT ![s][t] = calls[s][t] - 1]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, st, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring>>

ProbeStart(s, t, f) ==
    /\ f \in Probes /\ st[s][t][f] = "idle" /\ ProbeGate(s, f)
    /\ (f = "p3" => GwFlights = 2 /\ st[s][t]["p1"] # "idle")
    /\ (SingleFlight = "none" \/ \A r \in Scopes : Locked(s, r) => \A j \in Probes : ((r = s /\ j = f) \/ st[r][t][j] = "idle" \/ taint[r][t][j]))
    /\ st' = [st EXCEPT ![s][t][f] = IF InstanceWait /\ InstanceBusy(s, t, f) THEN "wait" ELSE "pre"]
    /\ taint' = [taint EXCEPT ![s][t][f] = FALSE]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring>>

Enter(s, t, f) ==
    /\ st[s][t][f] = "wait" /\ ~InstanceBusy(s, t, f)
    /\ st' = [st EXCEPT ![s][t][f] = "pre"]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring>>

StopEnd(s, t, f) ==
    LET n == InstOf(f)
        k == KeyS(s)
    IN
    /\ st[s][t][f] = "stopping"
    /\ \E confirmed \in BOOLEAN :
         orphan' = [orphan EXCEPT ![k][t][n] = IF confirmed THEN @ ELSE @ + alive[s][t][f]]
    /\ alive' = [alive EXCEPT ![s][t][f] = 0]
    /\ st' = [st EXCEPT ![s][t][f] = "idle"]
    /\ pre' = ClearedPre(s, t, f)
    /\ taint' = [taint EXCEPT ![s][t][f] = FALSE]
    /\ hung' = [hung EXCEPT ![s][t][f] = FALSE]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, tries, cond, cc, gt, reaped, foreignReap, restartRetiring>>

Cancel(t) ==
    /\ cancels < MaxCancels /\ st[0][t]["p2"] \in {"pre", "claim", "spawn", "ready", "measure"}
    /\ st' = [st EXCEPT ![0][t]["p2"] = "stopping"]
    /\ cancels' = cancels + 1
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, closes, calls, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring>>

CliCrash(t) ==
    /\ cancels < MaxCancels /\ st[0][t]["p2"] # "idle"
    /\ st' = [st EXCEPT ![0][t]["p2"] = "idle"]
    /\ orphan' = [orphan EXCEPT ![0][t]["c"] = @ + alive[0][t]["p2"]]
    /\ alive' = [alive EXCEPT ![0][t]["p2"] = 0]
    /\ taint' = [taint EXCEPT ![0][t]["p2"] = FALSE]
    /\ hung' = [hung EXCEPT ![0][t]["p2"] = FALSE]
    /\ cancels' = cancels + 1
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, closes, calls, tries, cond, pre, cc, gt, reaped, foreignReap, restartRetiring>>

Close(g) ==
    /\ gw[g] = "up" /\ closes < MaxCloses
    /\ gw' = [gw EXCEPT ![g] = "down"]
    /\ closes' = closes + 1
    /\ st' = [st EXCEPT ![g] = [t \in Targets |->
            [f \in Flights |->
                IF f \in GwOwned /\ st[g][t][f] \in {"backoff", "wait"} THEN "idle"
                ELSE IF f \in GwOwned /\ st[g][t][f] \in {"pre", "claim", "spawn", "ready", "running", "measure"} THEN "stopping"
                ELSE st[g][t][f]]]]
    /\ pre' = [pre EXCEPT ![g] = [t \in Targets |-> "unknown"]]
    /\ reaped' = [reaped EXCEPT ![g] = FALSE]
    /\ UNCHANGED <<ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, calls, alive, orphan, tries, taint, hung, cond, cc, gt, foreignReap, restartRetiring>>

Crash(g) ==
    /\ gw[g] = "up" /\ gwCrashes < MaxGwCrashes
    /\ gw' = [gw EXCEPT ![g] = "down"]
    /\ gwCrashes' = gwCrashes + 1
    /\ st' = [st EXCEPT ![g] = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN "idle" ELSE st[g][t][f]]]]
    /\ orphan' = [k \in Scopes |-> [t \in Targets |-> [n \in Insts |->
            orphan[k][t][n] + IF k = KeyS(g) /\ n \in GwInsts THEN Cardinality({p \in Flights : InstOf(p) = n /\ alive[g][t][p] = 1}) ELSE 0]]]
    /\ alive' = [alive EXCEPT ![g] = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN 0 ELSE alive[g][t][f]]]]
    /\ taint' = [taint EXCEPT ![g] = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN FALSE ELSE taint[g][t][f]]]]
    /\ hung' = [hung EXCEPT ![g] = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN FALSE ELSE hung[g][t][f]]]]
    /\ pre' = [pre EXCEPT ![g] = [t \in Targets |-> "unknown"]]
    /\ cc' = [cc EXCEPT ![g] = [t \in Targets |-> 0]]
    /\ gt' = [gt EXCEPT ![g] = [t \in Targets |-> 0]]
    /\ reaped' = [reaped EXCEPT ![g] = FALSE]
    /\ UNCHANGED <<ret, childCrashes, keyChanges, refusals, cancels, closes, calls, tries, cond, foreignReap, restartRetiring>>

ReapGone(g) ==
    /\ gw[g] = "down" /\ ~reaped[g]
    /\ \A t \in Targets, f \in GwOwned : st[g][t][f] \in Gone
    /\ reaped' = [reaped EXCEPT ![g] = TRUE]
    /\ \E kill \in [Targets -> [GwInsts -> BOOLEAN]] :
         LET k == KeyS(g)
             Signalled(t, n) == n \in GwInsts /\ orphan[k][t][n] > 0 /\ ~Told(k, t, n)
         IN
         /\ orphan' = [orphan EXCEPT ![k] = [t \in Targets |-> [n \in Insts |->
                IF Signalled(t, n) /\ kill[t][n] THEN 0 ELSE orphan[k][t][n]]]]
         /\ tries' = [tries EXCEPT ![k] = [t \in Targets |-> [n \in Insts |->
                IF ~Signalled(t, n) THEN tries[k][t][n]
                ELSE IF kill[t][n] THEN 0
                ELSE Spend(k, t, n)]]]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, st, alive, taint, hung, cond, pre, cc, gt, foreignReap, restartRetiring>>

SupervisorReap == \E g \in Gens : ReapGone(g)

GwUp(g) ==
    /\ gw[g] = "down" /\ reaped[g] /\ ~ret[g]
    /\ gw' = [gw EXCEPT ![g] = "up"]
    /\ st' = [st EXCEPT ![g] = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN "idle" ELSE st[g][t][f]]]]
    /\ hung' = [hung EXCEPT ![g] = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN FALSE ELSE hung[g][t][f]]]]
    /\ cc' = [cc EXCEPT ![g] = [t \in Targets |-> 0]]
    /\ gt' = [gt EXCEPT ![g] = [t \in Targets |-> 0]]
    /\ UNCHANGED <<ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, alive, orphan, tries, taint, cond, pre, reaped, foreignReap, restartRetiring>>

GwStart(g) ==
    /\ gw[g] = "none"
    /\ gw' = [gw EXCEPT ![g] = "up"]
    /\ UNCHANGED <<ret, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, st, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring>>

Retire(g) ==
    /\ ~ret[g] /\ (\E h \in Gens : h > g /\ gw[h] # "none")
    /\ ret' = [ret EXCEPT ![g] = TRUE]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, closes, calls, st, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring>>

KeyChange ==
    /\ keyChanges < MaxKeyChanges
    /\ keyChanges' = keyChanges + 1
    /\ taint' = [s \in Scopes |-> [t \in Targets |-> [f \in Flights |-> taint[s][t][f] \/ (f \in Probes /\ st[s][t][f] # "idle")]]]
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, refusals, cancels, closes, calls, st, alive, orphan, tries, hung, cond, pre, cc, gt, reaped, foreignReap, restartRetiring>>

Refuse ==
    /\ cond = "ok" /\ refusals < MaxRefusals
    /\ cond' = "bad" /\ refusals' = refusals + 1
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, cancels, closes, calls, st, alive, orphan, tries, taint, hung, pre, cc, gt, reaped, foreignReap, restartRetiring>>

Fix ==
    /\ cond = "bad" /\ refusals < MaxRefusals
    /\ cond' = "ok" /\ refusals' = refusals + 1
    /\ UNCHANGED <<gw, ret, gwCrashes, childCrashes, keyChanges, cancels, closes, calls, st, alive, orphan, tries, taint, hung, pre, cc, gt, reaped, foreignReap, restartRetiring>>

Next ==
    \/ \E t \in Targets : Cancel(t) \/ CliCrash(t)
    \/ \E s \in Scopes, t \in Targets :
        StartServe(s, t) \/ Health(s, t) \/ WindowDone(s, t) \/ TimerFires(s, t) \/ Accept(s, t) \/ CallEnd(s, t)
    \/ \E s \in Scopes, t \in Targets, f \in Flights :
        PreOk(s, t, f) \/ PreBad(s, t, f) \/ ClaimEnd(s, t, f) \/ Hang(s, t, f)
        \/ Spawn(s, t, f) \/ Ready(s, t, f) \/ ChildCrash(s, t, f) \/ Expire(s, t, f)
        \/ StopEnd(s, t, f) \/ ProbeStart(s, t, f) \/ Enter(s, t, f)
    \/ \E g \in Gens :
        Close(g) \/ Crash(g) \/ GwUp(g) \/ GwStart(g) \/ Retire(g) \/ ReapGone(g)
    \/ KeyChange \/ Refuse \/ Fix

Fairness ==
    /\ \A g \in Gens : WF_vars(ReapGone(g)) /\ WF_vars(Retire(g))
    /\ \A s \in Scopes, t \in Targets :
        /\ WF_vars(TimerFires(s, t))
        /\ WF_vars(CallEnd(s, t))
        /\ \A f \in Flights :
            /\ WF_vars(Expire(s, t, f))
            /\ WF_vars(StopEnd(s, t, f))
            /\ WF_vars(Enter(s, t, f))
            /\ WF_vars(ClaimEnd(s, t, f))

Spec == Init /\ [][Next]_vars /\ Fairness

(* P1: at most one live child per instance, that is per key and instance *)
OneLiveChild == \A k \in Scopes, t \in Targets, n \in Insts : orphan[k][t][n] + AliveOn(k, t, n) <= 1

(* P7: a flight runs only beside flights that do not share its lock, or of older keys *)
OneFlight == \A t \in Targets : \A s, r \in Scopes : \A p, q \in Probes :
    (Locked(s, r) /\ ~(s = r /\ p = q) /\ st[s][t][p] # "idle" /\ st[r][t][q] # "idle") => (taint[s][t][p] \/ taint[r][t][q])

(* P5: C1, the cache holds no refusal; every start, restart, exit and stop clears it *)
NoCachedRefusal == \A s \in Scopes, t \in Targets : pre[s][t] # "refused"

(* P3: the consecutive failures stay within the budget *)
RestartBudget == \A s \in Scopes, t \in Targets : cc[s][t] <= MaxRestarts /\ (st[s][t]["s"] = "backoff" => gt[s][t] < MaxRestarts)

(* P6 (generation isolation, managed 11.1): a live child of a generation sits on that generation's own key *)
GenerationIsolation == \A g \in Gens, t \in Targets, p \in Flights : alive[g][t][p] = 1 => KeyS(g) = g

(* reap: a claim's reap touches only its own generation's keys (18.2.3, item 12) *)
ReapOwnGenerationOnly == ~foreignReap

(* 18.8: a timer restart at a retiring gateway needs an accepted call of that generation *)
GwNoRestartRetiring == ~restartRetiring

(* P8: every waiting state (start, readiness, precondition, stop, claim) leaves under fairness of the ticks; no wait is unbounded *)
WaitsEnd == \A s \in Scopes, t \in Targets, f \in Flights : (st[s][t][f] \in Waiting) ~> (st[s][t][f] \notin Waiting)

(* rev 6: a gone gateway's managed servers are reaped before it counts as stopped *)
GoneGatewayReaped == \A g \in Gens : (gw[g] = "down") ~> reaped[g]

(* P2 and item 15: a claim that recurs is followed by a spawn again and again, *)
(* or the person has been told the survivor's marker (decision 12)              *)
StartAfterOrphanServes == \A s \in Scopes, t \in Targets, f \in Flights :
    []<>(st[s][t][f] = "claim") => []<>(st[s][t][f] = "spawn" \/ Told(KeyS(s), t, InstOf(f)))

=========================================================================
