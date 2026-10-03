import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Evidence can remain a plain path for existing manifests. Structured JSON
 * checking is opt-in: an object must declare format=json and may provide only
 * the receipt fields it actually knows how to bind.
 */
export interface BehaviorEvidenceDescriptor {
  path: string
  format?: 'json'
  expected?: {
    identity?: unknown
    robot?: unknown
    engine?: unknown
    outcome?: unknown
  }
}

export interface BehaviorEvidenceIssue {
  path: string
  code: string
  detail?: string
}

export interface BehaviorEvidenceResult {
  valid: boolean
  issues: BehaviorEvidenceIssue[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const DESCRIPTOR_FIELDS = new Set(['path', 'format', 'expected'])
const EXPECTED_FIELDS = ['identity', 'robot', 'engine', 'outcome'] as const
const EXPECTED_FIELD_SET = new Set<string>(EXPECTED_FIELDS)

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** JSON values are the only values that can be carried by a manifest descriptor. */
function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isPlainRecord(value) && Object.values(value).every(isJsonValue)
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

function equalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function pathIssue(path: string, code: string, detail?: string): BehaviorEvidenceIssue {
  return { path, code, ...(detail ? { detail } : {}) }
}

function failureText(value: unknown): boolean {
  return typeof value === 'string' && /^(?:fail(?:ed|ure)?|blocked|error|unverified|partial|false|not[_ -]?ok|incomplete)$/i.test(value.trim())
}

function receiptFailed(receipt: Record<string, unknown>): string | null {
  if (failureText(receipt.outcome) || receipt.outcome === false) return String(receipt.outcome)
  if (failureText(receipt.status) || receipt.status === false) return String(receipt.status)
  if (failureText(receipt.result)) return String(receipt.result)
  if (receipt.success === false || receipt.ok === false || receipt.failed === true) return 'false'
  if ((typeof receipt.error === 'string' && receipt.error.trim().length > 0) || receipt.error === true || isRecord(receipt.error)) return 'error'
  if (isRecord(receipt.outcome)) {
    if (failureText(receipt.outcome.status) || receipt.outcome.status === false) return String(receipt.outcome.status)
    if (receipt.outcome.success === false || receipt.outcome.ok === false || receipt.outcome.failed === true) return 'false'
  }
  return null
}

/** Resolve and validate one evidence path without allowing traversal or links outside the pack. */
async function validateFile(packRoot: string, evidencePath: string, issuePath: string): Promise<BehaviorEvidenceIssue | null> {
  if (!isText(evidencePath) || evidencePath.includes('\0') || evidencePath.includes('\\') || isAbsolute(evidencePath) || /^[A-Za-z]:/.test(evidencePath)) {
    return pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_PATH_INVALID', 'evidence must be a non-empty repository-relative POSIX path')
  }
  const segments = evidencePath.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    return pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_PATH_TRAVERSAL', 'evidence path contains an unsafe segment')
  }

  let root: string
  try { root = await realpath(packRoot) } catch { return pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_ROOT_UNREADABLE') }
  const candidate = resolve(root, evidencePath)
  const candidateRelative = relative(root, candidate)
  if (!candidateRelative || candidateRelative === '..' || candidateRelative.startsWith(`..${sep}`) || isAbsolute(candidateRelative)) {
    return pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_PATH_TRAVERSAL', 'evidence resolves outside the pack root')
  }

  let info
  try { info = await lstat(candidate) } catch { return pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_NOT_ON_DISK', evidencePath) }
  if (info.isSymbolicLink()) return pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_SYMLINK', evidencePath)
  if (!info.isFile()) return pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_NOT_REGULAR_FILE', evidencePath)
  if (info.size <= 0) return pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_EMPTY', evidencePath)

  let resolvedCandidate: string
  try { resolvedCandidate = await realpath(candidate) } catch { return pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_NOT_ON_DISK', evidencePath) }
  const resolvedRelative = relative(root, resolvedCandidate)
  if (resolvedRelative === '..' || resolvedRelative.startsWith(`..${sep}`) || isAbsolute(resolvedRelative)) {
    return pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_SYMLINK_ESCAPE', evidencePath)
  }
  return null
}

/** Validate evidence files and any explicitly declared structured receipt expectations. */
export async function validateBehaviorEvidence(packRoot: string, evidence: unknown): Promise<BehaviorEvidenceResult> {
  const issues: BehaviorEvidenceIssue[] = []
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { valid: false, issues: [pathIssue('policy.verified.behavior.evidence', 'BEHAVIOR_EVIDENCE_MISSING', 'status=PASS requires evidence file paths')] }
  }

  for (const [index, item] of evidence.entries()) {
    const issuePath = `policy.verified.behavior.evidence[${index}]`
    let evidencePath: string | null = null
    let format: unknown
    let expectedValue: unknown
    if (typeof item === 'string') evidencePath = item
    else if (isPlainRecord(item)) {
      for (const key of Object.keys(item)) if (!DESCRIPTOR_FIELDS.has(key)) issues.push(pathIssue(`${issuePath}.${key}`, 'BEHAVIOR_EVIDENCE_DESCRIPTOR_FIELD_UNSUPPORTED'))
      if (typeof item.path === 'string') {
        evidencePath = item.path
        format = item.format
        expectedValue = item.expected
      }
    }
    if (evidencePath === null) {
      issues.push(pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_DESCRIPTOR_INVALID'))
      continue
    }
    const fileIssue = await validateFile(packRoot, evidencePath, issuePath)
    if (fileIssue) { issues.push(fileIssue); continue }

    if (format !== undefined && format !== 'json') {
      issues.push(pathIssue(`${issuePath}.format`, 'BEHAVIOR_EVIDENCE_FORMAT_UNSUPPORTED', String(format)))
      continue
    }
    let expected: Record<string, unknown> | undefined
    if (expectedValue !== undefined) {
      if (format !== 'json') {
        issues.push(pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_FORMAT_REQUIRED', 'structured expectations require format=json'))
        continue
      }
      if (!isPlainRecord(expectedValue)) {
        issues.push(pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_EXPECTATION_INVALID'))
        continue
      }
      expected = expectedValue
      let malformedExpectation = false
      for (const key of Object.keys(expected)) {
        if (!EXPECTED_FIELD_SET.has(key)) {
          issues.push(pathIssue(`${issuePath}.expected.${key}`, 'BEHAVIOR_EVIDENCE_EXPECTATION_UNSUPPORTED'))
          malformedExpectation = true
        } else if (!isJsonValue(expected[key])) {
          issues.push(pathIssue(`${issuePath}.expected.${key}`, 'BEHAVIOR_EVIDENCE_EXPECTATION_INVALID', 'expected values must be JSON values'))
          malformedExpectation = true
        }
      }
      if (malformedExpectation) continue
    }
    if (format !== 'json') continue

    let receipt: unknown
    try { receipt = JSON.parse(await readFile(resolve(await realpath(packRoot), evidencePath), 'utf8')) } catch {
      issues.push(pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_JSON_INVALID', evidencePath))
      continue
    }
    if (!isPlainRecord(receipt)) {
      issues.push(pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_RECEIPT_INVALID', 'JSON receipt must be an object'))
      continue
    }
    const failure = receiptFailed(receipt)
    if (failure !== null) issues.push(pathIssue(issuePath, 'BEHAVIOR_EVIDENCE_OUTCOME_FAILURE', failure))
    if (!expected) continue
    for (const key of Object.keys(expected)) {
      if (!(key in receipt)) {
        issues.push(pathIssue(`${issuePath}.expected.${key}`, 'BEHAVIOR_EVIDENCE_RECEIPT_FIELD_MISSING', key))
      } else if (!equalValue(receipt[key], expected[key])) {
        issues.push(pathIssue(`${issuePath}.expected.${key}`, 'BEHAVIOR_EVIDENCE_RECEIPT_MISMATCH', key))
      }
    }
  }
  return { valid: issues.length === 0, issues }
}
