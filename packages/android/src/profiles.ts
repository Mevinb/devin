export interface AvdProfile {
  id: string;
  name: string;
  deviceType: "phone" | "tablet" | "foldable" | "tv" | "wearable" | "automotive";
  systemImage: string;
  resolution: { width: number; height: number };
  densityDpi: number;
  ramMb: number;
  abi: "x86_64" | "arm64-v8a";
  hardwareProperties?: Record<string, string>;
}

export const AVD_PROFILES: Record<string, AvdProfile> = {
  pixel_8: {
    id: "pixel_8",
    name: "Google Pixel 8",
    deviceType: "phone",
    systemImage: "system-images;android-34;google_apis;x86_64",
    resolution: { width: 1080, height: 2400 },
    densityDpi: 420,
    ramMb: 4096,
    abi: "x86_64",
    hardwareProperties: {
      "hw.lcd.density": "420",
      "hw.keyboard": "yes",
      "hw.ramSize": "4096"
    }
  },
  pixel_8_pro: {
    id: "pixel_8_pro",
    name: "Google Pixel 8 Pro",
    deviceType: "phone",
    systemImage: "system-images;android-34;google_apis;x86_64",
    resolution: { width: 1344, height: 2992 },
    densityDpi: 489,
    ramMb: 6144,
    abi: "x86_64"
  },
  pixel_tablet: {
    id: "pixel_tablet",
    name: "Google Pixel Tablet 11\"",
    deviceType: "tablet",
    systemImage: "system-images;android-34;google_apis;x86_64",
    resolution: { width: 2560, height: 1600 },
    densityDpi: 320,
    ramMb: 4096,
    abi: "x86_64"
  },
  pixel_fold: {
    id: "pixel_fold",
    name: "Google Pixel Fold (Inner)",
    deviceType: "foldable",
    systemImage: "system-images;android-34;google_apis;x86_64",
    resolution: { width: 1840, height: 2208 },
    densityDpi: 420,
    ramMb: 6144,
    abi: "x86_64",
    hardwareProperties: {
      "hw.sensor.hinge": "yes",
      "hw.sensor.hinge.count": "1",
      "hw.sensor.hinge.type": "1"
    }
  },
  android_tv_1080p: {
    id: "android_tv_1080p",
    name: "Android TV 1080p",
    deviceType: "tv",
    systemImage: "system-images;android-34;android-tv;x86_64",
    resolution: { width: 1920, height: 1080 },
    densityDpi: 320,
    ramMb: 2048,
    abi: "x86_64",
    hardwareProperties: {
      "hw.dPad": "yes",
      "hw.mainKeys": "yes"
    }
  },
  wear_os_round: {
    id: "wear_os_round",
    name: "Wear OS Round 454x454",
    deviceType: "wearable",
    systemImage: "system-images;android-34;android-wear;x86_64",
    resolution: { width: 454, height: 454 },
    densityDpi: 320,
    ramMb: 1536,
    abi: "x86_64"
  },
  automotive_1024p: {
    id: "automotive_1024p",
    name: "Android Automotive 1024p",
    deviceType: "automotive",
    systemImage: "system-images;android-32;android-automotive;x86_64",
    resolution: { width: 1024, height: 768 },
    densityDpi: 160,
    ramMb: 4096,
    abi: "x86_64"
  }
};

export function getAvdProfile(profileId: string): AvdProfile | undefined {
  return AVD_PROFILES[profileId];
}

export function listAvdProfiles(): AvdProfile[] {
  return Object.values(AVD_PROFILES);
}
