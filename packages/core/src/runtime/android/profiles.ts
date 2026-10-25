export interface AvdProfile {
  id: string;
  name: string;
  deviceType: "phone" | "tablet" | "foldable" | "tv" | "wearable" | "automotive";
  systemImage: string;
  avdName: string;
  hardwareDevice?: string;
  resolution: { width: number; height: number };
  densityDpi: number;
  ramMb: number;
  abi: "x86_64" | "arm64-v8a";
  hardwareProperties?: Record<string, string>;
}

export const AVD_PROFILES: Record<string, AvdProfile> = {
  pixel_8: {
    id: "pixel_8",
    avdName: "ps_phone",
    hardwareDevice: "pixel_8",
    name: "Google Pixel 8",
    deviceType: "phone",
    systemImage: "system-images;android-35;google_apis_playstore;x86_64",
    resolution: { width: 1080, height: 2400 },
    densityDpi: 420,
    ramMb: 4096,
    abi: "x86_64",
    hardwareProperties: {
      "hw.lcd.density": "420",
      "hw.keyboard": "no",
      "hw.ramSize": "4096"
    }
  },
  pixel_8_pro: {
    id: "pixel_8_pro",
    avdName: "ps_pixel_8_pro",
    hardwareDevice: "pixel_8_pro",
    name: "Google Pixel 8 Pro",
    deviceType: "phone",
    systemImage: "system-images;android-35;google_apis_playstore;x86_64",
    resolution: { width: 1344, height: 2992 },
    densityDpi: 480,
    ramMb: 6144,
    abi: "x86_64"
  },
  pixel_tablet: {
    id: "pixel_tablet",
    avdName: "ps_tablet",
    hardwareDevice: "pixel_tablet",
    name: "Google Pixel Tablet 11\"",
    deviceType: "tablet",
    systemImage: "system-images;android-35;google_apis_playstore;x86_64",
    resolution: { width: 2560, height: 1600 },
    densityDpi: 320,
    ramMb: 4096,
    abi: "x86_64"
  },
  pixel_fold: {
    id: "pixel_fold",
    avdName: "ps_fold",
    hardwareDevice: "pixel_fold",
    name: "Google Pixel Fold (Inner)",
    deviceType: "foldable",
    systemImage: "system-images;android-35;google_apis_playstore;x86_64",
    resolution: { width: 2208, height: 1840 },
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
    avdName: "ps_tv",
    hardwareDevice: "tv_1080p",
    name: "Android TV 1080p",
    deviceType: "tv",
    systemImage: "system-images;android-36;android-tv;x86_64",
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
    avdName: "ps_wear",
    hardwareDevice: "wearos_large_round",
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
    avdName: "ps_auto",
    name: "Android Automotive 1024p",
    deviceType: "automotive",
    systemImage: "system-images;android-33;android-automotive;x86_64",
    resolution: { width: 1024, height: 768 },
    densityDpi: 160,
    ramMb: 4096,
    abi: "x86_64"
  },
  small_phone: {
    id: "small_phone", avdName: "ps_small_phone", name: "Compact Android Phone 5 inches",
    deviceType: "phone", systemImage: "system-images;android-35;google_apis_playstore;x86_64",
    resolution: { width: 720, height: 1280 }, densityDpi: 320, ramMb: 2048, abi: "x86_64"
  },
  tablet_7in: {
    id: "tablet_7in", avdName: "ps_tablet_7in", name: "Android 7 inch Tablet",
    deviceType: "tablet", systemImage: "system-images;android-35;google_apis_playstore;x86_64",
    resolution: { width: 1200, height: 1920 }, densityDpi: 320, ramMb: 3072, abi: "x86_64"
  },
  android_tv_4k: {
    id: "android_tv_4k", avdName: "ps_tv_4k", name: "Android TV 4K",
    hardwareDevice: "tv_4k", deviceType: "tv", systemImage: "system-images;android-36;android-tv;x86_64",
    resolution: { width: 3840, height: 2160 }, densityDpi: 640, ramMb: 3072, abi: "x86_64",
    hardwareProperties: { "hw.dPad": "yes", "hw.mainKeys": "yes", "hw.keyboard": "no" }
  }

};

export function getAvdProfile(profileId: string): AvdProfile | undefined {
  const aliases: Record<string, string> = {
    phone: "pixel_8", "pixel-8": "pixel_8", "android:pixel-8": "pixel_8",
    "pixel-8-pro": "pixel_8_pro", "pixel-tablet": "pixel_tablet", "pixel-fold": "pixel_fold",
    "tv-1080p": "android_tv_1080p", tv_1080p: "android_tv_1080p", "tv-4k": "android_tv_4k",
    "wear-round": "wear_os_round", automotive: "automotive_1024p", "small-phone": "small_phone", "tablet-7in": "tablet_7in"
  };
  const id = profileId.replace(/^android:/, "");
  if (Object.hasOwn(AVD_PROFILES, id)) return AVD_PROFILES[id];
  const alias = Object.hasOwn(aliases, id) ? aliases[id] : undefined;
  return alias ? AVD_PROFILES[alias] : undefined;
}

export function listAvdProfiles(): AvdProfile[] {
  return Object.values(AVD_PROFILES);
}
