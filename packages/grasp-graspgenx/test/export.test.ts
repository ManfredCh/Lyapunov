import { expect, test } from "bun:test"
import { transformCandidate } from "../src/coordinates.ts"
test("transformCandidate 把单位旋转下的位置平移到框架原点", () => {
  const out = transformCandidate({
    candidateId: "c", provider: "graspgenx", entityId: "e", frameId: "old",
    tcpPose: { position: [1, 0, 0], quaternion: [0, 0, 0, 1] }, widthM: 0.04,
    approach: [0, 0, -1], score: 0.5, scoreKind: "model",
  }, { position: [0, 2, 0], quaternion: [0, 0, 0, 1] }, "frame-1")
  expect(out.frameId).toBe("frame-1")
  expect(out.tcpPose.position[0]).toBeCloseTo(1)
  expect(out.tcpPose.position[1]).toBeCloseTo(2)
  expect(out.approach[2]).toBeCloseTo(-1)
})
