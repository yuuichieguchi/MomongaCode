export {
  FAKE_DETERMINISTIC_REPLY,
  FAKE_REASONING_WORD,
  FAKE_GUARDRAIL_ERROR,
  FM_CONTEXT_OVERFLOW_ERROR,
  FM_GUARDRAIL_ERROR,
  FM_UNSUPPORTED_GUIDE_ERROR,
  FAKE_PAYLOAD_TOO_LARGE_ERROR,
  IMAGE_UNSUPPORTED_MESSAGE,
  JSON_OBJECT_UNSUPPORTED_MESSAGE,
  JSON_SCHEMA_UNSUPPORTED_MESSAGE,
  STOP_UNSUPPORTED_MESSAGE,
  TOOLS_UNSUPPORTED_MESSAGE,
  countFakeRequestTokens,
  fakeUsageOfRequest,
  countFakeTokens,
  isValidAtIndex,
  startFakeChatCompletions,
} from './fake-chat-completions.ts';
export type {
  FakeChatCompletionsOptions,
  FakeChatCompletionsServer,
  FakeFixedUsage,
  FakeUsageOfRequest,
  FakeRoute,
  FakeScenario,
  FakeResponseHold,
  FakeScriptedReply,
  FakeStreamChunk,
  RecordedRequest,
} from './fake-chat-completions.ts';
export { inlinedSubsetRefusalOf, strictClosedRefusalOf } from './dialect-checkers.ts';
export { generateInstance, collectAllowedNames, findUsedKeywords } from './schema-instance.ts';
export type { JsonSchema, InstancePreferences } from './schema-instance.ts';
export { LOCK_HOLDER_MAIN, startLockHolder } from './lock-holder.ts';
export { LSOF_PATH } from './lsof.ts';
export { EMPTY_SYMLINK_SUPPORTED } from './empty-symlink.ts';
export { createFakeKernelLock } from './fake-kernel-lock.ts';
export type { FakeKernelLock, FakeKernelLockOptions } from './fake-kernel-lock.ts';
export { createFakeClock } from './fake-clock.ts';
export type { FakeClock } from './fake-clock.ts';
export {
  FIXTURE_RUN_ID,
  FIXTURE_SESSION_ID,
  RECORDED_RUNS,
  approvalWaitResumeRun,
  cancelRun,
  compactionRejectedAtBuildRun,
  compactionRejectedAtStreamRun,
  compactionRun,
  evictionAndRejectionRun,
  inheritedRun,
  fixtureCompactionContent,
  fixtureCompactionItem,
  fixtureSubjectDigest,
  finalAnswerRun,
  materializeEvents,
  toolRoundTripRun,
  usageChargedRun,
} from './run-event-fixtures.ts';
export type { RecordedRun } from './run-event-fixtures.ts';
export { drivenReapTiming, fakeReapTiming } from './fake-reap-timing.ts';
export { createFakeTimers } from './fake-timers.ts';
export { DEFAULT_DRIVE_MAX_STEPS, driveFakeTime } from './drive-fake-time.ts';
export type { DriveFakeTimeOptions } from './drive-fake-time.ts';
export type { FakeTimers, PendingTimer } from './fake-timers.ts';
export { afterMicrotasks, waitFor } from './wait-for.ts';
export { createRealWorkScope, quiesce, settleRealWork, waitForRealWork } from './real-work.ts';
export type { RealWorkScope } from './real-work.ts';
export type { WaitForOptions } from './wait-for.ts';
export { OPEN_RESPONSES_SPEC_URL, createOpenResponsesValidator, loadOpenResponsesSpec } from './open-responses-schema.ts';
export type { OpenResponsesSpec, OpenResponsesValidator, SchemaCheck } from './open-responses-schema.ts';
export { responseResource, textResponseEvents, usageOf } from './open-responses-fixtures.ts';
export type { ResponseResourceInput, TextResponseScript } from './open-responses-fixtures.ts';
export { DEFAULT_SCRIPTED_CAPABILITIES, ScriptedUpstreamError, createScriptedAdapter } from './scripted-adapter.ts';
export type {
  RecordedAdapterCall,
  RecordedCompactCall,
  RecordedCountCall,
  ScriptedAdapter,
  ScriptedAdapterOptions,
  ScriptedCallPlan,
  ScriptedFailure,
} from './scripted-adapter.ts';
export {
  LEGACY_FIXTURE_PROTOCOL_VERSION,
  LEGACY_FIXTURE_TOOL_NAMES,
  MCP_LEGACY_SERVER_PATH,
  MCP_MODERN_SERVER_PATH,
  MCP_RAW_STDIO_SERVER_PATH,
  MODERN_FIXTURE_GRANDCHILD_ENV,
  MODERN_FIXTURE_AUDIO_BYTES,
  MODERN_FIXTURE_BLOB_BYTES,
  MODERN_FIXTURE_HOSTILE_DESCRIPTION,
  MODERN_FIXTURE_IMAGE_BYTES,
  MODERN_FIXTURE_LIST_TTL_ENV,
  MODERN_FIXTURE_LONG_TOOL_NAME,
  MODERN_FIXTURE_OVERSIZED_DESCRIPTION_CHARS,
  MODERN_FIXTURE_PAGE_SIZE,
  MODERN_FIXTURE_PROTOCOL_VERSION,
  MODERN_FIXTURE_RECORD_ENV,
  MODERN_FIXTURE_SETSID_GRANDCHILD_ENV,
  MODERN_FIXTURE_STDERR_ENV,
  MODERN_FIXTURE_TOOL_NAMES,
} from './mcp-fixtures.ts';
export {
  FIXTURE_EXTRA_TOOLS_ENV,
  FIXTURE_HOSTILE_TITLE,
  FIXTURE_HOSTILE_TITLE_DESCRIPTION,
  FIXTURE_ID_INPUT_SCHEMA_ID,
  FIXTURE_ID_OUTPUT_SCHEMA_ID,
  nestedNotSchema,
} from './mcp-fixtures.ts';
export type { ModernFixtureRecord } from './mcp-fixtures.ts';
export { killGroupsForCleanup, killPidsForCleanup, stopSupervisorHolder } from './process-groups.ts';
export { FAKE_OS_BUILD, createFakeFm, fakeExec } from './fake-fm.ts';
export type { CreateFakeFmOptions, FakeExecResult, FakeFm, FakeFmConfig } from './fake-fm.ts';
export {
  BUILT_BINARY_TEST_TIMEOUT_MS,
  DAEMON_PROCESS_TEST_TIMEOUT_MS,
  REAL_PROCESS_TEST_TIMEOUT_MS,
  TEMP_DIR_PREFIX,
  TEST_HEARTBEAT_MS,
  TEST_RUN_ENV,
  assertHomeSocketBudget,
  registerCleanup,
  spawnTracked,
  tempDirPrefixFor,
  testRunToken,
  withTempDir,
} from './test-support.ts';
export type { CleanupContext, TempDirOptions, TrackedChild } from './test-support.ts';
export { createFakeEntryIo, parseJsonLines } from './fake-entry-io.ts';
export type { FakeEntryIo, FakeEntryIoOptions, JsonLine } from './fake-entry-io.ts';
export { DAEMON_BIN_EXIT_DEADLINE_MS, DAEMON_BIN_READY_DEADLINE_MS, readJsonLinesFile, startDaemonBin } from './daemon-bin.ts';
export type { DaemonBin } from './daemon-bin.ts';
export { APPLE_PROGRAMS, FAKE_LEASE, TEST_SEARCH_PATH, fakePolicyFilesystem, hostFilesystemOf, isWritableFor, protectedSetWith } from './fake-policy-filesystem.ts';
export { UNBOUNDED_OUTPUT_FIT } from './fake-output-fit.ts';
export type { FakeGlobDeadline, FakeGlobExpansion, FakePolicyFilesystem, FakePolicyFilesystemLayout, FakeProgramResolution, FakeResolveCall, HostOf, RecordingPolicyFilesystem } from './fake-policy-filesystem.ts';
export { OTLP_SPAN_KIND, decodeOtlpSpans, otlpAttributes, startOtlpCollector } from './otlp-collector.ts';
export type { CollectedOtlpRequest, DecodedOtlpSpan, OtlpCollector, OtlpCollectorResponse } from './otlp-collector.ts';
export { startFakeSseUpstream } from './fake-sse-upstream.ts';
export type {
  FakeSseFrame,
  FakeUpstreamOptions,
  FakeUpstreamReply,
  FakeUpstreamServer,
  RecordedUpstreamRequest,
} from './fake-sse-upstream.ts';
export {
  FAKE_ANTHROPIC_PATH,
  FAKE_ANTHROPIC_VERSION,
  anthropicErrorBody,
  anthropicErrorEvent,
  anthropicErrorReply,
  anthropicMessageEnd,
  anthropicMessageStart,
  anthropicPing,
  anthropicStream,
  anthropicTextBlock,
  anthropicTextReply,
  anthropicToolUseBlock,
  anthropicToolUseReply,
  anthropicCountTokensReply,
  anthropicBlockStart,
  anthropicBlockDelta,
  anthropicBlockStop,
  FAKE_ANTHROPIC_COUNT_TOKENS_PATH,
  startFakeAnthropic,
} from './fake-anthropic.ts';
export type { AnthropicUsage, FakeAnthropicOptions } from './fake-anthropic.ts';
export {
  DONE_FRAME,
  FAKE_OPEN_RESPONSES_PATH,
  functionCallEvents,
  messageEvents,
  numberedFrames,
  openResponsesErrorBody,
  openResponsesErrorFrame,
  openResponsesErrorReply,
  openResponsesStream,
  openResponsesTextReply,
  openResponsesToolCallReply,
  openingEvents,
  refusalEvents,
  startFakeOpenResponses,
  terminalEvent,
} from './fake-open-responses.ts';
export type { FakeOpenResponsesOptions, TerminalSpec } from './fake-open-responses.ts';
export { createFakeSecretStore, createFakeSecurityPort } from './fake-secrets.ts';
export type { FakeSecretStore, FakeSecurityPort } from './fake-secrets.ts';
export { readBody, sendJson, startLoopbackServer } from './loopback-http.ts';
export type { LoopbackHandler, LoopbackServer } from './loopback-http.ts';
export { startMcpOauthFixture } from './mcp-oauth-fixture.ts';
export type { AuthorizeMode, McpOauthFixture, OauthFixtureRecord, TokenVerdict } from './mcp-oauth-fixture.ts';
export {
  HTTP_FIXTURE_LEGACY_VERSION,
  HTTP_FIXTURE_MODERN_VERSION,
  HTTP_FIXTURE_RECONNECT_DELAY_MS,
  HTTP_FIXTURE_TASKS_EXTENSION,
  nestedArraysJsonText,
  nestedNotJsonText,
  startMcpHttpFixture,
} from './mcp-http-fixture.ts';
export type { FixtureNote, McpHttpFixture, McpHttpFixtureEra, McpHttpFixtureOptions, RecordedHttpRequest } from './mcp-http-fixture.ts';
export { ENGINE_FAILURE_KEY, ENGINE_FAILURE_MESSAGE, engineFailureSchema, injectEngineFailure } from './engine-failure.ts';
