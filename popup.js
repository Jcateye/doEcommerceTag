const headerAliases = {
  liveRoomCode: ['编码', '直播间编号', '直播间编码', '规格编号', '规格值', 'liveRoomCode', 'roomCode'],
  shopCode: ['店铺编号', '商家编码', '店铺编码', 'SKU编码', 'shopCode', 'merchantCode', 'outerCode'],
  remark: ['备注', '说明', 'remark'],
}

const fileInput = document.getElementById('fileInput')
const metaEl = document.getElementById('meta')
const logsEl = document.getElementById('logs')
const clearBtn = document.getElementById('clearBtn')
const refreshBtn = document.getElementById('refreshBtn')

function normalizeHeader(value) {
  return String(value || '').trim()
}

function findHeaderIndex(headers, aliases) {
  return headers.findIndex((header) => aliases.includes(normalizeHeader(header)))
}

function parseWorkbookRows(rows) {
  if (!rows.length) throw new Error('Excel 为空')

  const headers = rows[0].map(normalizeHeader)
  const liveRoomCodeIndex = findHeaderIndex(headers, headerAliases.liveRoomCode)
  const shopCodeIndex = findHeaderIndex(headers, headerAliases.shopCode)
  const remarkIndex = findHeaderIndex(headers, headerAliases.remark)

  if (liveRoomCodeIndex < 0) throw new Error('未找到“编码”表头')
  if (shopCodeIndex < 0) throw new Error('未找到“商家编码”表头')

  const items = rows.slice(1)
    .map((row, rowOffset) => ({
      liveRoomCode: String(row[liveRoomCodeIndex] || '').trim(),
      shopCode: String(row[shopCodeIndex] || '').trim(),
      remark: remarkIndex >= 0 ? String(row[remarkIndex] || '').trim() : '',
      rowIndex: rowOffset + 2,
      validationErrors: [],
      isValid: true,
    }))
    .filter((item) => item.liveRoomCode || item.shopCode || item.remark)

  const seen = new Set()
  for (const item of items) {
    if (!item.liveRoomCode) item.validationErrors.push('编码为空')
    if (!item.shopCode) item.validationErrors.push('商家编码为空')
    if (item.liveRoomCode && seen.has(item.liveRoomCode)) item.validationErrors.push('编码重复')
    if (item.liveRoomCode) seen.add(item.liveRoomCode)
    item.isValid = item.validationErrors.length === 0
  }

  return items
}

function renderMeta(meta, items) {
  const count = Array.isArray(items) ? items.length : 0
  if (!meta || !count) {
    metaEl.textContent = '暂无导入数据'
    return
  }

  const validCount = items.filter((item) => item.isValid !== false).length
  const invalidCount = count - validCount
  const importedAt = new Date(meta.importedAt).toLocaleString('zh-CN', { hour12: false })
  metaEl.innerHTML = `文件：${meta.fileName || '-'}<br>总数：${count}；可执行：${validCount}；异常：${invalidCount}<br>导入时间：${importedAt}`
}

function renderLogs(logs) {
  if (!logs?.length) {
    logsEl.className = 'logs empty'
    logsEl.textContent = '暂无执行日志'
    return
  }

  logsEl.className = 'logs'
  logsEl.innerHTML = logs.map((log) => {
    const time = new Date(log.createdAt).toLocaleString('zh-CN', { hour12: false })
    return `<div class="log-item"><strong>${log.summary || '执行记录'}</strong><div>${time}</div></div>`
  }).join('')
}

function refreshSnapshot() {
  chrome.runtime.sendMessage({ type: 'GET_STORAGE_SNAPSHOT' }, (response) => {
    if (!response?.ok) return
    const data = response.data || {}
    renderMeta(data.mappingMeta, Array.isArray(data.mappingData) ? data.mappingData : [])
    renderLogs(data.executionLogs || [])
  })
}

fileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0]
  if (!file) return

  try {
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer, { type: 'array' })
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: false })
    const items = parseWorkbookRows(rows)

    chrome.runtime.sendMessage({ type: 'SAVE_MAPPING', items, fileName: file.name }, (response) => {
      if (!response?.ok) {
        alert('保存失败')
        return
      }
      refreshSnapshot()
      const validCount = items.filter((item) => item.isValid !== false).length
      alert(`导入成功，共 ${items.length} 条；可执行 ${validCount} 条；异常 ${items.length - validCount} 条`)
    })
  } catch (error) {
    alert(error.message || 'Excel 解析失败')
  } finally {
    fileInput.value = ''
  }
})

clearBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_MAPPING' }, () => refreshSnapshot())
})

refreshBtn.addEventListener('click', refreshSnapshot)

refreshSnapshot()
