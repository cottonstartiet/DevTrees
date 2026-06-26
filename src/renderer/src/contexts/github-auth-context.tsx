/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { openExternal } from '@/lib/system'
import type { DeviceFlowStart } from '@shared/updater'

type DeviceInfo = Pick<DeviceFlowStart, 'userCode' | 'verificationUri'>

type GithubAuthContextValue = {
  /** `null` while the initial status check is in flight. */
  signedIn: boolean | null
  /** True while a device-flow sign-in is in progress. */
  signingIn: boolean
  /** The active device-flow code/URL to surface to the user, if any. */
  device: DeviceInfo | null
  /** Start (or focus) a device-flow sign-in. Resolves to whether sign-in succeeded. */
  signIn: () => Promise<boolean>
  signOut: () => Promise<void>
}

const GithubAuthContext = createContext<GithubAuthContextValue | null>(null)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function GithubAuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [device, setDevice] = useState<DeviceInfo | null>(null)
  const cancelledRef = useRef(false)
  const inFlightRef = useRef<Promise<boolean> | null>(null)

  useEffect(() => {
    cancelledRef.current = false
    void window.api.githubAuth
      .status()
      .then((s) => {
        if (!cancelledRef.current) setSignedIn(s.signedIn)
      })
      .catch(() => {
        if (!cancelledRef.current) setSignedIn(false)
      })
    return () => {
      cancelledRef.current = true
    }
  }, [])

  const runDeviceFlow = useCallback(async (): Promise<boolean> => {
    setSigningIn(true)
    try {
      const start = await window.api.githubAuth.startDeviceFlow()
      setDevice({ userCode: start.userCode, verificationUri: start.verificationUri })
      await openExternal(start.verificationUri)
      toast.info(`Enter code ${start.userCode} in your browser to sign in to GitHub.`, {
        duration: Infinity,
        id: 'github-device-code'
      })

      let intervalMs = Math.max(start.intervalSecs, 1) * 1000
      const deadline = Date.now() + start.expiresInSecs * 1000

      while (Date.now() < deadline) {
        await sleep(intervalMs)
        if (cancelledRef.current) return false
        const res = await window.api.githubAuth.poll()
        switch (res.status) {
          case 'authorized':
            setSignedIn(true)
            toast.success('Signed in to GitHub.', { id: 'github-device-code' })
            return true
          case 'pending':
            break
          case 'slowDown':
            intervalMs = Math.max(res.intervalSecs, 1) * 1000
            break
          case 'expired':
            toast.error('Sign-in code expired. Please try again.', { id: 'github-device-code' })
            return false
          case 'denied':
            toast.error('GitHub sign-in was denied.', { id: 'github-device-code' })
            return false
          case 'error':
            toast.error(`GitHub sign-in failed: ${res.message}`, { id: 'github-device-code' })
            return false
        }
      }
      toast.error('Sign-in timed out. Please try again.', { id: 'github-device-code' })
      return false
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`GitHub sign-in failed: ${message}`, { id: 'github-device-code' })
      return false
    } finally {
      setSigningIn(false)
      setDevice(null)
    }
  }, [])

  const signIn = useCallback(async (): Promise<boolean> => {
    if (inFlightRef.current) return inFlightRef.current
    const promise = runDeviceFlow().finally(() => {
      inFlightRef.current = null
    })
    inFlightRef.current = promise
    return promise
  }, [runDeviceFlow])

  const signOut = useCallback(async (): Promise<void> => {
    try {
      const s = await window.api.githubAuth.signOut()
      setSignedIn(s.signedIn)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`Sign-out failed: ${message}`)
    }
  }, [])

  const value: GithubAuthContextValue = {
    signedIn,
    signingIn,
    device,
    signIn,
    signOut
  }

  return <GithubAuthContext.Provider value={value}>{children}</GithubAuthContext.Provider>
}

export function useGithubAuth(): GithubAuthContextValue {
  const ctx = useContext(GithubAuthContext)
  if (!ctx) throw new Error('useGithubAuth must be used within a GithubAuthProvider')
  return ctx
}
