import { expect, test } from "bun:test"
import { AttachmentId } from "@deepseek-ai/dsh-attachment"
import type { JsonValue } from "@deepseek-ai/dsh-util-values"
import { renderResource } from "../src/resources.ts"
test("renderResource 把文本和图片附件都放进内容块", () => {
  const textItem: JsonValue = { text: "a" }
  const imageItem: JsonValue = { imageAttachment: { attachmentId: "img-1", mediaType: "image/png", bytes: 4, width: 2, height: 2 } }
  const input: JsonValue = { contents: [textItem, imageItem] }
  const blocks = renderResource(input)
  expect(blocks[0]).toMatchObject({ type: "text", text: expect.stringContaining("\"a\"") })
  const image = blocks.find(block => block.type === "image")
  if (!image || image.type !== "image") throw new Error("缺少图片内容块")
  expect(image.attachment.attachmentId).toBe(AttachmentId("img-1"))
  expect(image.attachment.mediaType).toBe("image/png")
  expect(image.attachment.bytes).toBe(4)
  expect(image.attachment.width).toBe(2)
  expect(image.attachment.height).toBe(2)
})
