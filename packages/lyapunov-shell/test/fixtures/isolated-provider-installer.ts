import { expect, spyOn } from "bun:test"
import { isAbsolute, join } from "node:path"
import * as providerInstallerModule from "../../src/provider-installer.ts"

const realCreateProviderInstaller = providerInstallerModule.createProviderInstaller

/**
 * Unit-fixture isolation for one sequential Shell apply(): importing this module
 * does not install a spy or touch the filesystem. The caller owns a fresh temp
 * root, asserts interception after apply(), and restores the spy in finally.
 * Dispose the fixture's Context before removing its root. This is not an
 * installer/process test: the absent script prevents provider launches, while
 * the real factory, recover(), Jobs registration, and disposal still run.
 */
export function isolateProviderInstaller(root: string) {
  if (!isAbsolute(root)) throw new Error("INSTALLER_FIXTURE_ROOT_MUST_BE_ABSOLUTE")
  if (providerInstallerModule.createProviderInstaller !== realCreateProviderInstaller) {
    throw new Error("INSTALLER_FIXTURE_FACTORY_ALREADY_INTERCEPTED")
  }
  const factorySpy = spyOn(providerInstallerModule, "createProviderInstaller").mockImplementation(options => realCreateProviderInstaller({
    ...options,
    root: join(root, "provider-attempts"),
    cwd: root,
    scriptPath: join(root, "provider-install-disabled"),
    env: { HOME: root, TMPDIR: root },
    readLicense: () => undefined,
  }))
  if (providerInstallerModule.createProviderInstaller !== factorySpy) {
    factorySpy.mockRestore()
    throw new Error("INSTALLER_FIXTURE_FACTORY_NOT_INTERCEPTED")
  }
  return {
    assertCalled: (expectedCalls = 1) => { expect(factorySpy).toHaveBeenCalledTimes(expectedCalls) },
    restore: () => { factorySpy.mockRestore() },
  }
}
