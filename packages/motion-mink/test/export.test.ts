import { expect, test } from "bun:test"
import { motionRequest } from "../src/request.ts"
test("motionRequest 把 quaternionXyzw 换成 quaternion，两个入口都给则拒绝", () => {
  expect(motionRequest({ plan: { targetPose: { position: [1, 2, 3], quaternionXyzw: [0, 0, 0, 1] } } }).targetPose).toEqual({ position: [1, 2, 3], quaternion: [0, 0, 0, 1] })
  expect(() => motionRequest({})).toThrow("INVALID_ARGUMENT: plan 与 request_json 必须二选一")
})
