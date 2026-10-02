/** 可选官方套件适配器。核心 sim-contract 不依赖本包。 */
export { name } from './plugin.ts'
export { OFFICIAL_SOURCE, OFFICIAL_SUITES, DEFAULT_SUITE, catalogTasks, languageFromTaskId } from './catalog.ts'
export { createProtocolDouble } from './protocol.ts'
export { BenchmarkAdapter } from './operations.ts'
export { frameAlignment, projectionSummary, robotJoints, sceneProjectionFrom, validateSceneSnapshot, type FrameAlignment, type ProjectedJoint, type SceneProjectionState, type WorkerOpenResult } from './projection.ts'
export { prepareIsolatedSdk, writeIsolatedLiberoConfig, sdkProcessEnv } from './prepare.ts'
