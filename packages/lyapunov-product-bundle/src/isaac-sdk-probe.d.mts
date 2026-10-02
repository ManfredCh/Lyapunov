export type IsaacSdkProbeState = 'candidate' | 'missing' | 'incompatible' | 'unavailable' | 'timeout'
export interface IsaacSdkCandidate {
  python: string
  kind: 'python' | 'standalone'
  state: IsaacSdkProbeState
  moduleFound: boolean
  sdkVersion: string | null
  pythonVersion: string | null
  sdkRoot: string | null
  compatible: boolean
  detail: string
}
export interface IsaacSdkProbeOptions {productRoot?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; fresh?: boolean}
export declare const ISAAC_SDK_VERSION: '6.0.1.0'
export declare function clearIsaacSdkProbeCache(): void
export declare function resolveIsaacLocalEntry(input: string): string | undefined
export declare function inspectIsaacPythonSync(input: string, options?: IsaacSdkProbeOptions): IsaacSdkCandidate
export declare function inspectIsaacPython(input: string, options?: IsaacSdkProbeOptions): Promise<IsaacSdkCandidate>
