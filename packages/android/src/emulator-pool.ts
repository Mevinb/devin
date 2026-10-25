// SDK management and scan runtimes use one pool, lease policy and shutdown implementation.
export { EmulatorManager, EmulatorManager as EmulatorPool, defaultEmulatorManager as defaultEmulatorPool } from "@pixelsentinel/core";
export type { EmulatorInstance, EmulatorInstance as RunningEmulator, EmulatorPoolOptions, BootOptions } from "@pixelsentinel/core";
