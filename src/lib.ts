/**
 * Library surface.
 *
 * Exported so the bridge can be embedded or extended without forking. Kept
 * deliberately small: the Kiro dialect lives behind `KiroConnection`, and the
 * translation modules are exposed because they are the parts most likely to need
 * overriding as Kiro evolves.
 */

export { KiroBridge, BRIDGE_VERSION, type BridgeOptions } from "./bridge/bridge.js";
export { BridgeSession, SessionRegistry } from "./bridge/session.js";
export type {
  SessionAgentState,
  SessionEffortState,
  SessionModelState,
} from "./bridge/session.js";
export {
  isWithin,
  normalizePath,
  normalizeToolCallPaths,
  relativeHintFromRawInput,
  type PathContext,
} from "./bridge/paths.js";
export {
  applyConfigOption,
  buildConfigOptions,
  buildModeState,
  CONFIG_IDS,
  defaultEffortFor,
  InvalidConfigValueError,
  reconcileEffortAfterModelChange,
  refreshAgents,
  refreshAll,
  refreshContextWindows,
  refreshEffort,
  refreshModels,
  UnknownConfigOptionError,
  type ApplyResult,
  type ConfigId,
} from "./bridge/config.js";
export {
  buildV3ConfigOptions,
  buildV3ModeState,
  effortAfterModelSwitch,
  resolveV3Change,
} from "./bridge/v3-config.js";
export { buildV3AvailableCommands, planV3Command } from "./bridge/v3-commands.js";
export { V3Adapter, type V3Host } from "./bridge/v3-adapter.js";
export {
  humaniseAgentId,
  humaniseEffort,
  humaniseModelId,
  preferSuppliedLabel,
} from "./bridge/labels.js";

export { KiroConnection, type KiroClientHandlers, type KiroConnectionOptions } from "./kiro/connection.js";
export { KiroProcess, DEFAULT_AGENT_ENGINE, engineArgs, engineOrder, type KiroProcessOptions } from "./kiro/process.js";
export {
  discoverKiroCli,
  KiroNotFoundError,
  type DiscoverOptions,
  type DiscoveryResult,
} from "./kiro/discovery.js";
export * from "./kiro/protocol.js";
export * from "./kiro/protocol-v3.js";

export {
  Diagnostics,
  diagnosticsFromEnv,
  sanitize,
  type DiagnosticsOptions,
  type LogLevel,
  type TraceDirection,
} from "./diagnostics/logging.js";
