--------------------------- MODULE ManagedServer ---------------------------
(***************************************************************************)
(* Managed local model servers (design-managed-servers-2026-11-09.md,      *)
(* sections 11, 16 and 17, items 1 to 15). An instance is an owner and a   *)
(* target, with its own socket and marker directory (items 4, 8, 12, 13). *)
(* Per target there are three instances and four flights:                  *)
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
(* marker directory (orphan).                                              *)
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
(* outside paths.markers.targets, so SupervisorReap never touches it (the  *)
(* supervisor's reap of a gone gateway never cuts a CLI measurement). Its  *)
(* orphans are removed by its own stop (StopEnd) and by the start-time     *)
(* reap of its next start (the claim). Today the CLI's probe has one      *)
(* socket for every target and no marker directory                         *)
(* (packages/cli/src/commands/gateway.ts:14,169-188, so fm-serve.ts:125-129 *)
(* spawns it without a group); the model states the design.               *)
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
(* Actors, derived from the code (packages/gateway/src unless named):      *)
(*   gateway process: process.ts:626-629 (closeAdapters), :649-653         *)
(*     (closeProbes, the probe serves stopped with the close), :794-796    *)
(*     (closeTogether); Close, Crash, GwUp                                 *)
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
(*     ClaimOk is the confirmed reap, ClaimKept the kept one               *)
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
(*     starts the next one; SupervisorReap, then GwUp                      *)
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
(* the claim's socket check sees every live child. A measurement ends in a *)
(* report, a failure or its limit, which have the same effect here (A6).   *)
(* One generation (A4). Marker file contents and the reaper's signalling   *)
(* are ProcessMarker.tla and ProcessStop.tla (A5). The retries of an       *)
(* instance are one count (tries) for its survivors: in the holding        *)
(* configurations an instance has at most one child on it (OneLiveChild),  *)
(* so the count is that survivor's attempt record. Which of decision 12's  *)
(* four occasions a retry is (before the next process or file call, the    *)
(* periodic check, start-up, shutdown) is not modelled; every retry of the *)
(* model spends one, so the model admits more retries at one occasion than *)
(* the product makes, never more retries in all.                           *)
(*                                                                         *)
(* Fairness. The asking limits, the stops, the restart timer, the          *)
(* instance's entry after its wait and the supervisor's reap are weakly    *)
(* fair. The end of the claim is strongly fair: the claim runs to its own  *)
(* outcome even when a stop arrives (fm-serve.ts:483-485 and :441-442 see  *)
(* the stop only after claimSocketPath; the stop waits for the pending     *)
(* start, :561-562), while the model's Close may cut a claim; strong       *)
(* fairness states that a claim that recurs is not cut every time. It does *)
(* not choose the claim's outcome: the kept reap stays possible each time. *)
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
(*   every-run, holding:                                                   *)
(*     ManagedServer: safety; one target, one restart, one child crash,    *)
(*       one gateway crash, one key change, two refusal toggles, one       *)
(*       cancel, both gateway flights, Retries 4                           *)
(*     ManagedServer.live: liveness; one gateway crash and one cancel, so  *)
(*       orphans of a crashed gateway and of a killed CLI; one gateway     *)
(*       flight, no key change                                             *)
(*     ManagedServer.liveWait: liveness; both gateway flights and one key  *)
(*       change, so the wait of item 12; no crash and no cancel            *)
(*   deep, holding:                                                        *)
(*     ManagedServer.deep: safety; two restarts and two child crashes      *)
(*       added to ManagedServer's events, Retries 4                        *)
(*     ManagedServer.twoTargets: safety; two targets, one gateway crash,   *)
(*       one gateway flight, no other event                                *)
(*     ManagedServer.deepLive: liveness; the events of live and liveWait   *)
(*       together                                                          *)
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
(*   world, which twoTargets checks for safety only. Liveness with a child *)
(*   crash, a refusal toggle or two restarts, two key changes, more than   *)
(*   one cancel or gateway crash, and Retries above 1 under liveness are   *)
(*   not checked.                                                          *)
(*                                                                         *)
(* Switches. The holding configurations set the design.                    *)
(*   GwFlights      1: the gateway runs one flight per target; 2: also a   *)
(*                  second flight under a newer key ("p3")                 *)
(*   SingleFlight   "key": a flight starts only when every other flight    *)
(*                  of the target is idle or runs under an older key       *)
(*                  (tainted); "none": no lock                             *)
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
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Targets,
    MaxRestarts,
    MaxChildCrashes,
    MaxGwCrashes,
    MaxKeyChanges,
    MaxRefusals,
    MaxCancels,
    GwFlights,
    SingleFlight,
    InstanceWait,
    ReapOnStart,
    BoundedRetries,
    Retries,
    CacheRefusal,
    ResetOnReady,
    ClaimBounded

ASSUME /\ MaxRestarts \in Nat \ {0}
       /\ MaxChildCrashes \in Nat
       /\ MaxGwCrashes \in Nat
       /\ MaxKeyChanges \in Nat
       /\ MaxRefusals \in Nat
       /\ MaxCancels \in Nat
       /\ GwFlights \in {1, 2}
       /\ SingleFlight \in {"key", "none"}
       /\ InstanceWait \in BOOLEAN
       /\ ReapOnStart \in BOOLEAN
       /\ BoundedRetries \in BOOLEAN
       /\ Retries \in Nat \ {0}
       /\ CacheRefusal \in BOOLEAN
       /\ ResetOnReady \in BOOLEAN
       /\ ClaimBounded \in BOOLEAN

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

VARIABLES
    gw, gwCrashes, childCrashes, keyChanges, refusals, cancels,
    st, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped

vars == <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, st, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped>>

Partner(f) == IF f = "p1" THEN "p3" ELSE "p1"
LiveFlights(t, n) ==
    CASE n = "s" -> alive[t]["s"]
      [] n = "c" -> alive[t]["p2"]
      [] OTHER -> alive[t]["p1"] + alive[t]["p3"]
OnInst(t, n) == orphan[t][n] + LiveFlights(t, n)
InstanceBusy(t, f) == InstOf(f) = "g" /\ st[t][Partner(f)] \notin Free
Told(t, n) == BoundedRetries /\ tries[t][n] = Retries
MayReap(t, n) == ReapOnStart /\ ~Told(t, n)
Spend(t, n) == IF BoundedRetries THEN tries[t][n] + 1 ELSE tries[t][n]

TypeOK ==
    /\ gw \in {"up", "down"}
    /\ gwCrashes \in 0..MaxGwCrashes
    /\ childCrashes \in 0..MaxChildCrashes
    /\ keyChanges \in 0..MaxKeyChanges
    /\ refusals \in 0..MaxRefusals
    /\ cancels \in 0..MaxCancels
    /\ st \in [Targets -> [Flights -> States]]
    /\ alive \in [Targets -> [Flights -> 0..1]]
    /\ orphan \in [Targets -> [Insts -> 0..3]]
    /\ tries \in [Targets -> [Insts -> 0..Retries]]
    /\ taint \in [Targets -> [Flights -> BOOLEAN]]
    /\ hung \in [Targets -> [Flights -> BOOLEAN]]
    /\ cond \in {"ok", "bad"}
    /\ pre \in [Targets -> {"unknown", "met", "refused"}]
    /\ cc \in [Targets -> 0..MaxRestarts]
    /\ gt \in [Targets -> 0..MaxRestarts]
    /\ reaped \in BOOLEAN

Init ==
    /\ gw = "up" /\ gwCrashes = 0 /\ childCrashes = 0 /\ keyChanges = 0 /\ refusals = 0 /\ cancels = 0
    /\ st = [t \in Targets |-> [f \in Flights |-> "idle"]]
    /\ alive = [t \in Targets |-> [f \in Flights |-> 0]]
    /\ orphan = [t \in Targets |-> [n \in Insts |-> 0]]
    /\ tries = [t \in Targets |-> [n \in Insts |-> 0]]
    /\ taint = [t \in Targets |-> [f \in Flights |-> FALSE]]
    /\ hung = [t \in Targets |-> [f \in Flights |-> FALSE]]
    /\ cond = "ok"
    /\ pre = [t \in Targets |-> "unknown"]
    /\ cc = [t \in Targets |-> 0]
    /\ gt = [t \in Targets |-> 0]
    /\ reaped = TRUE

FailTarget(t) == IF cc[t] >= MaxRestarts THEN "failed" ELSE "backoff"
EndOf(t, f) == IF f = "s" THEN FailTarget(t) ELSE "idle"
Cleared(t, f) == [pre EXCEPT ![t] = IF f = "s" THEN "unknown" ELSE pre[t]]

StartServe(t) ==
    /\ gw = "up" /\ st[t]["s"] \in Gone /\ pre[t] # "refused"
    /\ st' = [st EXCEPT ![t]["s"] = IF pre[t] = "met" THEN "claim" ELSE "pre"]
    /\ pre' = [pre EXCEPT ![t] = "unknown"]
    /\ cc' = [cc EXCEPT ![t] = 0]
    /\ gt' = [gt EXCEPT ![t] = 0]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, alive, orphan, tries, taint, hung, cond, reaped>>

Health(t) ==
    /\ gw = "up" /\ pre[t] = "unknown"
    /\ pre' = [pre EXCEPT ![t] = IF cond = "ok" THEN "met" ELSE IF CacheRefusal THEN "refused" ELSE "unknown"]
    /\ pre' # pre
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, st, alive, orphan, tries, taint, hung, cond, cc, gt, reaped>>

PreOk(t, f) ==
    /\ st[t][f] = "pre" /\ cond = "ok"
    /\ st' = [st EXCEPT ![t][f] = "claim"]
    /\ pre' = [pre EXCEPT ![t] = IF f = "s" THEN "met" ELSE pre[t]]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, alive, orphan, tries, taint, hung, cond, cc, gt, reaped>>

PreBad(t, f) ==
    /\ st[t][f] = "pre" /\ cond = "bad"
    /\ st' = [st EXCEPT ![t][f] = "idle"]
    /\ pre' = [pre EXCEPT ![t] = IF f = "s" /\ CacheRefusal THEN "refused" ELSE pre[t]]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, alive, orphan, tries, taint, hung, cond, cc, gt, reaped>>

ClaimOk(t, f) ==
    LET n == InstOf(f) IN
    /\ st[t][f] = "claim" /\ ~hung[t][f] /\ (OnInst(t, n) = 0 \/ MayReap(t, n))
    /\ st' = [st EXCEPT ![t][f] = "spawn"]
    /\ orphan' = [orphan EXCEPT ![t][n] = 0]
    /\ tries' = [tries EXCEPT ![t][n] = 0]
    /\ alive' = IF n = "g" THEN [alive EXCEPT ![t][Partner(f)] = 0] ELSE alive
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, taint, hung, cond, pre, cc, gt, reaped>>

ClaimKept(t, f) ==
    LET n == InstOf(f) IN
    /\ st[t][f] = "claim" /\ ~hung[t][f] /\ OnInst(t, n) > 0 /\ MayReap(t, n)
    /\ st' = [st EXCEPT ![t][f] = EndOf(t, f)]
    /\ pre' = Cleared(t, f)
    /\ tries' = [tries EXCEPT ![t][n] = Spend(t, n)]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, alive, orphan, taint, hung, cond, cc, gt, reaped>>

ClaimBusy(t, f) ==
    LET n == InstOf(f) IN
    /\ st[t][f] = "claim" /\ ~hung[t][f] /\ OnInst(t, n) > 0 /\ ~MayReap(t, n)
    /\ st' = [st EXCEPT ![t][f] = EndOf(t, f)]
    /\ pre' = Cleared(t, f)
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, alive, orphan, tries, taint, hung, cond, cc, gt, reaped>>

ClaimEnd(t, f) == ClaimOk(t, f) \/ ClaimKept(t, f) \/ ClaimBusy(t, f)

Hang(t, f) ==
    /\ ~ClaimBounded /\ st[t][f] = "claim" /\ ~hung[t][f]
    /\ hung' = [hung EXCEPT ![t][f] = TRUE]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, st, alive, orphan, tries, taint, cond, pre, cc, gt, reaped>>

Spawn(t, f) ==
    /\ st[t][f] = "spawn"
    /\ st' = [st EXCEPT ![t][f] = "ready"]
    /\ alive' = [alive EXCEPT ![t][f] = 1]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, orphan, tries, taint, hung, cond, pre, cc, gt, reaped>>

Ready(t, f) ==
    /\ st[t][f] = "ready" /\ alive[t][f] = 1
    /\ st' = [st EXCEPT ![t][f] = IF f = "s" THEN "running" ELSE "measure"]
    /\ cc' = [cc EXCEPT ![t] = IF f = "s" /\ ResetOnReady THEN 0 ELSE cc[t]]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, alive, orphan, tries, taint, hung, cond, pre, gt, reaped>>

ChildCrash(t, f) ==
    /\ childCrashes < MaxChildCrashes /\ alive[t][f] = 1 /\ st[t][f] \in {"ready", "running", "measure"}
    /\ childCrashes' = childCrashes + 1
    /\ alive' = [alive EXCEPT ![t][f] = 0]
    /\ st' = [st EXCEPT ![t][f] = EndOf(t, f)]
    /\ pre' = Cleared(t, f)
    /\ UNCHANGED <<gw, gwCrashes, keyChanges, refusals, cancels, orphan, tries, taint, hung, cond, cc, gt, reaped>>

ExpirePre(t, f) ==
    /\ st[t][f] = "pre"
    /\ st' = [st EXCEPT ![t][f] = "idle"]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped>>

ExpireSpawn(t, f) ==
    /\ st[t][f] = "spawn"
    /\ st' = [st EXCEPT ![t][f] = EndOf(t, f)]
    /\ pre' = Cleared(t, f)
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, alive, orphan, tries, taint, hung, cond, cc, gt, reaped>>

ExpireReady(t, f) ==
    /\ st[t][f] = "ready"
    /\ alive' = [alive EXCEPT ![t][f] = 0]
    /\ st' = [st EXCEPT ![t][f] = EndOf(t, f)]
    /\ pre' = Cleared(t, f)
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, orphan, tries, taint, hung, cond, cc, gt, reaped>>

ExpireMeasure(t, f) ==
    /\ f \in Probes /\ st[t][f] = "measure"
    /\ st' = [st EXCEPT ![t][f] = "stopping"]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped>>

Expire(t, f) == ExpirePre(t, f) \/ ExpireSpawn(t, f) \/ ExpireReady(t, f) \/ ExpireMeasure(t, f)

TimerFires(t) ==
    /\ st[t]["s"] = "backoff"
    /\ st' = [st EXCEPT ![t]["s"] = "pre"]
    /\ pre' = [pre EXCEPT ![t] = "unknown"]
    /\ cc' = [cc EXCEPT ![t] = cc[t] + 1]
    /\ gt' = [gt EXCEPT ![t] = gt[t] + 1]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, alive, orphan, tries, taint, hung, cond, reaped>>

WindowDone(t) ==
    /\ st[t]["s"] = "running" /\ (cc[t] > 0 \/ gt[t] > 0)
    /\ cc' = [cc EXCEPT ![t] = 0]
    /\ gt' = [gt EXCEPT ![t] = 0]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, st, alive, orphan, tries, taint, hung, cond, pre, reaped>>

ProbeStart(t, f) ==
    /\ f \in Probes /\ st[t][f] = "idle"
    /\ (f \in GwOwned => gw = "up")
    /\ (f = "p3" => GwFlights = 2 /\ st[t]["p1"] # "idle")
    /\ (SingleFlight = "none" \/ \A j \in Probes \ {f} : st[t][j] = "idle" \/ taint[t][j])
    /\ st' = [st EXCEPT ![t][f] = IF InstanceWait /\ InstanceBusy(t, f) THEN "wait" ELSE "pre"]
    /\ taint' = [taint EXCEPT ![t][f] = FALSE]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, alive, orphan, tries, hung, cond, pre, cc, gt, reaped>>

Enter(t, f) ==
    /\ st[t][f] = "wait" /\ ~InstanceBusy(t, f)
    /\ st' = [st EXCEPT ![t][f] = "pre"]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped>>

StopEnd(t, f) ==
    LET n == InstOf(f) IN
    /\ st[t][f] = "stopping"
    /\ \E confirmed \in BOOLEAN :
         orphan' = [orphan EXCEPT ![t][n] = IF confirmed THEN @ ELSE @ + alive[t][f]]
    /\ alive' = [alive EXCEPT ![t][f] = 0]
    /\ st' = [st EXCEPT ![t][f] = "idle"]
    /\ pre' = Cleared(t, f)
    /\ taint' = [taint EXCEPT ![t][f] = FALSE]
    /\ hung' = [hung EXCEPT ![t][f] = FALSE]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, tries, cond, cc, gt, reaped>>

Cancel(t) ==
    /\ cancels < MaxCancels /\ st[t]["p2"] \in {"pre", "claim", "spawn", "ready", "measure"}
    /\ st' = [st EXCEPT ![t]["p2"] = "stopping"]
    /\ cancels' = cancels + 1
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, alive, orphan, tries, taint, hung, cond, pre, cc, gt, reaped>>

CliCrash(t) ==
    /\ cancels < MaxCancels /\ st[t]["p2"] # "idle"
    /\ st' = [st EXCEPT ![t]["p2"] = "idle"]
    /\ orphan' = [orphan EXCEPT ![t]["c"] = @ + alive[t]["p2"]]
    /\ alive' = [alive EXCEPT ![t]["p2"] = 0]
    /\ taint' = [taint EXCEPT ![t]["p2"] = FALSE]
    /\ hung' = [hung EXCEPT ![t]["p2"] = FALSE]
    /\ cancels' = cancels + 1
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, tries, cond, pre, cc, gt, reaped>>

Close ==
    /\ gw = "up"
    /\ gw' = "down"
    /\ st' = [t \in Targets |-> [f \in Flights |->
            IF f \in GwOwned /\ st[t][f] \in {"backoff", "wait"} THEN "idle"
            ELSE IF f \in GwOwned /\ st[t][f] \in {"pre", "claim", "spawn", "ready", "running", "measure"} THEN "stopping"
            ELSE st[t][f] ]]
    /\ pre' = [t \in Targets |-> "unknown"]
    /\ reaped' = FALSE
    /\ UNCHANGED <<gwCrashes, childCrashes, keyChanges, refusals, cancels, alive, orphan, tries, taint, hung, cond, cc, gt>>

Crash ==
    /\ gw = "up" /\ gwCrashes < MaxGwCrashes
    /\ gw' = "down"
    /\ gwCrashes' = gwCrashes + 1
    /\ st' = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN "idle" ELSE st[t][f]]]
    /\ orphan' = [t \in Targets |-> [n \in Insts |-> IF n \in GwInsts THEN orphan[t][n] + LiveFlights(t, n) ELSE orphan[t][n]]]
    /\ alive' = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN 0 ELSE alive[t][f]]]
    /\ taint' = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN FALSE ELSE taint[t][f]]]
    /\ hung' = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN FALSE ELSE hung[t][f]]]
    /\ pre' = [t \in Targets |-> "unknown"]
    /\ cc' = [t \in Targets |-> 0]
    /\ gt' = [t \in Targets |-> 0]
    /\ reaped' = FALSE
    /\ UNCHANGED <<childCrashes, keyChanges, refusals, cancels, tries, cond>>

SupervisorReap ==
    /\ gw = "down" /\ ~reaped
    /\ \A t \in Targets, f \in GwOwned : st[t][f] \in Gone
    /\ reaped' = TRUE
    /\ \E kill \in [Targets -> [GwInsts -> BOOLEAN]] :
         LET Signalled(t, n) == n \in GwInsts /\ orphan[t][n] > 0 /\ ~Told(t, n) IN
         /\ orphan' = [t \in Targets |-> [n \in Insts |-> IF Signalled(t, n) /\ kill[t][n] THEN 0 ELSE orphan[t][n]]]
         /\ tries' = [t \in Targets |-> [n \in Insts |->
                IF ~Signalled(t, n) THEN tries[t][n]
                ELSE IF kill[t][n] THEN 0
                ELSE Spend(t, n) ]]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, refusals, cancels, st, alive, taint, hung, cond, pre, cc, gt>>

GwUp ==
    /\ gw = "down" /\ reaped
    /\ gw' = "up"
    /\ st' = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN "idle" ELSE st[t][f]]]
    /\ hung' = [t \in Targets |-> [f \in Flights |-> IF f \in GwOwned THEN FALSE ELSE hung[t][f]]]
    /\ cc' = [t \in Targets |-> 0]
    /\ gt' = [t \in Targets |-> 0]
    /\ UNCHANGED <<gwCrashes, childCrashes, keyChanges, refusals, cancels, alive, orphan, tries, taint, cond, pre, reaped>>

KeyChange ==
    /\ keyChanges < MaxKeyChanges
    /\ keyChanges' = keyChanges + 1
    /\ taint' = [t \in Targets |-> [f \in Flights |-> taint[t][f] \/ (f \in Probes /\ st[t][f] # "idle")]]
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, refusals, cancels, st, alive, orphan, tries, hung, cond, pre, cc, gt, reaped>>

Refuse ==
    /\ cond = "ok" /\ refusals < MaxRefusals
    /\ cond' = "bad" /\ refusals' = refusals + 1
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, cancels, st, alive, orphan, tries, taint, hung, pre, cc, gt, reaped>>

Fix ==
    /\ cond = "bad" /\ refusals < MaxRefusals
    /\ cond' = "ok" /\ refusals' = refusals + 1
    /\ UNCHANGED <<gw, gwCrashes, childCrashes, keyChanges, cancels, st, alive, orphan, tries, taint, hung, pre, cc, gt, reaped>>

Next ==
    \/ \E t \in Targets :
        \/ StartServe(t) \/ Health(t) \/ WindowDone(t) \/ TimerFires(t) \/ Cancel(t) \/ CliCrash(t)
    \/ \E t \in Targets, f \in Flights :
        \/ PreOk(t, f) \/ PreBad(t, f) \/ ClaimEnd(t, f) \/ Hang(t, f)
        \/ Spawn(t, f) \/ Ready(t, f) \/ ChildCrash(t, f) \/ Expire(t, f)
        \/ StopEnd(t, f) \/ ProbeStart(t, f) \/ Enter(t, f)
    \/ Close \/ Crash \/ GwUp \/ SupervisorReap \/ KeyChange \/ Refuse \/ Fix

Fairness ==
    /\ WF_vars(SupervisorReap)
    /\ \A t \in Targets :
        /\ WF_vars(TimerFires(t))
        /\ \A f \in Flights :
            /\ WF_vars(Expire(t, f))
            /\ WF_vars(StopEnd(t, f))
            /\ WF_vars(Enter(t, f))
            /\ SF_vars(ClaimEnd(t, f))

Spec == Init /\ [][Next]_vars /\ Fairness

(* P1: at most one live child per socket and marker directory (per instance) *)
OneLiveChild == \A t \in Targets, n \in Insts : OnInst(t, n) <= 1

(* P7: a flight runs only beside flights of older keys (one lock per key) *)
OneFlight == \A t \in Targets : \A p, q \in Probes : (p # q /\ st[t][p] # "idle" /\ st[t][q] # "idle") => (taint[t][p] \/ taint[t][q])

(* P5: C1, the cache holds no refusal; every start, restart, exit and stop clears it *)
NoCachedRefusal == \A t \in Targets : pre[t] # "refused"

(* P3: the consecutive failures stay within the budget *)
RestartBudget == \A t \in Targets : cc[t] <= MaxRestarts /\ (st[t]["s"] = "backoff" => gt[t] < MaxRestarts)

(* P8: every waiting state is left *)
WaitsEnd == \A t \in Targets, f \in Flights : (st[t][f] \in Waiting) ~> (st[t][f] \notin Waiting)

(* rev 6: a gone gateway's managed servers are reaped before it counts as stopped *)
GoneGatewayReaped == (gw = "down") ~> reaped

(* P2 and item 15: a claim that recurs is followed by a spawn again and again, *)
(* or the person has been told the survivor's marker (decision 12)              *)
StartAfterOrphanServes == \A t \in Targets, f \in Flights : []<>(st[t][f] = "claim") => []<>(st[t][f] = "spawn" \/ Told(t, InstOf(f)))

=========================================================================
