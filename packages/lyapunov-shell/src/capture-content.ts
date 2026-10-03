import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment"
import type { ContentBlock } from "@deepseek-ai/dsh-llm"
import { previewPixelMappingText, previewScaleOf, type CaptureRecord } from "./workbench-api.ts"

export interface CapturePin {
  annotationId: string
  index: number
  text: string
  entityId: string
  point: [number, number]
  normalized: [number, number]
  local: [number, number, number]
  world: [number, number, number]
}

/** Saved feedback retains the window identity and pixel coordinates of this frame. */
export type FeedbackCapture = CaptureRecord & {
  sessionKey?: string
  clientId?: string
  source?: string
  pins?: CapturePin[]
}

/** Validate wire pins against the annotations and original frame, without inventing offscreen pins. */
export function capturePins(value: unknown, capture: CaptureRecord): CapturePin[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 200) throw new Error("CAPTURE_PINS_INVALID")
  const frame = capture.originalImage ?? capture.attachment
  const seen = new Set<string>()
  const vector = (input: unknown, size: number): input is number[] => Array.isArray(input) && input.length === size && input.every(n => typeof n === "number" && Number.isFinite(n))
  return value.map(pin => {
    const row = capture.annotations?.find(row => row.annotationId === pin?.annotationId)
    if (!row || seen.has(row.annotationId) || pin.index !== row.index || pin.entityId !== row.entityId || pin.text !== row.text) throw new Error("CAPTURE_PIN_ANNOTATION_MISMATCH")
    if (!vector(pin.point, 2) || !vector(pin.normalized, 2) || !vector(pin.local, 3) || !vector(pin.world, 3)) throw new Error("CAPTURE_PIN_COORDINATES_INVALID")
    if (pin.local.some((n: number, i: number) => n !== row.anchor.local[i]) || pin.world.some((n: number, i: number) => n !== row.anchor.world[i])) throw new Error("CAPTURE_PIN_ANCHOR_MISMATCH")
    if (pin.point[0] < 0 || pin.point[0] > frame.width || pin.point[1] < 0 || pin.point[1] > frame.height || Math.abs(pin.normalized[0] - pin.point[0] / frame.width) > 0.0001 || Math.abs(pin.normalized[1] - pin.point[1] / frame.height) > 0.0001) throw new Error("CAPTURE_PIN_PIXEL_MISMATCH")
    seen.add(row.annotationId)
    return { annotationId: row.annotationId, index: row.index, text: row.text, entityId: row.entityId, point: [...pin.point] as [number, number], normalized: [...pin.normalized] as [number, number], local: [...pin.local] as [number, number, number], world: [...pin.world] as [number, number, number] }
  })
}

/** Only the originating session/window may send a saved frame, and only at its current scene revision. */
export function requireCaptureFeedbackOwner(capture: FeedbackCapture, owner: { sessionKey: string; clientId: string; sceneId: string; revision: number }): void {
  if (capture.sessionKey !== owner.sessionKey) throw new Error("CAPTURE_FEEDBACK_SESSION_MISMATCH")
  if (!capture.clientId || capture.clientId !== owner.clientId) throw new Error("CAPTURE_FEEDBACK_WINDOW_MISMATCH")
  if (capture.sceneId !== owner.sceneId || capture.sceneRevision !== owner.revision) throw new Error("CAPTURE_FEEDBACK_SCENE_STALE")
}

/** Use the saved native image reference; request encoding and model image limits remain native adapter responsibilities. */
export function captureFeedbackContent(capture: FeedbackCapture): ContentBlock[] {
  const attachment = capture.attachment as ImageAttachmentRef
  if (!attachment.attachmentId || !Number.isSafeInteger(attachment.bytes) || attachment.bytes <= 0 || !Number.isSafeInteger(attachment.width) || attachment.width <= 0 || !Number.isSafeInteger(attachment.height) || attachment.height <= 0) throw new Error("CAPTURE_FEEDBACK_IMAGE_INVALID")
  const frame = capture.originalImage ?? attachment
  const scale = previewScaleOf(frame, attachment)
  const metadata = {
    captureId: capture.captureId, sessionId: capture.sessionKey, clientId: capture.clientId,
    source: capture.source, sceneId: capture.sceneId, sceneRevision: capture.sceneRevision,
    capturedAt: capture.capturedAt, camera: capture.camera,
    image: { attachmentId: attachment.attachmentId, mediaType: attachment.mediaType, bytes: attachment.bytes, width: attachment.width, height: attachment.height, frameWidth: frame.width, frameHeight: frame.height, pixelMapping: previewPixelMappingText(scale) },
    annotations: capture.annotations ?? [], pins: capture.pins,
    worldId: capture.worldId, generation: capture.generation, worldSceneRevision: capture.worldSceneRevision,
    frameSceneRevision: capture.frameSceneRevision, frameId: capture.frameId, stepIndex: capture.stepIndex, simTime: capture.simTime,
    visualWarnings: capture.visualWarnings, environment: capture.environment, lod: capture.lod, lodIssue: capture.lodIssue,
  }
  return [
    { type: "text", text: [capture.prompt, "Viewer capture feedback (pins use original-frame pixels; absent pins are not visible annotations):", JSON.stringify(metadata)].filter(Boolean).join("\n") },
    { type: "image", attachment },
  ]
}
