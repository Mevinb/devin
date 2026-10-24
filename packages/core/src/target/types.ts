export interface TargetResolution {
  url: string;
  isLocal: boolean;
  cleanup: () => Promise<void>;
}
