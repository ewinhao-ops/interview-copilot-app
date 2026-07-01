export type Speaker = "candidate" | "interviewer";

export type TranscriptSource = "speech" | "manual";

export type AnalysisSource = "ai" | "local-rule";

export interface CandidateProfile {
  name: string;
  role: string;
  sessionTitle: string;
  status: string;
}

export interface TranscriptEntry {
  id: string;
  speaker: Speaker;
  text: string;
  createdAt: string;
  source: TranscriptSource;
  questionId?: string;
}

export interface AnalysisSettings {
  provider: "deepseek" | "mimo" | "openai-compatible" | "local";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  speechProvider?: "aliyun" | "openai-compatible";
  speechApiKey?: string;
  speechModel?: string;
  speechEndpoint?: string;
}

export interface PlainLanguageInsight {
  term: string;
  explanation: string;
  whyItMatters: string;
}

export interface FollowUpSuggestion {
  question: string;
  intent: string;
  signal: "A" | "B" | "C" | "D" | "unknown";
  priority: "high" | "medium" | "low";
}

export interface HrEvaluation {
  summary: string;
  recommendation: string;
  strengths: string[];
  concerns: string[];
  score: string;
}

export interface AnalysisBlock {
  id: string;
  transcriptEntryId?: string;
  createdAt: string;
  source: AnalysisSource;
  summary: string;
  nextBestQuestion: string;
  plainLanguage: PlainLanguageInsight[];
  followUps: FollowUpSuggestion[];
  riskSignals: string[];
  hrEvaluation: HrEvaluation;
}

export interface AnalyzeRequest {
  profile: CandidateProfile;
  transcript: TranscriptEntry[];
  settings: AnalysisSettings;
}

export interface AnalyzeResponse {
  block: AnalysisBlock;
}

export interface CorrectTranscriptRequest {
  rawText: string;
  settings: AnalysisSettings;
  recentTranscript: TranscriptEntry[];
}

export interface CorrectTranscriptResponse {
  speaker: Speaker;
  shouldRecord: boolean;
  correctedText: string;
  reason: string;
}

export interface ExportMarkdownRequest {
  markdown: string;
  suggestedName: string;
}

export interface ExportMarkdownResponse {
  canceled: boolean;
  path?: string;
}

export interface TranscribeAudioRequest {
  dataBase64: string;
  mimeType: string;
  language?: string;
  sampleRate?: number;
  settings: AnalysisSettings;
}

export interface TranscribeAudioResponse {
  text: string;
  error?: string;
}

export interface AppDefaults {
  baseUrl: string;
  model: string;
  hasEnvApiKey: boolean;
  provider: "deepseek" | "mimo" | "openai-compatible" | "local";
  speechProvider: "aliyun" | "openai-compatible";
  speechModel: string;
  speechEndpoint: string;
  hasDashScopeApiKey: boolean;
}
