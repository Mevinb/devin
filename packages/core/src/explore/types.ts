import type { CaptureResult } from "../capture/types.js";
import type { Finding } from "../heuristics/types.js";
import type { DeviceTarget } from "../runtime/types.js";

export type ActionType =
  | "tap"
  | "type"
  | "scroll"
  | "swipe"
  | "press_key"
  | "rotate"
  | "set_posture"
  | "back"
  | "navigate"
  | "done";

export interface TapAction {
  type: "tap";
  elementId?: string;
  selector?: string;
  x?: number;
  y?: number;
  description?: string;
}

export interface TypeAction {
  type: "type";
  elementId?: string;
  selector?: string;
  text: string;
  description?: string;
}

export interface ScrollAction {
  type: "scroll";
  direction: "up" | "down" | "left" | "right";
  amount?: number;
  description?: string;
}

export interface SwipeAction {
  type: "swipe";
  direction: "up" | "down" | "left" | "right";
  amount?: number;
  description?: string;
}

export interface PressKeyAction {
  type: "press_key";
  key: string;
  description?: string;
}

export interface RotateAction {
  type: "rotate";
  orientation: "portrait" | "landscape";
  description?: string;
}

export interface BackAction {
  type: "back";
  description?: string;
}

export interface SetPostureAction {
  type: "set_posture";
  posture: "folded" | "unfolded" | "half-opened";
  description?: string;
}

export interface NavigateAction {
  type: "navigate";
  url: string;
  description?: string;
}

export interface DoneAction {
  type: "done";
  reason: string;
}

export type AgentAction =
  | TapAction
  | TypeAction
  | ScrollAction
  | SwipeAction
  | PressKeyAction
  | RotateAction
  | SetPostureAction
  | BackAction
  | NavigateAction
  | DoneAction;

export interface ExplorationStep {
  stepIndex: number;
  action: AgentAction;
  stateBefore: string;
  stateAfter: string;
  timestamp: string;
  screenshotPath?: string;
  /** The action could not be executed on the pilot device. */
  failed?: boolean;
  details?: string;
}

export interface DiscoveredState {
  stateId: string;
  name: string;
  fingerprint: string;
  url: string;
  stepIndex: number;
  captureResult: CaptureResult;
  findings: Finding[];
  annotatedPath?: string;
  /** Actions (human readable) that reach this state from the start URL. */
  trace?: string[];
}

export interface ExplorationTrace {
  traceId: string;
  pilotTarget: DeviceTarget;
  steps: ExplorationStep[];
  discoveredStates: DiscoveredState[];
  startTime: string;
  endTime: string;
  /** Original start URL, used to rebase navigation when replay uses a new server. */
  startUrl?: string;
}

export type ReplayableTrace = Omit<ExplorationTrace, "discoveredStates"> & {
  discoveredStates: Array<Pick<DiscoveredState, "stateId" | "name" | "fingerprint" | "url">>;
};

export interface ExploreConfig {
  maxSteps: number;
  maxStates: number;
  pilotDevice?: string;
  allowExternalNavigation?: boolean;
  /** Extra HTTP(S) origins allowed for navigation; the initial origin is always allowed. */
  allowedOrigins?: string[];
  allowDestructive?: boolean;
  disallowedKeywords?: string[];
  systemPrompt?: string;
  model?: string;
  testCredentials?: Record<string, string>;
  /** Run the full agent on every device instead of pilot-then-replay. */
  perDevice?: boolean;
  /** Max agent actions to recover one failed replay step. */
  maxRecoverySteps?: number;
  /** Force the deterministic offline agent (tests / no API key). */
  useMockAgent?: boolean;
  maxMinutes?: number;
}

export interface ExploreProgressEvent {
  phase: "pilot" | "replay" | "recover" | "analyze";
  deviceId: string;
  step: number;
  action?: AgentAction;
  stateId?: string;
  stateName?: string;
  screenshotPath?: string;
  agentCalls: number;
  tokensUsed?: number;
  message?: string;
}
