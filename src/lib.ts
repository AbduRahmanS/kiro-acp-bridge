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
  humaniseAgentId,
  humaniseEffort,
  humaniseModelId,
  preferSuppliedLabel,
} from "./bridge/labels.js";

export { KiroConnection, type KiroClientHandlers, type KiroConnectionOptions } from "./kiro/connection.js";
export { KiroProcess, DEFAULT_AGENT_ENGINE, type KiroProcessOptions } from "./kiro/process.js";
export {
  discoverKiroCli,
  KiroNotFoundError,
  type DiscoverOptions,
  type DiscoveryResult,
} from "./kiro/discovery.js";
export * from "./kiro/protocol.js";

export {
  Diagnostics,
  diagnosticsFromEnv,
  sanitize,
  type DiagnosticsOptions,
  type LogLevel,
  type TraceDirection,
} from "./diagnostics/logging.js";
