export type HostRequestErrorCode =
  | 'host-unavailable'
  | 'unauthorized'
  | 'stale-host'
  | 'aborted'
  | 'backend-error'

export class HostRequestError extends Error {
  constructor(
    public readonly code: HostRequestErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'HostRequestError'
  }
}

let csrfPromise: Promise<string> | null = null

async function csrfToken(): Promise<string> {
  csrfPromise ??= fetch('/api/session', {
    credentials: 'same-origin',
    cache: 'no-store'
  })
    .then(async (response) => {
      if (response.status === 401) {
        throw new HostRequestError(
          'unauthorized',
          'This browser is not authenticated. Open DevTrees from the tray.',
          401
        )
      }
      if (!response.ok) {
        throw new HostRequestError(
          'backend-error',
          `Could not establish a host session (${response.status}).`,
          response.status
        )
      }
      const data = (await response.json()) as { csrfToken: string }
      return data.csrfToken
    })
    .catch((error) => {
      csrfPromise = null
      if (error instanceof HostRequestError) throw error
      throw new HostRequestError('host-unavailable', 'The DevTrees tray host is unavailable.')
    })
  return csrfPromise
}

export async function hostRequest<T>(
  route: string,
  body: Record<string, unknown> = {},
  signal?: AbortSignal
): Promise<T> {
  let csrf: string
  try {
    csrf = await csrfToken()
  } catch (error) {
    if (signal?.aborted) throw new HostRequestError('aborted', 'Request was cancelled.')
    throw error
  }

  try {
    const response = await fetch(`/api/${route}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-devtrees-csrf': csrf
      },
      body: JSON.stringify(body)
    })
    if (response.status === 401) {
      csrfPromise = null
      throw new HostRequestError(
        'unauthorized',
        'This browser session expired. Reopen DevTrees from the tray.',
        response.status
      )
    }
    const data = (await response.json().catch(() => ({}))) as {
      error?: string
      requiredVersion?: string
    }
    if (response.status === 409 && data.requiredVersion) {
      throw new HostRequestError(
        'stale-host',
        `This UI requires DevTrees host ${data.requiredVersion}.`,
        response.status
      )
    }
    if (!response.ok) {
      throw new HostRequestError(
        'backend-error',
        data.error ?? `DevTrees host request failed (${response.status}).`,
        response.status
      )
    }
    return data as T
  } catch (error) {
    if (error instanceof HostRequestError) throw error
    if (signal?.aborted) throw new HostRequestError('aborted', 'Request was cancelled.')
    throw new HostRequestError('host-unavailable', 'The DevTrees tray host is unavailable.')
  }
}
