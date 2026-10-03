export interface UpstreamPatchDefinition { file: string; package: string }
export type UpstreamPatch = UpstreamPatchDefinition
export interface UpstreamPatchResult extends UpstreamPatchDefinition {
  status: "applied" | "already-applied" | "already-in-branch"
  verifiedComposition?: string
}
export function verifiedBrowserRootComposition(root: string, upstream: string, patch: Pick<UpstreamPatchDefinition, "file">): boolean
export function verifiedComposedPatch(root: string, upstream: string, patch: Pick<UpstreamPatchDefinition, "file">): boolean
export function upstreamPatches(root: string): UpstreamPatchDefinition[]
export function applyUpstreamPatches(root: string, upstream: string): UpstreamPatchResult[]
