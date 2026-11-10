// Every value the agent CLI (packages/cli) imports from shared, re-exported
// from the module that defines it. The CLI imports values only from here
// (types may still come from the root index: `import type` is erased), so its
// bundle never evaluates the root index, which pulls in ~80 modules the CLI
// does not use. An agent `raft` call is a fresh process each time, so what it
// loads is paid on every call. cli/src/sharedImports.test.ts enforces the rule.

export { actionCardActionSchema, validateActionCardAction } from "./actionCards";
export { joinRaftChannelByTarget } from "./agentApiChannelJoin";
export { agentApiClientResultFromRaw, createAgentApiClient } from "./agentApiClient";
export {
  AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_MESSAGE,
  AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_NEXT_ACTION,
  AGENT_API_EVENTS_ACK_HEADER,
  AGENT_API_EVENTS_ACK_LEASE,
  AGENT_API_INBOX_VIEWS,
  AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT,
  AGENT_API_MESSAGE_SEARCH_MAX_LIMIT,
  AGENT_API_USER_CHANNELS_DEFAULT_LIMIT,
  AGENT_API_USER_CHANNELS_MAX_LIMIT,
  agentApiContract,
  buildLegacyAgentApiPath,
  getAgentApiResponseKind,
  parseAgentApiResponse,
} from "./agentApiContract";
export { buildAgentApiRawRoutePath, requestAgentApiRawRoute } from "./agentApiRawClient";
export { isThirdPartyEventsTarget, THIRD_PARTY_EVENTS_LABEL } from "./agentInbox";
export { formatAgentInboxAppItems } from "./agentInboxApp";
export {
  formatAgentAttachmentSuffix,
  formatAgentInboxHint,
  formatAgentMessageLine,
  formatAgentMessages,
  formatAgentMessageTarget,
  formatAgentSenderHandle,
  formatAgentTaskAssigneeSuffix,
  formatAgentTaskCurrentProjection,
  formatSenderHandleText,
  indentAgentBodyContinuationLines,
} from "./agentMessageText";
export { formatAgentAppConfig } from "./agentOps/apps";
export { CONTEXT_GENERATION_FILENAME, CONTEXT_GENERATION_MAX_BYTES } from "./agentOps/contextGeneration";
export {
  CLI_READ_STATE_FILENAME,
  CLI_READ_STATE_NAMESPACE,
  configuredCliReadStateBase,
  isLocalStateAgentId,
} from "./agentOps/latestReadThread";
export {
  channelCardRev,
  elideSeenSenderDescriptions,
  PASSIVE_RESOURCES,
  peerCardId,
  peerCardRev,
  renderChannelCard,
  renderPeerCard,
  renderSendAttachment,
  senderObservationId,
} from "./agentOps/passiveResources";
export { configuredRaftHome, defaultRaftHomeDirname } from "./agentOps/raftHome";
export { userInfo } from "./agentOps/server";
export {
  isExternalAgentActivityLegacyStatus,
  isRaftAgentStatus,
  RAFT_AGENT_STATUS_DETAIL_LIMIT,
} from "./agentStatusStandard";
export {
  formatAgentAttachmentComments,
  formatAgentAttachmentDownloaded,
  formatAgentAttachmentUploaded,
} from "./agentText/attachments";
export {
  formatAgentHold,
  formatAgentReviewerIsolationHold,
  redactAgentHoldForReviewerIsolation,
} from "./agentText/hold";
export { formatAgentThreadTargetCheck } from "./agentText/threadTarget";
export { formatAgentKnowledgeSearchResults, formatAgentKnowledgeStdout } from "./agentText/knowledge";
export {
  AGENT_MENTION_PENDING_MAX_LIMIT,
  formatAgentMentionActionResults,
  formatAgentMentionNotifyRecoveryCommand,
  formatAgentPendingMentionActions,
  formatAgentSenderMentionDeliveries,
  normalizeAgentMentionActionResults,
  normalizeAgentPendingMentionActions,
  normalizeAgentUnresolvedMentionHandles,
  toAgentSenderPendingMentionAction,
  toAgentSenderUnresolvedMentionWarning,
} from "./agentText/mentions";
export {
  formatAgentSearchResults,
  neutralizeAgentRaftRefLiterals,
  renderAgentSearchPreviewText,
} from "./agentText/search";
export {
  agentChannelRef,
  formatAgentChannelInfo,
  formatAgentChannelMembers,
  formatAgentServerAgents,
  formatAgentServerChannels,
  formatAgentServerHumans,
  formatAgentServerInfo,
  formatAgentServerSummary,
  formatAgentUserInfo,
} from "./agentText/server";
export {
  formatAgentClaimResults,
  formatAgentMyTaskList,
  formatAgentTaskAmended,
  formatAgentTaskAssigned,
  formatAgentTaskConverted,
  formatAgentTaskDeleted,
  formatAgentTaskHistory,
  formatAgentTaskList,
  formatAgentTasksCreated,
  formatAgentTaskShow,
  formatAgentTaskStatusUpdated,
  formatAgentTaskUnclaimed,
} from "./agentText/tasks";
export { formatAgentProfile, formatAgentThreadList } from "./agentText/threadsProfile";
export { asMessageId } from "./brandedIds";
export { AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION } from "./capabilityInventories";
export { currentDate, currentTimeMs, setClockTimeout } from "./clock";
export { createDaemonApiClient } from "./daemonApiClient";
export { buildDaemonApiRawRoutePath } from "./daemonApiRawClient";
export { formatDmPeerRef, isDmPeerKind, parseDmPeerRef } from "./dmPeerRef";
export {
  EXTERNAL_AGENT_ACTIVITY_DRAIN_SCHEMA,
  EXTERNAL_AGENT_ACTIVITY_EVENT_SCHEMA,
  EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
  EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT,
  EXTERNAL_AGENT_ACTIVITY_TOOL_NAME_LIMIT,
} from "./externalAgentActivity";
export {
  EXTERNAL_AGENT_COMMS_PROTOCOL_VERSION,
  EXTERNAL_AGENT_PROOF_SCHEMA_VERSION,
  EXTERNAL_AGENT_WAKE_EVENT_SCHEMA,
  EXTERNAL_RUNTIME_INTEGRATION_MANIFEST_SCHEMA,
  validateExternalAgentWakeEventEnvelope,
  validateExternalRuntimeIntegrationManifest,
} from "./externalAgentIntegration";
export {
  MANUAL_CONTEXT_CAPABILITY,
  MANUAL_INDEX_COMMAND,
  RAFT_CLIENT_CAPABILITIES_HEADER,
  validateKnowledgeContext,
} from "./knowledgeContext";
export { canonicalizeOAuthClientCategory, OAUTH_CLIENT_CATEGORIES } from "./oauthClientCategories";
export { parseRaftRefTarget, structuredRaftMentionStillAppears } from "./raftRefs";
export { TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU } from "./taskClaimReason";
export { errorClassOf } from "./tracing/index";
export { formatUtcTimestamp } from "./utcTimestamp";

export { assertPrivacyServiceUrl, privacyModeEnabled, rejectVendorDispatch } from "./privacyMode";
