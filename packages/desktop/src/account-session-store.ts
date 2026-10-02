import { Buffer } from "node:buffer"

export const ACCOUNT_SESSION_STORE = "lyapunov.account"
export const LEGACY_ACCOUNT_SESSION_STORE = "lyaup.account"
export const ACCOUNT_SESSION_KEY = "encrypted-session-v1"
export const ACCOUNT_SESSION_MIGRATION_KEY = "legacy-session-migration-v1"

export interface LegacyAccountSessionMigrationInput {
  canonical: {
    read: () => unknown
    /** Whether the canonical electron-store file already existed before opening it. */
    fileExisted: boolean
    replace: (value: string) => void
    readMarker: () => unknown
    writeMarker: () => void
  }
  legacy: {
    read: () => unknown
  }
}

/**
 * Move the old electron-store envelope once, without decrypting or rewriting
 * the OS safeStorage ciphertext. A marker prevents a later logout from
 * falling back to the old store on every subsequent launch.
 */
export function migrateLegacyAccountSession(input: LegacyAccountSessionMigrationInput) {
  const canonical = input.canonical.read()
  if (input.canonical.readMarker() === true) {
    return { migrated: false, canonicalPresent: typeof canonical === "string" && canonical.length > 0, legacyPreserved: true }
  }

  // An existing canonical file is authoritative even when the session key is
  // absent: that state can represent an explicit logout and must not be
  // repopulated from the read-only legacy source.
  if (input.canonical.fileExisted || (typeof canonical === "string" && canonical.length > 0)) {
    input.canonical.writeMarker()
    return { migrated: false, canonicalPresent: typeof canonical === "string" && canonical.length > 0, legacyPreserved: true }
  }

  const legacy = input.legacy.read()
  if (typeof legacy === "string" && legacy.length > 0) {
    input.canonical.replace(legacy)
    if (input.canonical.read() !== legacy) throw new Error("ACCOUNT_SESSION_MIGRATION_VERIFY_FAILED")
    input.canonical.writeMarker()
    return { migrated: true, canonicalPresent: true, legacyPreserved: true }
  }

  input.canonical.writeMarker()
  return { migrated: false, canonicalPresent: false, legacyPreserved: true }
}

export interface AccountSessionSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{
    result: string
    shouldReEncrypt: boolean
  }>
}

export interface AccountSessionBackingStore {
  /** Returns the currently persisted Base64 payload. */
  read(): unknown

  /**
   * Atomically replaces the persisted Base64 payload. If this operation rejects,
   * the implementation must leave the previous payload intact.
   */
  replace(value: string): void

  /**
   * Atomically replaces the payload only when its current value is still
   * `expected`. This prevents a stale key-rotation read from restoring a
   * session that was updated or deleted concurrently.
   */
  replaceIfCurrent(expected: string, value: string): boolean

  delete(): void
}

export interface AccountSessionStore {
  get(): Promise<string | null>
  set(value: string): Promise<void>
  delete(): void
}

export class AccountSessionStorageUnavailableError extends Error {
  constructor() {
    super("OS secure storage is unavailable")
    this.name = "AccountSessionStorageUnavailableError"
  }
}

export function createAccountSessionStore(input: {
  safeStorage: AccountSessionSafeStorage
  storage: AccountSessionBackingStore
  onReEncryptionError?: (error: unknown) => void | Promise<void>
}): AccountSessionStore {
  let revision = 0

  const requireEncryption = async () => {
    if (!(await input.safeStorage.isAsyncEncryptionAvailable())) {
      throw new AccountSessionStorageUnavailableError()
    }
  }

  return {
    get: async () => {
      const operationRevision = revision
      const encoded = input.storage.read()
      if (typeof encoded !== "string" || !encoded) return null

      await requireEncryption()
      const decrypted = await input.safeStorage.decryptStringAsync(Buffer.from(encoded, "base64"))

      if (decrypted.shouldReEncrypt) {
        void (async () => {
          try {
            const replacement = await input.safeStorage.encryptStringAsync(decrypted.result)
            if (revision === operationRevision) {
              input.storage.replaceIfCurrent(encoded, replacement.toString("base64"))
            }
          } catch (error) {
            try {
              await input.onReEncryptionError?.(error)
            } catch {
              // Observability hooks must never make a successfully decrypted session unreadable.
            }
          }
        })()
      }

      return decrypted.result
    },
    set: async (value) => {
      const operationRevision = ++revision
      await requireEncryption()
      const encrypted = await input.safeStorage.encryptStringAsync(value)
      if (revision === operationRevision) input.storage.replace(encrypted.toString("base64"))
    },
    delete: () => {
      revision++
      input.storage.delete()
    },
  }
}
