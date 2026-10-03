import { expect, test } from "bun:test"
import { archiveDigest, assetType } from "../src/snapshot.ts"
test("archiveDigest 与 assetType 按字节和后缀给出稳定结果", () => {
  expect(archiveDigest(new Uint8Array([1, 2, 3]))).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81")
  expect(assetType("model.glb")).toBe("model/gltf-binary")
  expect(assetType("notes.bin")).toBe("application/octet-stream")
})
