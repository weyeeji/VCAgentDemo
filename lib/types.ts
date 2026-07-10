export type AgentRole = "investor" | "founder";
export type LayerKey = "platform" | "tools" | "user" | "task" | "dynamic";

export interface PromptLayer {
  enabled: boolean;
  content: string;
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

export interface AppConfig {
  investor: AgentProfile;
  founder: AgentProfile;
  settings: RunSettings;
  evaluatorPrompt: string;
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
}

export interface SimulationRecord {
  conversationId: string;
  createdAt: string;
  completedAt: string | null;
  configVersion: string | null;
  configSnapshot: AppConfig;
  promptSnapshots: { investor: string; founder: string };
  messages: TurnMessage[];
  results: {
    public: unknown | null;
    investorMemory: unknown | null;
    founderMemory: unknown | null;
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
