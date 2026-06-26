/**
 * Types shared with the Rust backend for GitHub device-flow sign-in and the
 * authenticated auto-updater. See `specs/ghe-update.md`.
 */

export type AuthStatus = { signedIn: boolean }

export type DeviceFlowStart = {
  userCode: string
  verificationUri: string
  intervalSecs: number
  expiresInSecs: number
}

/** One poll tick of the device-flow access-token endpoint. */
export type PollResult =
  | { status: 'pending' }
  | { status: 'slowDown'; intervalSecs: number }
  | { status: 'authorized' }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'error'; message: string }

export type UpdateCheckResult = {
  signedIn: boolean
  available: boolean
  version?: string
  notes?: string
}
