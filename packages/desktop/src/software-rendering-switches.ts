/** Pure Chromium software-rendering switch contract. No Electron import so it can be tested offline. */
export const softwareGlSwitches:ReadonlyArray<readonly [string,string?]>= [["ozone-platform","x11"],["use-gl","angle"],["use-angle","swiftshader"]]
