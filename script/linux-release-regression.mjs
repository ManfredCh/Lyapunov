import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const linux = join(import.meta.dirname, '..', 'distribution', 'linux')
const node = process.execPath
const run = (command, args = [], options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options })
const assertExit = (result, code, label) => assert.equal(result.status, code, `${label}: ${result.stdout}\n${result.stderr}`)

const root = mkdtempSync(join(tmpdir(), 'lyapunov-linux-release-regression-'))
try {
  mkdirSync(join(root, 'distribution/linux'), { recursive: true })
  mkdirSync(join(root, 'packages/lyapunov-product-bundle/src'), { recursive: true })
  mkdirSync(join(root, 'runtime/electron'), { recursive: true })
  writeFileSync(join(root, 'distribution/linux/doctor.mjs'), await import('node:fs/promises').then(fs => fs.readFile(join(linux, 'doctor.mjs'))))
  writeFileSync(join(root, 'distribution/linux/sandbox.mjs'), await import('node:fs/promises').then(fs => fs.readFile(join(linux, 'sandbox.mjs'))))
  writeFileSync(join(root, 'packages/lyapunov-product-bundle/src/sdk-python.mjs'), await import('node:fs/promises').then(fs => fs.readFile(join(linux, '../../packages/lyapunov-product-bundle/src/sdk-python.mjs'))))
  writeFileSync(join(root, 'distribution/linux/physics-check.js'), 'console.log("ok")\n')
  writeFileSync(join(root, 'distribution/linux/install-provider'), await import('node:fs/promises').then(fs => fs.readFile(join(linux, 'install-provider'))))
  chmodSync(join(root, 'distribution/linux/install-provider'), 0o755)
  writeFileSync(join(root, 'lyapunov'), await import('node:fs/promises').then(fs => fs.readFile(join(linux, 'lyapunov'))))
  chmodSync(join(root, 'lyapunov'), 0o755)
  mkdirSync(join(root, 'runtime/node/bin'), { recursive: true })
  symlinkSync(node, join(root, 'runtime/node/bin/node'))
  writeFileSync(join(root, 'runtime/electron/lyapunov-desktop'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(root, 'runtime/electron/lyapunov-desktop'), 0o755)
  const doctor = join(root, 'distribution/linux/doctor.mjs')
  const sandboxScript = join(root, 'distribution/linux/sandbox.mjs')
  const installer = join(root, 'distribution/linux/install-provider')
  const missingManifest = run(node, [doctor], { cwd: root })
  assertExit(missingManifest, 2, 'missing RELEASE.json')
  assert.equal(JSON.parse(missingManifest.stdout).code, 'RELEASE_MANIFEST_MISSING')

  writeFileSync(join(root, 'RELEASE.json'), JSON.stringify({ product: 'LyapunovDSH', version: '0.1.0', platform: 'linux-x64' }))
  const version = run(node, [doctor, 'version'], { cwd: root })
  assertExit(version, 0, 'version')
  assert.equal(JSON.parse(version.stdout).sourceCommit, null)
  const fakePython = join(root, 'fake-python')
  writeFileSync(fakePython, '#!/bin/sh\nprintf \'%s\\n\' \'{"status":"AVAILABLE","provider":"mujoco"}\'\nexit 7\n')
  chmodSync(fakePython, 0o755)
  const badProvider = run(node, [doctor, 'mujoco'], { cwd: root, env: { ...process.env, LYAPUNOV_MUJOCO_PYTHON: fakePython } })
  assertExit(badProvider, 2, 'doctor nonzero provider probe')
  assert.equal(JSON.parse(badProvider.stdout).providers.mujoco.status, 'BLOCKED')
  const launcherVersion = run(join(root, 'lyapunov'), ['--version'], { cwd: root })
  assertExit(launcherVersion, 0, 'launcher --version')
  assert.equal(JSON.parse(launcherVersion.stdout).product, 'LyapunovDSH')

  const sandboxPath = join(root, 'runtime/electron/chrome-sandbox')
  writeFileSync(sandboxPath, 'fixture')
  const sandboxModule = await import(pathToFileURL(sandboxScript).href)
  const regular = sandboxModule.inspectSandbox(root)
  assert.equal(regular.helper.exists, true)
  assert.equal(regular.helper.mode & 0o7000, 0)
  rmSync(sandboxPath)
  symlinkSync('/tmp/does-not-exist', sandboxPath)
  const sandbox = run(node, [sandboxScript, 'check'], { cwd: root })
  assert.ok([0, 2].includes(sandbox.status), `sandbox check unexpected exit: ${sandbox.stdout}\n${sandbox.stderr}`)
  const inspected = sandboxModule.inspectSandbox(root)
  assert.equal(inspected.helper.exists, false)

  const fakeRuntime = mkdtempSync(join(tmpdir(), 'lyapunov-linux-release-fake-runtime-'))
  try {
    const missingTool = run(installer, ['mujoco'], { cwd: root, env: { ...process.env, LYAPUNOV_NODE_BIN: node, LYAPUNOV_MICROMAMBA: join(fakeRuntime, 'missing-micromamba') } })
    assertExit(missingTool, 2, 'install-provider missing micromamba')
    assert.match(missingTool.stdout, /PROVIDER_ENV_TOOL_MISSING|PROVIDER_NODE_MISSING/)

    const fakeMamba = join(fakeRuntime, 'micromamba')
    const fakePythonTemplate = join(fakeRuntime, 'python')
    const pipLog = join(fakeRuntime, 'pip.log')
    writeFileSync(fakeMamba, '#!/bin/sh\nprintf \'mamba-called\\n\' >> "$FAKE_PIP_LOG"\nexit 99\n')
    chmodSync(fakeMamba, 0o755)
    writeFileSync(fakePythonTemplate, `#!/bin/sh
set -eu
prefix=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
log=${'${FAKE_PIP_LOG:-/dev/null}'}
if [ "${'${1:-}'}" = -m ] && [ "${'${2:-}'}" = pip ]; then
  if [ "${'${3:-}'}" = --version ]; then
    # Simulate both a missing pip and a Python 3.12-incompatible old pip import.
    [ ! -f "$prefix/.fake-pip-import-broken" ] || exit 1
    [ -f "$prefix/.fake-pip-ready" ] || exit 1
    printf '%s\\n' 'pip 24.0 from fake-prefix'
    exit 0
  fi
  if [ "${'${3:-}'}" = --isolated ]; then
    printf 'pip-install isolated=true prefix=%s args=' "$prefix" >> "$log"
    shift 3
    printf '<%s> ' "$@" >> "$log"
    printf '\\n' >> "$log"
    [ -f "$prefix/.fake-pip-ready" ] || exit 1
    exit 0
  fi
fi
if [ "${'${1:-}'}" = -m ] && [ "${'${2:-}'}" = ensurepip ]; then
  printf 'ensurepip prefix=%s args=' "$prefix" >> "$log"
  shift 2
  printf '<%s> ' "$@" >> "$log"
  printf '\\n' >> "$log"
  : > "$prefix/.fake-pip-ready"
  rm -f "$prefix/.fake-pip-import-broken"
  exit 0
fi
if [ "${'${1:-}'}" = -c ]; then
  code=${'${2:-}'}
  case "$code" in
    *'os.path.realpath(sys.prefix)'*) printf '%s\\n' "$prefix"; exit 0 ;;
    *'EULA_ACCEPTED'*)
      mkdir -p "$prefix/lib/python3.12/site-packages/isaacsim/kit"
      printf 'yes\\n' > "$prefix/lib/python3.12/site-packages/isaacsim/kit/EULA_ACCEPTED"
      exit 0 ;;
    *'import mujoco'*) printf '%s\\n' '{"provider":"mujoco","status":"AVAILABLE","version":"3.13.0","physicalExecution":false}'; exit 0 ;;
  esac
fi
case "${'${1:-}'}" in
  *check.py) printf '%s\\n' '{"provider":"isaac","status":"AVAILABLE","version":"6.0.1.0","physicalExecution":false}'; exit 0 ;;
esac
exit 0
`)
    chmodSync(fakePythonTemplate, 0o755)
    const makeReusablePrefix = (relative) => {
      const prefix = join(root, relative)
      mkdirSync(join(prefix, 'bin'), { recursive: true })
      writeFileSync(join(prefix, 'bin/python'), readFileSync(fakePythonTemplate))
      chmodSync(join(prefix, 'bin/python'), 0o755)
      return prefix
    }
    const fakeEnv = { ...process.env, FAKE_PIP_LOG: pipLog, PIP_CACHE_DIR: join(fakeRuntime, 'host-cache'), LYAPUNOV_NODE_BIN: node, LYAPUNOV_MICROMAMBA: fakeMamba }
    mkdirSync(join(root, 'packages/asset-bake'), { recursive: true })
    writeFileSync(join(root, 'packages/asset-bake/requirements.txt'), '# isolated fake requirements\\n')
    rmSync(join(root, 'RELEASE.json'))
    mkdirSync(join(root, 'script'), { recursive: true })
    writeFileSync(join(root, 'script/package-linux.ts'), '// fake dev checkout marker\\n')

    const externalPrefix = join(fakeRuntime, 'external-sim-python')
    mkdirSync(join(externalPrefix, 'bin'), { recursive: true })
    writeFileSync(join(externalPrefix, 'bin/python'), readFileSync(fakePythonTemplate))
    chmodSync(join(externalPrefix, 'bin/python'), 0o755)
    writeFileSync(join(externalPrefix, 'sentinel'), 'external prefix must remain untouched\\n')
    mkdirSync(join(root, '.runtime'), { recursive: true })
    symlinkSync(externalPrefix, join(root, '.runtime/sim-python'))
    const externalPrefixResult = run(installer, ['mujoco'], { cwd: root, env: fakeEnv })
    assertExit(externalPrefixResult, 2, 'install-provider rejects prefix symlink outside product root')
    assert.match(externalPrefixResult.stdout, /PROVIDER_PREFIX_OUTSIDE_ROOT/)
    assert.equal(readFileSync(join(externalPrefix, 'sentinel'), 'utf8'), 'external prefix must remain untouched\\n')
    rmSync(join(root, '.runtime/sim-python'))

    const mujocoPrefix = makeReusablePrefix('.runtime/sim-python')
    writeFileSync(join(mujocoPrefix, '.fake-pip-import-broken'), 'old pip import failure\\n')
    const mujocoInstall = run(installer, ['mujoco'], { cwd: root, env: fakeEnv })
    assertExit(mujocoInstall, 0, 'install-provider mujoco missing pip')
    assert.match(mujocoInstall.stdout, /AVAILABLE/)
    assert.equal(existsSync(join(mujocoPrefix, '.fake-pip-ready')), true)
    assert.equal(existsSync(join(mujocoPrefix, '.fake-pip-import-broken')), false)

    const isaacPrefix = makeReusablePrefix('.runtime/conda/envs/isaac')
    const licenseBlocked = run(installer, ['isaac'], { cwd: root, env: fakeEnv })
    assertExit(licenseBlocked, 2, 'install-provider isaac requires explicit license')
    assert.match(licenseBlocked.stdout, /LICENSE_CONFIRMATION_REQUIRED/)
    const isaacInstall = run(installer, ['isaac', '--accept-omniverse-eula'], { cwd: root, env: fakeEnv })
    assertExit(isaacInstall, 0, 'install-provider isaac missing pip')
    assert.match(isaacInstall.stdout, /AVAILABLE/)
    assert.equal(existsSync(join(isaacPrefix, 'lib/python3.12/site-packages/isaacsim/kit/EULA_ACCEPTED')), true)

    const pipLogText = readFileSync(pipLog, 'utf8')
    assert.equal((pipLogText.match(/^ensurepip /gm) ?? []).length, 2)
    assert.equal((pipLogText.match(/^ensurepip .*<--upgrade>/gm) ?? []).length, 2)
    const installLines = pipLogText.split('\n').filter(line => line.startsWith('pip-install '))
    assert.ok(installLines.length >= 2)
    for (const line of installLines) {
      assert.match(line, /isolated=true/)
      assert.match(line, /<--cache-dir>/)
      assert.match(line, new RegExp(`<${root.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/\\.runtime/provider-download-cache/pip>`))
      assert.doesNotMatch(line, /host-cache/)
    }

    const conflictPrefix = join(root, '.runtime/newton-env')
    mkdirSync(conflictPrefix, { recursive: true })
    writeFileSync(join(conflictPrefix, 'sentinel'), 'preserve me\\n')
    const conflict = run(installer, ['newton'], { cwd: root, env: fakeEnv })
    assertExit(conflict, 2, 'install-provider preserves conflicting prefix')
    assert.match(conflict.stdout, /PROVIDER_PREFIX_CONFLICT/)
    assert.equal(readFileSync(join(conflictPrefix, 'sentinel'), 'utf8'), 'preserve me\\n')
  } finally {
    rmSync(fakeRuntime, { recursive: true, force: true })
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('linux-release-regression: PASS')
