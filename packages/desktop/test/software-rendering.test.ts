import { describe, expect, test } from "bun:test"
import { softwareGlSwitches } from "../src/software-rendering-switches.ts"

describe("Linux software renderer fallback", () => {
  test("uses X11 ANGLE/SwiftShader without disabling sandbox or vendor hardware paths", () => {
    expect(softwareGlSwitches).toEqual([
      ["ozone-platform", "x11"],
      ["use-gl", "angle"],
      ["use-angle", "swiftshader"],
    ])
    expect(softwareGlSwitches.some(([name]) => name === "no-sandbox")).toBe(false)
    expect(softwareGlSwitches.some(([name]) => name === "disable-gpu-sandbox")).toBe(false)
    expect(softwareGlSwitches.some(([name]) => name === "ignore-gpu-blocklist")).toBe(false)
  })
})
