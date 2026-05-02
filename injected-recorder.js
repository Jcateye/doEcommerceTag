;(function () {
  if (window.__DDE_HTTP_RECORDER_INSTALLED__) return
  window.__DDE_HTTP_RECORDER_INSTALLED__ = true
  window.__DDE_HTTP_RECORDER_ENABLED__ = false

  const MAX_TEXT_LENGTH = 1200000

  function now() {
    return new Date().toISOString()
  }

  function truncate(value) {
    const text = typeof value === 'string' ? value : safeStringify(value)
    if (!text) return ''
    return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}\n...[truncated ${text.length - MAX_TEXT_LENGTH} chars]` : text
  }

  function safeStringify(value) {
    try {
      if (value == null) return ''
      if (typeof value === 'string') return value
      if (value instanceof URLSearchParams) return value.toString()
      if (value instanceof FormData) {
        const out = {}
        for (const [key, val] of value.entries()) out[key] = val instanceof File ? `[File ${val.name} ${val.size}]` : String(val)
        return JSON.stringify(out)
      }
      if (value instanceof Blob) return `[Blob ${value.type} ${value.size}]`
      if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength}]`
      return JSON.stringify(value)
    } catch (error) {
      return `[Unserializable: ${error.message}]`
    }
  }

  function headersToObject(headers) {
    try {
      if (!headers) return {}
      if (headers instanceof Headers) return Object.fromEntries([...headers.entries()])
      if (Array.isArray(headers)) return Object.fromEntries(headers)
      return { ...headers }
    } catch (_error) {
      return {}
    }
  }

  function shouldRecord(_url) {
    return window.__DDE_HTTP_RECORDER_ENABLED__
  }

  function emit(payload) {
    window.postMessage({ source: 'DDE_HTTP_RECORDER', payload }, '*')
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return
    const data = event.data || {}
    if (data.source === 'DDE_HTTP_RECORDER_CONTROL') {
      if (data.command === 'start') {
        window.__DDE_HTTP_RECORDER_ENABLED__ = true
        emit({ type: 'recorder-state', enabled: true, at: now() })
      }
      if (data.command === 'stop') {
        window.__DDE_HTTP_RECORDER_ENABLED__ = false
        emit({ type: 'recorder-state', enabled: false, at: now() })
      }
      return
    }

    if (data.source === 'DDE_HTTP_SUBMITTER' && data.command === 'submitAddWithSchema') {
      try {
        const response = await fetch(data.url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json;charset=utf-8',
            'X-TT-From-Appid': 'ffa-goods',
            'X-TT-From-End': 'PC',
            'X-TT-From-Page': `${location.origin}${location.pathname}`,
            'X-TT-From-Version': '1.0.1.3435',
          },
          body: JSON.stringify(data.body || {}),
        })
        const text = await response.text()
        emit({
          type: 'submit-result',
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          responseBody: truncate(text),
          submitToken: data.submitToken || '',
          at: now(),
        })
      } catch (error) {
        emit({
          type: 'submit-result',
          ok: false,
          error: error.message,
          submitToken: data.submitToken || '',
          at: now(),
        })
      }
    }
  })

  const originalFetch = window.fetch
  window.fetch = async function (...args) {
    const startedAt = now()
    const input = args[0]
    const init = args[1] || {}
    const url = typeof input === 'string' ? input : input?.url
    const method = String(init.method || input?.method || 'GET').toUpperCase()
    const requestHeaders = headersToObject(init.headers || input?.headers)
    const requestBody = truncate(init.body || '')

    try {
      const response = await originalFetch.apply(this, args)
      if (shouldRecord(url)) {
        const clone = response.clone()
        clone.text().then((responseText) => {
          emit({
            type: 'fetch',
            startedAt,
            endedAt: now(),
            method,
            url: String(url || ''),
            requestHeaders,
            requestBody,
            status: response.status,
            statusText: response.statusText,
            responseHeaders: headersToObject(response.headers),
            responseBody: truncate(responseText),
          })
        }).catch((error) => {
          emit({ type: 'fetch', startedAt, endedAt: now(), method, url: String(url || ''), requestHeaders, requestBody, error: error.message })
        })
      }
      return response
    } catch (error) {
      if (shouldRecord(url)) emit({ type: 'fetch', startedAt, endedAt: now(), method, url: String(url || ''), requestHeaders, requestBody, error: error.message })
      throw error
    }
  }

  const originalSendBeacon = navigator.sendBeacon?.bind(navigator)
  if (originalSendBeacon) {
    navigator.sendBeacon = function (url, data) {
      if (shouldRecord(url)) {
        emit({
          type: 'sendBeacon',
          startedAt: now(),
          endedAt: now(),
          method: 'POST',
          url: String(url || ''),
          requestHeaders: {},
          requestBody: truncate(data || ''),
          status: 'beacon-sent',
          responseBody: '',
        })
      }
      return originalSendBeacon(url, data)
    }
  }

  const OriginalXHR = window.XMLHttpRequest
  window.XMLHttpRequest = function () {
    const xhr = new OriginalXHR()
    const meta = { method: '', url: '', requestHeaders: {}, requestBody: '', startedAt: '' }
    const originalOpen = xhr.open
    const originalSend = xhr.send
    const originalSetRequestHeader = xhr.setRequestHeader

    xhr.open = function (method, url, ...rest) {
      meta.method = String(method || 'GET').toUpperCase()
      meta.url = String(url || '')
      return originalOpen.call(xhr, method, url, ...rest)
    }

    xhr.setRequestHeader = function (key, value) {
      meta.requestHeaders[key] = value
      return originalSetRequestHeader.call(xhr, key, value)
    }

    xhr.send = function (body) {
      meta.startedAt = now()
      meta.requestBody = truncate(body || '')
      xhr.addEventListener('loadend', () => {
        if (!shouldRecord(meta.url)) return
        emit({
          type: 'xhr',
          startedAt: meta.startedAt,
          endedAt: now(),
          method: meta.method,
          url: meta.url,
          requestHeaders: meta.requestHeaders,
          requestBody: meta.requestBody,
          status: xhr.status,
          statusText: xhr.statusText,
          responseBody: truncate(xhr.responseText || ''),
        })
      })
      return originalSend.call(xhr, body)
    }

    return xhr
  }

  emit({ type: 'recorder-installed', at: now() })
})()
