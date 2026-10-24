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
}

export interface DiscoveredState {
  stateId: string;
  name: string;
  fingerprint: string;
  url: string;
  stepIndex: number;
  captureResult: CaptureResult;
  findings: Finding[];
}

export interface ExplorationTrace {
  traceId: string;
  pilotTarget: DeviceTarget;
  steps: ExplorationStep[];
  discoveredStates: DiscoveredState[];
  startTime: string;
  endTime: string;
}

export interface ExploreConfig {
  maxSteps: number;
  maxStates: number;
  pilotDevice?: string;
  allowExternalNavigation?: boolean;
  disallowedKeywords?: string[];
  systemPrompt?: string;
}
