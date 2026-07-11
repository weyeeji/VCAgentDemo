export type AgentRole = "investor" | "founder";
export type LayerKey = "platform" | "tools" | "user" | "task" | "dynamic";

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

export interface ToolExecutionTrace {
  tool: "search_private_files";
  agentRole: AgentRole;
  query: string;
  topK: number;
  durationMs: number;
  results: FileSearchResult[];
  error: string | null;
}

export interface SimulationRecord {
  conversationId: string;
  createdAt: string;
  completedAt: string | null;
  configVersion: string | null;
  configSnapshot: AppConfig;
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
  schemaVersion: 1;
  config: AppConfig;
  versions: SavedVersion[];
  records: SimulationRecord[];
  memories: Record<AgentRole, unknown | null>;
  dailyReports: Record<AgentRole, unknown | null>;
  activeVersion: string | null;
  activeRecordId: string | null;
  updatedAt: string | null;
}

export type WorkspaceStatePatch = Partial<Pick<WorkspaceState,
  "config" | "versions" | "records" | "memories" | "dailyReports" | "activeVersion" | "activeRecordId"
>>;

export type FieldInputType = "text" | "textarea" | "select" | "multiselect" | "date";

export interface FieldDefinition {
  key: string;
  label: string;
  input: FieldInputType;
  required: boolean;
  options?: string[];
  exclusiveOptions?: string[];
  maxSelections?: number;
  placeholder?: string;
  help?: string;
}
