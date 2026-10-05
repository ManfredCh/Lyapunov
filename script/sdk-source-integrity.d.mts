export const SDK_BASE_COMMIT: "54312dc5a8c4a63b60b3b92f51109f7bd1c1e852"
export const LEGACY_SDK_BASE_COMMIT: "7c3f05885033aa3aed74904d59a94692d12a47f7"
export const RC2_PRODUCT_PATCH: "script/patches/dsh-v0.2.0-rc.2-product.patch"
export const RC2_INTEGRITY_MANIFEST: "script/sdk-source-integrity-rc2.json"
export type SDKBaseCommit = typeof SDK_BASE_COMMIT | typeof LEGACY_SDK_BASE_COMMIT
export interface SDKPatch {file: string; package: string}
export interface SDKSourceProof {readonly baseCommit: SDKBaseCommit; readonly registrySignature: string; readonly baselineFiles: number; readonly affectedFiles: number}
export function sdkIntegrityRecord(root: string, baseCommit: SDKBaseCommit): {file: string; baseCommit: SDKBaseCommit; sha256: string}
export function sdkSourceIsFinal(proof: object): boolean
export function sdkPublicPostimageMatches(proof: object, current: Record<string, string>, expected: string[]): boolean
export function sdkFileBytes(sdk: string, path: string): Buffer | null
export function sdkAffectedFingerprint(sdk: string, paths: string[]): string
export function sdkRegistrySignature(root: string, patches: SDKPatch[]): string
export function sdkAffectedPaths(patches: SDKPatch[]): string[]
export function verifySDKSourceIntegrity(root: string, sdk: string, patches: SDKPatch[], final?: boolean, baseCommit?: SDKBaseCommit): SDKSourceProof
export function verifySDKRegistryArtifacts(root: string, patches: SDKPatch[], baseCommit?: SDKBaseCommit): {baseCommit: SDKBaseCommit; signature: string; entry: object; affected: string[]}
