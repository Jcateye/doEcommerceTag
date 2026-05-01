const STORAGE_KEYS = {
  mapping: 'mappingData',
  meta: 'mappingMeta',
  logs: 'executionLogs',
  lastTask: 'lastTask',
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get([STORAGE_KEYS.logs], (result) => {
    if (!Array.isArray(result[STORAGE_KEYS.logs])) {
      chrome.storage.local.set({ [STORAGE_KEYS.logs]: [] })
    }
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
})
