export type SdkEngine = 'mujoco' | 'isaac' | 'newton'
export type SdkPythonSource = 'env-override' | 'saved-preference' | 'package-default'
export interface SdkPythonResolution {
  python: string
  source: SdkPythonSource
}
export declare const SDK_PYTHON_ENV: {
  readonly mujoco: 'LYAPUNOV_MUJOCO_PYTHON'
  readonly isaac: 'LYAPUNOV_ISAAC_PYTHON'
  readonly newton: 'LYAPUNOV_NEWTON_PYTHON'
}
export declare const SDK_PYTHON_PACKAGE_PATH: {
  readonly mujoco: '.runtime/sim-python/bin/python'
  readonly isaac: '.runtime/conda/envs/isaac/bin/python'
  readonly newton: '.runtime/newton-env/bin/python'
}
export declare function sdkPreferenceFile(env?: NodeJS.ProcessEnv): string
export declare function readSdkPythonPreference(engine: SdkEngine, env?: NodeJS.ProcessEnv): string | undefined
export declare function writeSdkPythonPreference(engine: SdkEngine, python: string | null, env?: NodeJS.ProcessEnv): string
export declare function resolveSdkPython(root: string, engine: SdkEngine, env?: NodeJS.ProcessEnv, options?: {managed?: boolean}): SdkPythonResolution
