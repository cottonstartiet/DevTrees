export async function remoteRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET'
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-swe-factory-lan': '1' }),
      ...init.headers
    }
  })
  if (!response.ok) {
    const body = await response.text()
    let parsed: { error?: unknown } | null = null
    try {
      parsed = JSON.parse(body) as { error?: unknown }
    } catch {
      parsed = null
    }
    if (typeof parsed?.error === 'string' && parsed.error.trim()) throw new Error(parsed.error)
    throw new Error(body || `Request failed (${response.status}).`)
  }
  return response.json() as Promise<T>
}
