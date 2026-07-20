export type AgentRole = "investor" | "founder";
export type LayerKey = "platform" | "tools" | "user" | "task" | "dynamic";

export type MemoryKind = "fact" | "preference" | "decision" | "constraint" | "note";
export type MemoryVerification = "confirmed" | "unverified" | "conflicted";
export type MemoryStatus = "active" | "superseded" | "archived" | "deleted";
export type AgentTaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";

export interface AgentMemoryItem {
  id: string;
  scopeId: string;
  agentId: string;
  agentRole: AgentRole;
  kind: MemoryKind;
  title: string;
  content: string;
  verification: MemoryVerification;
  status: MemoryStatus;
  priority: number;
  counterpartyId: string | null;
  sourceType: string;
  sourceId: string | null;
  metadata: Record<string, unknown>;
  supersedesId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface AgentTaskItem {
  id: string;
  scopeId: string;
  agentId: string;
  agentRole: AgentRole;
  title: string;
  description: string;
  status: AgentTaskStatus;
  priority: number;
  dueAt: string | null;
  counterpartyId: string | null;
  sourceMemoryId: string | null;
  sourceType: string;
  sourceId: string | null;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type AgentActionType =
  | "memory.create"
  | "memory.update"
  | "memory.archive"
  | "memory.restore"
  | "task.create"
  | "task.update"
  | "task.cancel";

export interface AgentActionProposal {
  id: string;
  type: AgentActionType;
  reason: string;
  memoryId?: string;
  taskId?: string;
  input: Record<string, unknown>;
}

export interface WorkingContextSnapshot {
  agentId: string;
  counterpartyId: string | null;
  generatedAt: string;
  version: string;
  memories: AgentMemoryItem[];
  tasks: AgentTaskItem[];
  promptText: string;
}

export interface PromptVariant {
  id: string;
  name: string;
  content: string;
  createdAt: string;
}

export interface PromptLayer {
  enabled: boolean;
  content: string;
  variants: PromptVariant[];
}

export type PromptLayers = Record<LayerKey, PromptLayer>;

export interface AgentProfile {
  id: string;
  role: AgentRole;
  fields: Record<string, string>;
  prompts: PromptLayers;
}

export interface UserProfileRecord {
  /** 资料 ID 同时也是对外 Agent ID。 */
  id: string;
  role: AgentRole;
  name: string;
  kind: "preset" | "custom";
  fields: Record<string, string>;
  dynamicLayer: PromptLayer;
  fileIds: string[];
  memory: unknown | null;
  dailyReport: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export type UserProfileLibrary = Record<AgentRole, UserProfileRecord[]>;

export interface RunSettings {
  maxRounds: number;
  firstSpeaker: AgentRole;
  maxTokens: number;
  allowEarlyEnd: boolean;
  generatePublicResult: boolean;
  generateMemories: boolean;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
}

export interface DailyReportConfig {
  taskPrompt: string;
  dynamicPrompt: string;
  taskVariants: PromptVariant[];
  dynamicVariants: PromptVariant[];
  maxTokens: number;
}

export interface AppConfig {
  investor: AgentProfile;
  founder: AgentProfile;
  settings: RunSettings;
  evaluatorPrompt: string;
  directChatTaskPrompts: Record<AgentRole, string>;
  memoryPrompts: Record<AgentRole, string>;
  jsonRepairPrompt: string;
  dailyReport: Record<AgentRole, DailyReportConfig>;
}

export interface TurnControl {
  suggest_end: boolean;
  end_reason:
    | "max_rounds"
    | "sufficient_information"
    | "clear_match"
    | "clear_mismatch"
    | "explicit_rejection"
    | "missing_critical_information"
    | "safety_or_compliance"
    | "manual_stop"
    | "no_new_information"
    | null;
  information_sufficient: boolean;
}

export interface TurnMessage {
  id: string;
  role: AgentRole;
  agentName: string;
  round: number;
  content: string;
  control: TurnControl;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  usageEstimated: boolean;
  estimatedCost: number;
  createdAt: string;
}

export interface DemoAgentCard {
  format: "a2a-inspired";
  referenceVersion: "1.0";
  agentId: string;
  name: string;
  description: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    extendedAgentCard: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
  }>;
  publicIdentity: {
    role: AgentRole;
    claims: Record<string, string>;
  };
}

export interface DebugCall {
  id: string;
  type:
    | "investor_turn"
    | "founder_turn"
    | "public_evaluation"
    | "investor_memory"
    | "founder_memory"
    | "investor_daily_report"
    | "founder_daily_report"
    | "investor_direct_chat"
    | "founder_direct_chat"
    | "json_repair";
  actor: "investor" | "founder" | "evaluator" | "system";
  round: number | null;
  systemPrompt: string;
  layerStates: Record<string, boolean>;
  profileSnapshot: Record<string, string> | null;
  messages: Array<{ role: string; content: string }>;
  rawResponse: string;
  parsedResult: unknown;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usageEstimated: boolean;
  estimatedCost: number;
  success: boolean;
  error: string | null;
  toolCalls?: ToolExecutionTrace[];
}

export interface AgentFileRecord {
  id: string;
  agentRole: AgentRole;
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string;
  status: "processing" | "ready" | "error";
  error: string | null;
  extractedChars: number;
  chunkCount: number;
  createdAt: string;
}

export interface FileSearchResult {
  fileId: string;
  fileName: string;
  chunkId: string;
  location: string;
  content: string;
  score: number;
}

export interface PrivateFileToolExecutionTrace {
  tool: "search_private_files";
  agentRole: AgentRole;
  query: string;
  topK: number;
  durationMs: number;
  results: FileSearchResult[];
  error: string | null;
}

export interface MemorySearchToolExecutionTrace {
  tool: "search_agent_memory";
  agentRole: AgentRole;
  query: string;
  topK: number;
  includeArchived: boolean;
  durationMs: number;
  results: Array<Pick<AgentMemoryItem,
    "id" | "kind" | "title" | "content" | "verification" | "status" | "priority" | "counterpartyId" | "version" | "updatedAt"
  >>;
  error: string | null;
}

export type ToolExecutionTrace = PrivateFileToolExecutionTrace | MemorySearchToolExecutionTrace;

export interface DirectChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  callId: string | null;
  inputTokens: number;
  outputTokens: number;
  usageEstimated: boolean;
  estimatedCost: number;
  toolCalls: ToolExecutionTrace[];
  /** Agent 自主选择的记忆或任务变更；新版会在回复成功后自动执行。 */
  proposedActions?: AgentActionProposal[];
  actionStatus?: "pending" | "applied" | "rejected" | "failed";
  actionError?: string | null;
  actionsAppliedAt?: string | null;
  workingContextSnapshot?: WorkingContextSnapshot | null;
}

export interface DirectChatThread {
  id: string;
  agentRole: AgentRole;
  createdAt: string;
  updatedAt: string;
  agentSnapshot: AgentProfile;
  settingsSnapshot: RunSettings;
  promptSnapshot: string;
  jsonRepairPromptSnapshot: string;
  /** @deprecated 仅用于兼容旧直聊记录；新建用户直聊不再注入对方 Agent Card。 */
  counterpartyAgentCardSnapshot?: DemoAgentCard;
  fileSnapshots: AgentFileRecord[];
  messages: DirectChatMessage[];
  debugCalls: DebugCall[];
  errors: string[];
}

export interface DirectChatRoleState {
  activeThreadId: string | null;
  threads: DirectChatThread[];
}

export type DirectChatState = Record<AgentRole, DirectChatRoleState>;

export interface RelationshipRecentTurn {
  role: AgentRole;
  agentName: string;
  round: number;
  content: string;
  createdAt: string;
}

export interface AgentRelationship {
  id: string;
  investorAgentId: string;
  founderAgentId: string;
  episodeCount: number;
  lastConversationId: string | null;
  summary: string;
  recentTurns: RelationshipRecentTurn[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RelationshipContinuationSnapshot {
  relationshipId: string;
  episodeNumber: number;
  previousConversationId: string | null;
  summary: string;
  recentTurns: RelationshipRecentTurn[];
  relationshipVersion: number;
}

export interface SimulationRecord {
  conversationId: string;
  /** 旧记录可能没有连续对接字段。 */
  relationshipId?: string | null;
  parentConversationId?: string | null;
  episodeNumber?: number;
  continuationSnapshot?: RelationshipContinuationSnapshot | null;
  replayOfConversationId?: string | null;
  createdAt: string;
  completedAt: string | null;
  configVersion: string | null;
  configSnapshot: AppConfig;
  agentCardSnapshots: Record<AgentRole, DemoAgentCard>;
  promptSnapshots: { investor: string; founder: string };
  fileSnapshots: Record<AgentRole, AgentFileRecord[]>;
  memorySnapshots: Record<AgentRole, unknown | null>;
  messages: TurnMessage[];
  results: {
    public: unknown | null;
    investorMemory: unknown | null;
    founderMemory: unknown | null;
    dailyReports: Record<AgentRole, unknown | null>;
    rawErrors: Record<string, { raw: string; error: string }>;
  };
  debugCalls: DebugCall[];
  stats: { inputTokens: number; outputTokens: number; estimatedCost: number };
  endReason: string | null;
  errors: string[];
}

export interface SavedVersion {
  id: string;
  name: string;
  createdAt: string;
  config: AppConfig;
}

export interface WorkspaceState {
  schemaVersion: 2;
  config: AppConfig;
  profiles: UserProfileLibrary;
  versions: SavedVersion[];
  records: SimulationRecord[];
  directChats: DirectChatState;
  memories: Record<AgentRole, unknown | null>;
  dailyReports: Record<AgentRole, unknown | null>;
  activeVersion: string | null;
  activeRecordId: string | null;
  updatedAt: string | null;
}

export type WorkspaceStatePatch = Partial<Pick<WorkspaceState,
  "config" | "profiles" | "versions" | "records" | "directChats" | "memories" | "dailyReports" | "activeVersion" | "activeRecordId"
>>;

export type FieldInputType = "text" | "textarea" | "select" | "multiselect" | "date";
export type FieldVisibility = "public" | "selective" | "private";

export interface FieldDefinition {
  key: string;
  label: string;
  input: FieldInputType;
  required: boolean;
  visibility: FieldVisibility;
  options?: string[];
  exclusiveOptions?: string[];
  maxSelections?: number;
  placeholder?: string;
  help?: string;
}
