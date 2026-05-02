const STORAGE_KEYS = {
  mapping: 'mappingData',
  meta: 'mappingMeta',
  logs: 'executionLogs',
  lastTask: 'lastTask',
  httpRecorderEnabled: 'httpRecorderEnabled',
  httpRecords: 'httpRecords',
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get([STORAGE_KEYS.logs, STORAGE_KEYS.httpRecords, STORAGE_KEYS.httpRecorderEnabled], (result) => {
    const payload = {}
    if (!Array.isArray(result[STORAGE_KEYS.logs])) payload[STORAGE_KEYS.logs] = []
    if (!Array.isArray(result[STORAGE_KEYS.httpRecords])) payload[STORAGE_KEYS.httpRecords] = []
    if (typeof result[STORAGE_KEYS.httpRecorderEnabled] !== 'boolean') payload[STORAGE_KEYS.httpRecorderEnabled] = false
    if (Object.keys(payload).length) chrome.storage.local.set(payload)
  })
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return

  if (message.type === 'GET_STORAGE_SNAPSHOT') {
    chrome.storage.local.get(Object.values(STORAGE_KEYS), (result) => {
      sendResponse({ ok: true, data: result })
    })
    return true
  }

  if (message.type === 'SAVE_MAPPING') {
    const payload = {
      [STORAGE_KEYS.mapping]: message.items || [],
      [STORAGE_KEYS.meta]: {
        importedAt: Date.now(),
        total: Array.isArray(message.items) ? message.items.length : 0,
        fileName: message.fileName || '',
      },
    }
    chrome.storage.local.set(payload, () => sendResponse({ ok: true }))
    return true
  }

  if (message.type === 'CLEAR_MAPPING') {
    chrome.storage.local.remove([STORAGE_KEYS.mapping, STORAGE_KEYS.meta, STORAGE_KEYS.lastTask], () => {
      sendResponse({ ok: true })
    })
    return true
  }

  if (message.type === 'APPEND_EXECUTION_LOG') {
    chrome.storage.local.get([STORAGE_KEYS.logs], (result) => {
      const logs = Array.isArray(result[STORAGE_KEYS.logs]) ? result[STORAGE_KEYS.logs] : []
      logs.unshift({
        id: `log_${Date.now()}`,
        createdAt: Date.now(),
        summary: message.summary || '',
        details: message.details || null,
      })
      chrome.storage.local.set({
        [STORAGE_KEYS.logs]: logs.slice(0, 50),
        [STORAGE_KEYS.lastTask]: message.details || null,
      }, () => sendResponse({ ok: true }))
    })
    return true
  }

  if (message.type === 'GET_HTTP_RECORDER_STATE') {
    chrome.storage.local.get([STORAGE_KEYS.httpRecorderEnabled, STORAGE_KEYS.httpRecords], (result) => {
      sendResponse({
        ok: true,
        enabled: Boolean(result[STORAGE_KEYS.httpRecorderEnabled]),
        records: Array.isArray(result[STORAGE_KEYS.httpRecords]) ? result[STORAGE_KEYS.httpRecords] : [],
      })
    })
    return true
  }

  if (message.type === 'SET_HTTP_RECORDER_ENABLED') {
    chrome.storage.local.set({ [STORAGE_KEYS.httpRecorderEnabled]: Boolean(message.enabled) }, () => {
      sendResponse({ ok: true, enabled: Boolean(message.enabled) })
    })
    return true
  }

  if (message.type === 'CLEAR_HTTP_RECORDS') {
    chrome.storage.local.set({ [STORAGE_KEYS.httpRecords]: [] }, () => sendResponse({ ok: true }))
    return true
  }

  if (message.type === 'APPEND_HTTP_RECORD') {
    chrome.storage.local.get([STORAGE_KEYS.httpRecords], (result) => {
      const records = Array.isArray(result[STORAGE_KEYS.httpRecords]) ? result[STORAGE_KEYS.httpRecords] : []
      records.push({
        ...message.record,
        capturedAt: Date.now(),
        tabUrl: message.tabUrl || '',
      })
      chrome.storage.local.set({ [STORAGE_KEYS.httpRecords]: records.slice(-1000) }, () => sendResponse({ ok: true }))
    })
    return true
  }
})
