const EXTENSION_STATE = {
  panelInjected: false,
  launcherInjected: false,
  observerStarted: false,
  httpRecords: [],
  recorderInstalled: false,
  recorderEnabled: false,
  mappingItems: [],
  lastSubmitResult: null,
  liveSchemaSnapshot: null,
  lastUserEditAt: 0,
  syncRequestedAt: 0,
  syncStatus: 'idle',
  latestSavedDraftBase: null,
  lastSaveProbe: null,
  lastPatchedSubmitPreview: null,
  baseCapture: null,
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    try {
      if (!chrome?.runtime?.id) {
        resolve(null)
        return
      }
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[DDE] runtime message skipped:', chrome.runtime.lastError.message)
          resolve(null)
          return
        }
        resolve(response || null)
      })
    } catch (error) {
      console.warn('[DDE] runtime context unavailable:', error?.message || error)
      resolve(null)
    }
  })
}

function isDoudianHost() {
  return location.hostname === 'fxg.jinritemai.com'
}

function isProductCreateOrEditUrl() {
  const href = location.href
  return href.includes('/ffa/g/create') || href.includes('/ffa/create') || href.includes('/ffa/g/edit')
}

function hasTargetPageText() {
  const text = document.body?.innerText || ''
  return ['商品发布', '发布商品', '编辑商品', '尺码表', '商品规格', '商家编码'].some((fragment) => text.includes(fragment))
}

function isTargetPage() {
  return isDoudianHost() && isProductCreateOrEditUrl() && hasTargetPageText()
}

function createLauncher() {
  const button = document.createElement('button')
  button.id = 'doecommerce-tag-launcher'
  button.textContent = 'HTTP 规格分析'
  button.addEventListener('click', () => {
    const panel = document.getElementById('doecommerce-tag-panel')
    if (!panel) return
    panel.classList.toggle('dde-hidden')
    void refreshPanelData()
  })
  document.body.appendChild(button)
}

async function injectHttpRecorder() {
  if (EXTENSION_STATE.recorderInstalled) return
  EXTENSION_STATE.recorderInstalled = true

  const script = document.createElement('script')
  script.src = chrome.runtime.getURL('injected-recorder.js')
  script.onload = async () => {
    script.remove()
    const snapshot = await getHttpRecorderSnapshot()
    EXTENSION_STATE.recorderEnabled = Boolean(snapshot.enabled)
    EXTENSION_STATE.httpRecords = snapshot.records || []
    if (EXTENSION_STATE.recorderEnabled) controlHttpRecorder('start')
    renderHttpRecorderStatus()
    renderParsedSummary()
  }
  ;(document.head || document.documentElement).appendChild(script)

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return
    const data = event.data || {}
    if (data.source !== 'DDE_HTTP_RECORDER') return
    const payload = data.payload || {}

    if (payload.type === 'recorder-state') {
      EXTENSION_STATE.recorderEnabled = Boolean(payload.enabled)
      renderHttpRecorderStatus()
      return
    }

    if (payload.type === 'submit-result') {
      EXTENSION_STATE.lastSubmitResult = payload
      const responseJson = parseJsonSafe(payload.responseBody || '')
      const appCode = responseJson?.code ?? responseJson?.errno
      const matchedSubmit = payload.submitToken && payload.submitToken === EXTENSION_STATE.lastPatchedSubmitPreview?.submitToken
      const submitOk = Boolean(payload.ok && (appCode === 0 || appCode === '0' || appCode == null))
      setHtml('dde-summary-box', `
        <div><span class="dde-badge ${submitOk ? 'success' : 'error'}">草稿提交${submitOk ? '成功' : '失败'}</span></div>
        <div class="dde-status-line">状态：${payload.status || '-'} ${escapeHtml(payload.statusText || payload.error || '')}${appCode != null ? `；code=${escapeHtml(String(appCode))}` : ''}</div>
        <div class="dde-status-line">返回：${escapeHtml(String(payload.responseBody || '').slice(0, 500))}</div>
        ${submitOk && matchedSubmit ? '<div class="dde-status-line">页面将在 1.2 秒后自动刷新，以加载抖店最新规格/SKU 状态。</div>' : ''}
      `)
      if (submitOk && matchedSubmit) {
        window.setTimeout(() => {
          location.reload()
        }, 1200)
      }
      return
    }

    if (payload.type === 'recorder-installed') return
    if (!isBusinessHttpRecord(payload)) return

    EXTENSION_STATE.httpRecords.push(payload)
    EXTENSION_STATE.httpRecords = EXTENSION_STATE.httpRecords.slice(-1000)
    const record = { ...payload, tabUrl: location.href }
    const beforeBaseAt = EXTENSION_STATE.latestSavedDraftBase?.capturedAt || 0
    updateLiveSchemaSnapshotFromRecord(record)

    const capture = EXTENSION_STATE.baseCapture
    let captureHandled = false
    if (capture?.active) {
      capture.seen += 1
      const afterBaseAt = EXTENSION_STATE.latestSavedDraftBase?.capturedAt || 0
      if (afterBaseAt && afterBaseAt !== beforeBaseAt) {
        const pendingAction = capture.pendingAction || ''
        await finishAutoBaseCapture()
        captureHandled = true
        setHtml('dde-summary-box', `
          <div><span class="dde-badge success">已自动获取草稿基座</span></div>
          <div class="dde-status-line">命中：${escapeHtml(EXTENSION_STATE.latestSavedDraftBase?.url || '-').slice(0, 160)}</div>
          <div class="dde-status-line">已检查业务请求 ${capture.seen}/${capture.maxRecords} 条，录制已自动停止。${pendingAction ? '正在继续执行后续动作。' : '现在可以继续提交草稿。'}</div>
        `)
        if (pendingAction === 'submit-all') window.setTimeout(() => { void submitAllCreateDraft() }, 300)
        if (pendingAction === 'submit-single') window.setTimeout(() => { void submitSingleCreateDraft() }, 300)
      } else if (capture.seen >= capture.maxRecords) {
        await finishAutoBaseCapture({ error: `连续 ${capture.maxRecords} 条业务请求内没有捕获到成功的 editWithSchema/addWithSchema 保存包` })
        captureHandled = true
        setHtml('dde-summary-box', `
          <div><span class="dde-badge error">自动获取草稿基座失败</span></div>
          <div class="dde-status-line">连续 ${capture.maxRecords} 条业务请求内没有捕获到成功的 editWithSchema/addWithSchema 保存包。</div>
          <div class="dde-status-line">请确认当前是草稿商品页，然后重试；必要时手工点一次保存草稿。</div>
        `)
      }
    }

    renderHttpRecorderStatus()
    if (!captureHandled) renderParsedSummary()

    await sendRuntimeMessage({
      type: 'APPEND_HTTP_RECORD',
      record: payload,
      tabUrl: location.href,
    })
  })
}

function createPanel() {
  const panel = document.createElement('aside')
  panel.id = 'doecommerce-tag-panel'
  panel.className = 'dde-hidden'
  panel.innerHTML = `
    <div class="dde-panel-header">
      <h3>HTTP 规格分析</h3>
      <p>已移除 DOM 自动执行。当前仅保留 HTTP 录制、导出和规格/SKU 解析。</p>
    </div>
    <div class="dde-panel-body">
      <div class="dde-kv"><strong>页面识别</strong><span id="dde-page-status">检查中</span></div>
      <div class="dde-kv"><strong>当前商品</strong><span id="dde-product-status">等待解析</span></div>
      <div class="dde-kv"><strong>映射配置</strong><span id="dde-mapping-status">等待读取</span></div>
      <div class="dde-actions">
        <button class="dde-button secondary" id="dde-refresh-btn">刷新面板</button>
        <button class="dde-button secondary" id="dde-rec-start-btn">开始录制请求</button>
        <button class="dde-button secondary" id="dde-rec-stop-btn">停止录制</button>
        <button class="dde-button secondary" id="dde-rec-export-btn">导出请求</button>
        <button class="dde-button primary" id="dde-auto-base-btn">自动获取草稿基座</button>
        <button class="dde-button primary" id="dde-sync-btn">同步当前页面状态</button>
        <button class="dde-button primary" id="dde-parse-btn">解析规格列表</button>
        <button class="dde-button primary" id="dde-check-btn">检查编码映射</button>
      </div>
      <div class="dde-actions">
        <button class="dde-button secondary" id="dde-preview-create-btn">预览：仅创建颜色分类</button>
        <button class="dde-button secondary" id="dde-preview-fill-btn">预览：仅填写商家编码</button>
        <button class="dde-button secondary" id="dde-preview-upsert-btn">预览：同时处理</button>
        <button class="dde-button primary" id="dde-submit-create-btn">提交 1 条到草稿</button>
        <button class="dde-button primary" id="dde-submit-all-btn">提交全部到草稿</button>
      </div>
      <div class="dde-status" id="dde-recorder-status-box">
        <div><span class="dde-badge warn">HTTP 录制未开启</span></div>
        <div class="dde-status-line">会自动过滤埋点和静态资源，尽量保留业务请求。</div>
      </div>
      <div class="dde-status" id="dde-summary-box">
        <div>等待操作</div>
        <div class="dde-status-line">录制后点击「解析规格列表」，从 diagnose_product / schema 请求里提取颜色分类、商家编码、库存。</div>
      </div>
      <div class="dde-preview" id="dde-preview-box">
        <strong>解析结果</strong>
        <div class="dde-status-line">暂无</div>
      </div>
      <div class="dde-log" id="dde-log-box">
        <strong>HTTP 请求录制</strong>
        <div class="dde-status-line">尚未开始</div>
      </div>
    </div>
  `
  document.body.appendChild(panel)

  panel.querySelector('#dde-refresh-btn')?.addEventListener('click', refreshPanelData)
  panel.querySelector('#dde-rec-start-btn')?.addEventListener('click', startHttpRecording)
  panel.querySelector('#dde-rec-stop-btn')?.addEventListener('click', stopHttpRecording)
  panel.querySelector('#dde-rec-export-btn')?.addEventListener('click', exportHttpRecords)
  panel.querySelector('#dde-auto-base-btn')?.addEventListener('click', autoCaptureDraftBase)
  panel.querySelector('#dde-sync-btn')?.addEventListener('click', syncCurrentPageState)
  panel.querySelector('#dde-parse-btn')?.addEventListener('click', refreshPanelData)
  panel.querySelector('#dde-check-btn')?.addEventListener('click', checkMappingAgainstCurrentProduct)
  panel.querySelector('#dde-preview-create-btn')?.addEventListener('click', () => previewPatchPlan('create-only'))
  panel.querySelector('#dde-preview-fill-btn')?.addEventListener('click', () => previewPatchPlan('fill-code-only'))
  panel.querySelector('#dde-preview-upsert-btn')?.addEventListener('click', () => previewPatchPlan('upsert-both'))
  panel.querySelector('#dde-submit-create-btn')?.addEventListener('click', submitSingleCreateDraft)
  panel.querySelector('#dde-submit-all-btn')?.addEventListener('click', submitAllCreateDraft)
}

function setText(id, text) {
  const node = document.getElementById(id)
  if (node) node.textContent = text
}

function setHtml(id, html) {
  const node = document.getElementById(id)
  if (node) node.innerHTML = html
}

function controlHttpRecorder(command) {
  window.postMessage({ source: 'DDE_HTTP_RECORDER_CONTROL', command }, '*')
}

function submitAddWithSchema(url, body, submitToken) {
  window.postMessage({ source: 'DDE_HTTP_SUBMITTER', command: 'submitAddWithSchema', url, body, submitToken }, '*')
}

function isBusinessHttpRecord(record) {
  const url = String(record?.url || '').toLowerCase()
  const method = String(record?.method || 'GET').toUpperCase()
  const requestBody = String(record?.requestBody || '')

  if (!url) return false

  const blockedHosts = [
    'mon.zijieapi.com',
    'mcs.zijieapi.com',
    'mssdk.bytedance.com',
    'tron.jiyunhudong.com',
  ]
  if (blockedHosts.some((host) => url.includes(host))) return false

  const blockedExts = ['.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.map']
  if (blockedExts.some((ext) => url.includes(ext))) return false

  if (url.includes('api.feelgood.cn') || url.includes('abtestvm.bytedance.com') || url.includes('vcs.zijieapi.com')) return false
  if (url.includes('fxg.jinritemai.com')) return true
  if (url.includes('/product/') || url.includes('/schema') || url.includes('/diagnose_product') || url.includes('/save') || url.includes('/update') || url.includes('/edit')) return true
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && requestBody.trim()) return true

  return false
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function formatTime(ts) {
  if (!ts) return '-'
  try {
    return new Date(Number(ts)).toLocaleTimeString('zh-CN', { hour12: false })
  } catch (_error) {
    return String(ts)
  }
}

function renderHttpRecorderStatus() {
  const records = EXTENSION_STATE.httpRecords || []
  const last = records[records.length - 1]
  const statusBadge = EXTENSION_STATE.recorderEnabled
    ? '<span class="dde-badge recording">● 录制中</span>'
    : '<span class="dde-badge warn">录制已停止</span>'
  const lastLine = last
    ? `最后请求：${last.method || ''} ${escapeHtml(last.url || '').slice(0, 180)}，状态 ${last.status || last.error || '-'}`
    : '暂无业务请求。'
  const syncBadgeMap = {
    idle: '<span class="dde-badge warn">未同步</span>',
    waiting: '<span class="dde-badge warn">同步中</span>',
    ready: '<span class="dde-badge success">已同步</span>',
    stale: '<span class="dde-badge error">快照过期</span>',
  }
  const live = EXTENSION_STATE.liveSchemaSnapshot
  const syncLine = live
    ? `快照：${escapeHtml(live.sourceUrl || '-').slice(0, 120)}｜时间 ${formatTime(live.capturedAt)}｜最后编辑 ${formatTime(EXTENSION_STATE.lastUserEditAt)}`
    : `快照：暂无｜最后编辑 ${formatTime(EXTENSION_STATE.lastUserEditAt)}`
  const savedBase = EXTENSION_STATE.latestSavedDraftBase
  const saveProbe = EXTENSION_STATE.lastSaveProbe
  const capture = EXTENSION_STATE.baseCapture
  const savedBaseLine = savedBase
    ? `手工保存基座：${savedBase.mode}｜${escapeHtml(savedBase.url || '-').slice(0, 80)}｜${formatTime(savedBase.capturedAt)}｜product_id ${escapeHtml(savedBase.productId || '-')}`
    : (saveProbe ? `保存请求命中但未成基座：${escapeHtml(saveProbe.reason || '-')}｜${escapeHtml(saveProbe.url || '-').slice(0, 80)}｜状态 ${escapeHtml(saveProbe.status || '-')}` : '手工保存基座：暂无')
  const captureLine = capture?.active
    ? `自动捕获基座中：已看 ${capture.seen}/${capture.maxRecords} 条业务请求；等待 editWithSchema/addWithSchema 成功保存包`
    : (capture?.error ? `自动捕获基座失败：${escapeHtml(capture.error)}` : '')

  setHtml('dde-recorder-status-box', `
    <div>${statusBadge} ${syncBadgeMap[EXTENSION_STATE.syncStatus] || syncBadgeMap.idle}</div>
    <div class="dde-status-line">已捕获业务请求：${records.length} 条</div>
    ${captureLine ? `<div class="dde-status-line">${captureLine}</div>` : ''}
    <div class="dde-status-line">${lastLine}</div>
    <div class="dde-status-line">${syncLine}</div>
    <div class="dde-status-line">${savedBaseLine}</div>
  `)

  const startBtn = document.getElementById('dde-rec-start-btn')
  const stopBtn = document.getElementById('dde-rec-stop-btn')
  const syncBtn = document.getElementById('dde-sync-btn')
  if (startBtn) startBtn.textContent = EXTENSION_STATE.recorderEnabled ? `录制中 ${records.length}` : '开始录制请求'
  if (stopBtn) stopBtn.textContent = EXTENSION_STATE.recorderEnabled ? '停止录制' : '已停止录制'
  if (syncBtn) syncBtn.textContent = EXTENSION_STATE.syncStatus === 'waiting' ? '等待同步结果...' : '同步当前页面状态'

  setHtml('dde-log-box', `
    <strong>HTTP 请求录制</strong>
    <div class="dde-status-line">状态：${EXTENSION_STATE.recorderEnabled ? '录制中' : '已停止'}；已捕获业务请求：${records.length} 条</div>
    ${captureLine ? `<div class="dde-status-line">${captureLine}</div>` : ''}
    <div class="dde-status-line">已自动过滤埋点、静态资源、问卷/ABTest/VC 设置接口。</div>
    <div class="dde-status-line">${lastLine}</div>
    <div class="dde-status-line">${syncLine}</div>
    <div class="dde-status-line">${savedBaseLine}</div>
  `)
}

async function getHttpRecorderSnapshot() {
  const response = await sendRuntimeMessage({ type: 'GET_HTTP_RECORDER_STATE' })
  return {
    enabled: Boolean(response?.enabled),
    records: Array.isArray(response?.records) ? response.records : [],
  }
}

async function getMappingSnapshot() {
  const response = await sendRuntimeMessage({ type: 'GET_STORAGE_SNAPSHOT' })
  const data = response?.data || {}
  const items = Array.isArray(data.mappingData) ? data.mappingData : []
  const validItems = items.filter((item) => item?.isValid !== false)
  const invalidItems = items.filter((item) => item?.isValid === false)
  return {
    items,
    validItems,
    invalidItems,
    meta: data.mappingMeta || null,
  }
}

async function startHttpRecording() {
  await injectHttpRecorder()
  await sendRuntimeMessage({ type: 'CLEAR_HTTP_RECORDS' })
  await sendRuntimeMessage({ type: 'SET_HTTP_RECORDER_ENABLED', enabled: true })
  EXTENSION_STATE.httpRecords = []
  EXTENSION_STATE.liveSchemaSnapshot = null
  EXTENSION_STATE.latestSavedDraftBase = null
  EXTENSION_STATE.lastSaveProbe = null
  EXTENSION_STATE.recorderEnabled = true
  EXTENSION_STATE.syncStatus = 'idle'
  EXTENSION_STATE.syncRequestedAt = 0
  controlHttpRecorder('start')
  renderHttpRecorderStatus()
  renderParsedSummary()
}

async function stopHttpRecording() {
  await sendRuntimeMessage({ type: 'SET_HTTP_RECORDER_ENABLED', enabled: false })
  controlHttpRecorder('stop')
  EXTENSION_STATE.recorderEnabled = false
  if (EXTENSION_STATE.baseCapture?.active) EXTENSION_STATE.baseCapture.active = false
  renderHttpRecorderStatus()
}

async function startAutoBaseCapture({ maxRecords = 30, pendingAction = '' } = {}) {
  await injectHttpRecorder()
  await sendRuntimeMessage({ type: 'CLEAR_HTTP_RECORDS' })
  await sendRuntimeMessage({ type: 'SET_HTTP_RECORDER_ENABLED', enabled: true })
  EXTENSION_STATE.httpRecords = []
  EXTENSION_STATE.liveSchemaSnapshot = null
  EXTENSION_STATE.latestSavedDraftBase = null
  EXTENSION_STATE.lastSaveProbe = null
  EXTENSION_STATE.recorderEnabled = true
  EXTENSION_STATE.syncStatus = 'idle'
  EXTENSION_STATE.syncRequestedAt = 0
  EXTENSION_STATE.baseCapture = {
    active: true,
    seen: 0,
    maxRecords,
    startedAt: Date.now(),
    error: '',
    pendingAction,
  }
  controlHttpRecorder('start')
  renderHttpRecorderStatus()
}

async function finishAutoBaseCapture({ error = '' } = {}) {
  if (!EXTENSION_STATE.baseCapture) return
  EXTENSION_STATE.baseCapture.active = false
  EXTENSION_STATE.baseCapture.error = error
  await sendRuntimeMessage({ type: 'SET_HTTP_RECORDER_ENABLED', enabled: false })
  controlHttpRecorder('stop')
  EXTENSION_STATE.recorderEnabled = false
  renderHttpRecorderStatus()
}

async function exportHttpRecords() {
  const snapshot = await getHttpRecorderSnapshot()
  const records = snapshot.records || []
  EXTENSION_STATE.httpRecords = records
  EXTENSION_STATE.recorderEnabled = snapshot.enabled
  if (!records.length) {
    window.alert('暂无请求记录')
    return
  }
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `抖店请求录制-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text)
  } catch (_error) {
    return null
  }
}

function isSamePageRecord(record) {
  const tabUrl = String(record?.tabUrl || '')
  const current = String(location.href || '')
  if (!tabUrl || !current) return false
  if (tabUrl === current) return true
  try {
    const a = new URL(tabUrl, location.origin)
    const b = new URL(current, location.origin)
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search
  } catch (_error) {
    return false
  }
}

function isRelatedProductPageRecord(record) {
  if (isSamePageRecord(record)) return true
  const tabUrl = String(record?.tabUrl || '')
  if (!tabUrl) return false
  try {
    const a = new URL(tabUrl, location.origin)
    const b = new URL(location.href, location.origin)
    if (a.origin !== b.origin) return false
    return a.pathname.includes('/ffa/') && b.pathname.includes('/ffa/')
  } catch (_error) {
    return false
  }
}

function extractSchemaSnapshotFromRecord(record) {
  const body = parseJsonSafe(record?.requestBody || '')
  if (!body) return null
  const model = body?.schema?.model || body?.model || null
  const context = body?.context || null
  const schemaContext = body?.schema?.context || null
  if (!model?.spec_detail?.value || !model?.sku_detail?.value) return null
  return {
    sourceUrl: String(record?.url || ''),
    tabUrl: String(record?.tabUrl || ''),
    capturedAt: record?.capturedAt || Date.now(),
    model,
    context,
    schemaContext,
    rawBody: body,
  }
}

function updateLiveSchemaSnapshotFromRecord(record) {
  if (!isRelatedProductPageRecord(record)) return
  const snapshot = extractSchemaSnapshotFromRecord(record)
  if (!snapshot) return
  const sourceUrl = snapshot.sourceUrl.toLowerCase()
  const weight = sourceUrl.includes('diagnose_product') ? 5
    : sourceUrl.includes('refetchschema') ? 4
    : sourceUrl.includes('asyncrefetchschema') ? 3
    : sourceUrl.includes('addwithschema') ? 2
    : 1
  const currentWeight = EXTENSION_STATE.liveSchemaSnapshot?.weight || 0
  const currentAt = EXTENSION_STATE.liveSchemaSnapshot?.capturedAt || 0
  const isNewer = snapshot.capturedAt >= currentAt
  if (!EXTENSION_STATE.liveSchemaSnapshot || weight > currentWeight || (weight === currentWeight && isNewer)) {
    EXTENSION_STATE.liveSchemaSnapshot = { ...snapshot, weight }
  }

  const body = snapshot.rawBody || null
  const resp = parseJsonSafe(record?.responseBody || '')
  const isSaveUrl = sourceUrl.includes('/product/tproduct/addwithschema') || sourceUrl.includes('/product/tproduct/editwithschema')
  const isSaveOk = resp && Number(resp.code) === 0
  if (isSaveUrl) {
    EXTENSION_STATE.lastSaveProbe = {
      url: String(record?.url || ''),
      status: String(record?.status || ''),
      capturedAt: snapshot.capturedAt,
      reason: !body ? 'requestBody 不是有效 JSON'
        : !body?.schema?.model ? '缺少 schema.model'
          : !resp ? 'responseBody 不是有效 JSON'
            : !isSaveOk ? `保存响应未成功 code=${resp.code}`
              : '等待记录',
    }
  }
  if (isSaveUrl && isSaveOk && body?.schema?.model) {
    EXTENSION_STATE.latestSavedDraftBase = {
      mode: sourceUrl.includes('/editwithschema') ? 'edit' : 'create',
      url: String(record?.url || ''),
      body,
      capturedAt: snapshot.capturedAt,
      productId: String(resp?.data?.product_id || body?.product_id || body?.context?.product_id || ''),
      tabUrl: String(record?.tabUrl || ''),
    }
    EXTENSION_STATE.lastSaveProbe.reason = '已记录为可用基座'
  }

  if (EXTENSION_STATE.syncRequestedAt && snapshot.capturedAt >= EXTENSION_STATE.syncRequestedAt && snapshot.capturedAt >= (EXTENSION_STATE.lastUserEditAt || 0)) {
    EXTENSION_STATE.syncStatus = 'ready'
  } else if (EXTENSION_STATE.lastUserEditAt && EXTENSION_STATE.liveSchemaSnapshot?.capturedAt && EXTENSION_STATE.liveSchemaSnapshot.capturedAt < EXTENSION_STATE.lastUserEditAt) {
    EXTENSION_STATE.syncStatus = 'stale'
  }
}

function findBestSchemaModel(records) {
  const preferred = [
    '/product_diagnose/tproduct/diagnose_product',
    '/product/tproduct/sizecomponentprecheck',
    '/product/tproduct/refetchschema',
    '/product/tproduct/asyncrefetchschema',
  ]

  const sorted = [...records].sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0))

  for (const keyword of preferred) {
    for (const record of sorted) {
      const url = String(record?.url || '').toLowerCase()
      if (!url.includes(keyword)) continue
      const body = parseJsonSafe(record.requestBody || '')
      const model = body?.schema?.model || body?.model || null
      if (model?.spec_detail?.value && model?.sku_detail?.value) {
        return { model, source: record.url, capturedAt: record.capturedAt }
      }
    }
  }

  for (const record of sorted) {
    const body = parseJsonSafe(record.requestBody || '')
    const model = body?.schema?.model || body?.model || null
    if (model?.spec_detail?.value && model?.sku_detail?.value) {
      return { model, source: record.url, capturedAt: record.capturedAt }
    }
  }

  return null
}

function extractSkuRows(model) {
  const specs = Array.isArray(model?.spec_detail?.value) ? model.spec_detail.value : []
  const skus = Array.isArray(model?.sku_detail?.value) ? model.sku_detail.value : []

  const colorSpec = specs.find((item) => item?.name === '颜色分类') || null
  const sizeSpec = specs.find((item) => item?.name === '尺码大小' || item?.name === '尺码') || null

  const colorMap = new Map((colorSpec?.spec_values || []).map((item) => [String(item.id), item.name || '']))
  const sizeMap = new Map((sizeSpec?.spec_values || []).map((item) => [String(item.id), item.name || '']))

  const rows = skus.map((sku) => {
    const ids = Array.isArray(sku?.spec_detail_ids) ? sku.spec_detail_ids.map(String) : []
    let color = ''
    let size = ''

    for (const id of ids) {
      if (!color && colorMap.has(id)) color = colorMap.get(id) || ''
      if (!size && sizeMap.has(id)) size = sizeMap.get(id) || ''
    }

    return {
      color,
      size,
      code: sku?.code || '',
      price: sku?.price || '',
      stockNum: sku?.stock_info?.stock_num ?? '',
      stockIncNum: sku?.stock_info?.stock_inc_num ?? '',
      selfSellStock: sku?.self_sell_stock ?? '',
      skuId: sku?.sku_id || sku?.id || '',
      specDetailIds: ids,
    }
  })

  return {
    rows,
    colorCount: colorMap.size,
    sizeCount: sizeMap.size,
    skuCount: rows.length,
    colorSpec,
    sizeSpec,
  }
}

function renderParsedSummary() {
  const parsed = findBestSchemaModel(EXTENSION_STATE.httpRecords)
  if (!parsed) {
    setText('dde-product-status', '未找到可解析 schema')
    setHtml('dde-summary-box', `
      <div><span class="dde-badge warn">尚未解析到商品 schema</span></div>
      <div class="dde-status-line">请先录制编辑页相关请求，再点击「解析规格列表」。</div>
    `)
    setHtml('dde-preview-box', '<strong>解析结果</strong><div class="dde-status-line">暂无</div>')
    return
  }

  const result = extractSkuRows(parsed.model)
  const previewRows = result.rows.slice(0, 20).map((row) => `
    <tr>
      <td>${escapeHtml(row.color || '-')}</td>
      <td>${escapeHtml(row.size || '-')}</td>
      <td>${escapeHtml(row.code || '-')}</td>
      <td>${escapeHtml(String(row.stockNum ?? '-'))}</td>
      <td>${escapeHtml(String(row.price ?? '-'))}</td>
    </tr>
  `).join('')

  setText('dde-product-status', `颜色 ${result.colorCount} / 尺码 ${result.sizeCount} / SKU ${result.skuCount}`)
  setHtml('dde-summary-box', `
    <div><span class="dde-badge success">已解析商品规格</span></div>
    <div class="dde-status-line">来源：${escapeHtml(parsed.source).slice(0, 180)}</div>
    <div class="dde-status-line">颜色分类 ${result.colorCount} 个，尺码 ${result.sizeCount} 个，SKU ${result.skuCount} 条。</div>
    <div class="dde-status-line">当前按「颜色分类 / 尺码 / 商家编码 / 库存 / 价格」解析。</div>
  `)
  setHtml('dde-preview-box', `
    <strong>解析结果</strong>
    <div class="dde-status-line">显示前 ${Math.min(result.rows.length, 20)}/${result.rows.length} 条</div>
    <table>
      <thead><tr><th>颜色分类</th><th>尺码</th><th>商家编码</th><th>库存</th><th>价格</th></tr></thead>
      <tbody>${previewRows}</tbody>
    </table>
  `)
}

function hasFreshSyncedSnapshot() {
  const live = EXTENSION_STATE.liveSchemaSnapshot
  if (!live) return false
  if (EXTENSION_STATE.syncStatus !== 'ready') return false
  if (EXTENSION_STATE.lastUserEditAt && live.capturedAt < EXTENSION_STATE.lastUserEditAt) return false
  if (EXTENSION_STATE.syncRequestedAt && live.capturedAt < EXTENSION_STATE.syncRequestedAt) return false
  return true
}

function getParsedProductState() {
  const live = EXTENSION_STATE.liveSchemaSnapshot
  const parsed = live ? { model: live.model, source: live.sourceUrl, capturedAt: live.capturedAt } : findBestSchemaModel(EXTENSION_STATE.httpRecords)
  if (!parsed) return null
  const model = live?.model || parsed.model
  const extracted = extractSkuRows(model)
  return {
    parsed,
    model,
    rows: extracted.rows,
    colorSpec: extracted.colorSpec,
    sizeSpec: extracted.sizeSpec,
    colorCount: extracted.colorCount,
    sizeCount: extracted.sizeCount,
    skuCount: extracted.skuCount,
    context: live?.context || null,
    schemaContext: live?.schemaContext || null,
    liveSnapshot: live,
  }
}

function noteUserEdit() {
  EXTENSION_STATE.lastUserEditAt = Date.now()
  if (EXTENSION_STATE.liveSchemaSnapshot?.capturedAt && EXTENSION_STATE.liveSchemaSnapshot.capturedAt < EXTENSION_STATE.lastUserEditAt) {
    EXTENSION_STATE.syncStatus = 'stale'
    renderHttpRecorderStatus()
  }
}

function installUserEditTracker() {
  if (window.__DDE_USER_EDIT_TRACKER_INSTALLED__) return
  window.__DDE_USER_EDIT_TRACKER_INSTALLED__ = true
  const handler = (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (!target.closest('form') && !target.closest('[class*=form]') && !target.closest('[class*=Form]')) return
    noteUserEdit()
  }
  document.addEventListener('input', handler, true)
  document.addEventListener('change', handler, true)
  document.addEventListener('blur', handler, true)
}

async function syncCurrentPageState() {
  if (!EXTENSION_STATE.recorderEnabled) {
    setHtml('dde-summary-box', '<div><span class="dde-badge error">录制未开启</span></div><div class="dde-status-line">请先点开始录制，再执行同步。</div>')
    return
  }
  EXTENSION_STATE.syncRequestedAt = Date.now()
  EXTENSION_STATE.syncStatus = 'waiting'
  renderHttpRecorderStatus()
  setHtml('dde-summary-box', `
    <div><span class="dde-badge warn">等待同步当前页面状态</span></div>
    <div class="dde-status-line">请立即在页面做一个会触发校验/诊断的动作（例如改标题后点空白处），或者直接手工点一次保存草稿。</div>
    <div class="dde-status-line">目标：捕获一条时间晚于最后编辑时间的完整 schema 请求。</div>
  `)

  window.setTimeout(() => {
    if (EXTENSION_STATE.syncStatus === 'waiting') {
      EXTENSION_STATE.syncStatus = hasFreshSyncedSnapshot() ? 'ready' : 'stale'
      renderHttpRecorderStatus()
      if (EXTENSION_STATE.syncStatus !== 'ready') {
        setHtml('dde-summary-box', `
          <div><span class="dde-badge error">同步未完成</span></div>
          <div class="dde-status-line">5 秒内未拿到新的完整 schema 快照。</div>
          <div class="dde-status-line">请在当前页改一个字段并失焦，再点一次同步。</div>
        `)
      }
    }
  }, 5000)
}

function generateTempId(prefix = 'tmp') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function generateDoudianSpecValueId() {
  // 手工成功样本中，新颜色分类 id 是 18 位数字字符串，例如 990671970423753552。
  const min = 900000000000000000n
  const randomPart = BigInt(Math.floor(Math.random() * 9000000000000000))
  const timePart = BigInt(Date.now() % 1000000) * 10000000000n
  return String(min + timePart + randomPart).slice(0, 18)
}

function generateDoudianSkuId() {
  // 手工成功样本中，新 SKU 只有 id，没有 sku_id，格式类似 51dc9f2d6ad9-ad6c82-f3986fefe686。
  const hex = () => Math.random().toString(16).slice(2)
  return `${hex().padEnd(12, '0').slice(0, 12)}-${hex().padEnd(6, '0').slice(0, 6)}-${hex().padEnd(12, '0').slice(0, 12)}`
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function buildMinimalCreateSku({ specValueId, sizeId, code }) {
  return {
    id: generateDoudianSkuId(),
    stock_info: {
      stock_num: 0,
    },
    step_stock_info: {
      stock_num: 0,
      stock_inc_num: 0,
      multi_delivery_day_stocks: [
        {
          time_type: '15',
          time_desc: '15天内',
          stock_num: 0,
          stock_inc_num: 0,
        },
      ],
    },
    sku_status: true,
    confirm_no_barcode: false,
    spec_detail_ids: [specValueId, sizeId],
    code: code || '',
  }
}

function buildStructuredPatch(mode, validItems, productState) {
  const pageMap = buildPageMapping(productState.rows)
  const colorSpec = productState.colorSpec
  const sizeSpec = productState.sizeSpec
  const defaultSizeId = String(sizeSpec?.spec_values?.[0]?.id || '')
  const existingColorValues = Array.isArray(colorSpec?.spec_values) ? colorSpec.spec_values : []
  const colorNameSet = new Set(existingColorValues.map((item) => String(item.name || '').trim()))

  const patch = {
    mode,
    summary: {
      createSpecs: 0,
      createSkus: 0,
      updateCodes: 0,
      skipped: 0,
    },
    createSpecValues: [],
    createSkus: [],
    updateSkuCodes: [],
    skipped: [],
  }

  for (const item of validItems) {
    const liveRoomCode = String(item.liveRoomCode || '').trim()
    const shopCode = String(item.shopCode || '').trim()
    if (!liveRoomCode) continue

    const pageRow = pageMap.get(liveRoomCode)

    if (mode === 'create-only') {
      if (pageRow || colorNameSet.has(liveRoomCode)) {
        patch.skipped.push({ reason: '已存在颜色分类', liveRoomCode, shopCode, actualCode: pageRow?.code || '' })
        continue
      }

      const newSpecValueId = generateDoudianSpecValueId()
      patch.createSpecValues.push({
        specName: '颜色分类',
        specId: String(colorSpec?.id || ''),
        newSpecValue: { id: newSpecValueId, name: liveRoomCode, cpv_id: 0 },
      })

      if (defaultSizeId) {
        const newSku = buildMinimalCreateSku({ specValueId: newSpecValueId, sizeId: defaultSizeId, code: '' })
        patch.createSkus.push({
          liveRoomCode,
          shopCode,
          sku: newSku,
        })
      }

      colorNameSet.add(liveRoomCode)
      continue
    }

    if (mode === 'fill-code-only') {
      if (!pageRow) {
        patch.skipped.push({ reason: '页面缺少颜色分类', liveRoomCode, shopCode })
        continue
      }
      if (String(pageRow.code || '').trim() === shopCode) {
        patch.skipped.push({ reason: '商家编码已正确', liveRoomCode, shopCode, actualCode: pageRow.code || '' })
        continue
      }
      patch.updateSkuCodes.push({
        liveRoomCode,
        shopCode,
        skuId: pageRow.skuId || '',
        previousCode: pageRow.code || '',
        nextCode: shopCode,
      })
      continue
    }

    if (!pageRow && !colorNameSet.has(liveRoomCode)) {
      const newSpecValueId = generateDoudianSpecValueId()
      patch.createSpecValues.push({
        specName: '颜色分类',
        specId: String(colorSpec?.id || ''),
        newSpecValue: { id: newSpecValueId, name: liveRoomCode, cpv_id: 0 },
      })

      if (defaultSizeId) {
        const newSku = buildMinimalCreateSku({ specValueId: newSpecValueId, sizeId: defaultSizeId, code: shopCode })
        patch.createSkus.push({
          liveRoomCode,
          shopCode,
          sku: newSku,
        })
      }

      colorNameSet.add(liveRoomCode)
      continue
    }

    if (pageRow && String(pageRow.code || '').trim() !== shopCode) {
      patch.updateSkuCodes.push({
        liveRoomCode,
        shopCode,
        skuId: pageRow.skuId || '',
        previousCode: pageRow.code || '',
        nextCode: shopCode,
      })
      continue
    }

    patch.skipped.push({ reason: '已存在且编码正确', liveRoomCode, shopCode, actualCode: pageRow?.code || '' })
  }

  patch.summary.createSpecs = patch.createSpecValues.length
  patch.summary.createSkus = patch.createSkus.length
  patch.summary.updateCodes = patch.updateSkuCodes.length
  patch.summary.skipped = patch.skipped.length

  return patch
}

function renderMappingStatus(snapshot) {
  const count = snapshot.items.length
  const validCount = snapshot.validItems.length
  const invalidCount = snapshot.invalidItems.length
  if (!count) {
    setText('dde-mapping-status', '未导入 Excel')
    return
  }
  setText('dde-mapping-status', `${count} 条 / 可用 ${validCount} / 异常 ${invalidCount}`)
}

function buildPageMapping(rows) {
  const map = new Map()
  for (const row of rows) {
    const key = String(row.color || '').trim()
    if (!key) continue
    map.set(key, row)
  }
  return map
}

function buildExcelMapping(items) {
  const map = new Map()
  for (const item of items) {
    const key = String(item.liveRoomCode || '').trim()
    if (!key) continue
    map.set(key, item)
  }
  return map
}

function renderCheckResult(result) {
  const lines = [
    `匹配 ${result.matched.length}`,
    `缺少颜色分类 ${result.missingColor.length}`,
    `页面商家编码为空 ${result.missingCode.length}`,
    `商家编码不一致 ${result.codeMismatch.length}`,
    `页面多余颜色分类 ${result.extraInPage.length}`,
  ]

  const sampleRows = [
    ...result.codeMismatch.slice(0, 10).map((item) => ({ type: '编码不一致', color: item.liveRoomCode, expected: item.expectedShopCode, actual: item.actualShopCode })),
    ...result.missingColor.slice(0, 10).map((item) => ({ type: '缺少颜色分类', color: item.liveRoomCode, expected: item.shopCode || '', actual: '-' })),
    ...result.missingCode.slice(0, 10).map((item) => ({ type: '页面编码为空', color: item.liveRoomCode, expected: item.expectedShopCode, actual: '' })),
    ...result.extraInPage.slice(0, 10).map((item) => ({ type: '页面多余', color: item.color, expected: '-', actual: item.code || '' })),
  ]

  const table = sampleRows.length
    ? `<table><thead><tr><th>类型</th><th>颜色分类</th><th>期望编码</th><th>页面编码</th></tr></thead><tbody>${sampleRows.map((row) => `<tr><td>${escapeHtml(row.type)}</td><td>${escapeHtml(row.color)}</td><td>${escapeHtml(row.expected || '-')}</td><td>${escapeHtml(row.actual || '-')}</td></tr>`).join('')}</tbody></table>`
    : '<div class="dde-status-line">没有异常项，映射看起来是干净的。</div>'

  setHtml('dde-summary-box', `
    <div><span class="dde-badge ${result.codeMismatch.length || result.missingColor.length || result.missingCode.length ? 'warn' : 'success'}">映射检查完成</span></div>
    <div class="dde-status-line">${lines.join('；')}</div>
    <div class="dde-status-line">检查基于当前页面解析到的颜色分类 / 商家编码，与 popup 导入的 Excel 映射对比。</div>
  `)

  setHtml('dde-preview-box', `
    <strong>映射检查结果</strong>
    <div class="dde-status-line">${lines.join('｜')}</div>
    ${table}
  `)
}

function buildPatchPlan(mode, validItems, productState) {
  const structuredPatch = buildStructuredPatch(mode, validItems, productState)
  const defaultSize = String(productState.rows.find((row) => row.size)?.size || '')
  const templateRow = productState.rows[0] || null

  return {
    mode,
    defaultSize,
    templatePrice: templateRow?.price || '',
    createSpecs: structuredPatch.createSpecValues.map((item, index) => ({
      liveRoomCode: item.newSpecValue.name,
      shopCode: structuredPatch.createSkus[index]?.shopCode || '',
      size: defaultSize,
      price: templateRow?.price || '',
      code: structuredPatch.createSkus[index]?.sku?.code || '',
      tempSpecValueId: item.newSpecValue.id,
    })),
    updateCodes: structuredPatch.updateSkuCodes.map((item) => ({
      liveRoomCode: item.liveRoomCode,
      shopCode: item.shopCode,
      previousCode: item.previousCode,
      size: productState.rows.find((row) => row.skuId === item.skuId)?.size || defaultSize,
      skuId: item.skuId,
    })),
    skipped: structuredPatch.skipped,
    structuredPatch,
  }
}

function renderPatchPlan(plan) {
  const modeNameMap = {
    'create-only': '仅创建颜色分类',
    'fill-code-only': '仅填写商家编码',
    'upsert-both': '同时处理',
  }
  const modeName = modeNameMap[plan.mode] || plan.mode

  const previewRows = [
    ...plan.createSpecs.slice(0, 10).map((item) => ({ action: '创建颜色分类', color: item.liveRoomCode, size: item.size || '-', from: '-', to: item.code || '-' })),
    ...plan.updateCodes.slice(0, 10).map((item) => ({ action: '更新商家编码', color: item.liveRoomCode, size: item.size || '-', from: item.previousCode || '-', to: item.shopCode || '-' })),
    ...plan.skipped.slice(0, 10).map((item) => ({ action: `跳过：${item.reason}`, color: item.liveRoomCode, size: item.size || '-', from: item.actualCode || '-', to: item.shopCode || '-' })),
  ]

  const table = previewRows.length
    ? `<table><thead><tr><th>动作</th><th>颜色分类</th><th>尺码</th><th>当前编码</th><th>目标编码</th></tr></thead><tbody>${previewRows.map((row) => `<tr><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.color || '-')}</td><td>${escapeHtml(row.size || '-')}</td><td>${escapeHtml(row.from || '-')}</td><td>${escapeHtml(row.to || '-')}</td></tr>`).join('')}</tbody></table>`
    : '<div class="dde-status-line">没有需要预览的变更。</div>'

  const patchMeta = plan.structuredPatch?.summary
  setHtml('dde-summary-box', `
    <div><span class="dde-badge success">变更预览已生成</span></div>
    <div class="dde-status-line">模式：${modeName}</div>
    <div class="dde-status-line">将创建颜色分类 ${plan.createSpecs.length} 条；将更新商家编码 ${plan.updateCodes.length} 条；跳过 ${plan.skipped.length} 条。</div>
    <div class="dde-status-line">结构化 patch：spec_values +${patchMeta?.createSpecs || 0}，sku +${patchMeta?.createSkus || 0}，sku.code 更新 ${patchMeta?.updateCodes || 0}。</div>
    <div class="dde-status-line">当前仅生成 patch preview，尚未提交到抖店后端。</div>
  `)

  setHtml('dde-preview-box', `
    <strong>变更预览</strong>
    <div class="dde-status-line">默认尺码：${escapeHtml(plan.defaultSize || '-')}；参考价格：${escapeHtml(plan.templatePrice || '-')}</div>
    <div class="dde-status-line">Patch 概览：新增规格值 ${patchMeta?.createSpecs || 0} / 新增 SKU ${patchMeta?.createSkus || 0} / 更新编码 ${patchMeta?.updateCodes || 0}</div>
    ${table}
  `)
}

function isCreatePageContext(record, body) {
  const tabUrl = String(record?.tabUrl || '')
  const productId = String(body?.context?.product_id ?? '')
  if (tabUrl.includes('entrance=copy')) return true
  if (tabUrl.includes('/ffa/g/create') && !tabUrl.includes('entrance=draft') && !tabUrl.includes('product_id=')) return true
  return productId === '0'
}

function findCurrentCreateAddWithSchemaBase() {
  const records = [...(EXTENSION_STATE.httpRecords || [])].reverse()
  for (const record of records) {
    if (!isSamePageRecord(record)) continue
    const url = String(record?.url || '')
    if (!url.includes('/product/tproduct/addWithSchema')) continue
    const body = parseJsonSafe(record.requestBody || '')
    if (!body?.schema?.model) continue
    if (!isCreatePageContext(record, body)) continue
    return { url, body, tabUrl: record?.tabUrl || '' }
  }
  return null
}

function buildLiveCreateSubmissionBase(productState) {
  const live = productState?.liveSnapshot
  const pageToken = getQueryParam('__token')
  if (!live?.context || !live?.schemaContext || !productState?.model || !pageToken) return null
  const currentUrl = new URL(location.href)
  return {
    url: `/product/tproduct/addWithSchema?check_status=1&appid=1&__token=${encodeURIComponent(String(pageToken))}&_bid=ffa_goods&_lid=${Date.now()}`,
    body: {
      schema: {
        model: cloneJson(productState.model),
        context: cloneJson(live.schemaContext),
      },
      category_id: String(live.context?.category_id || getQueryParam('cid') || ''),
      context: cloneJson(live.context),
      pass_through_extra: {},
      request_extra: { _aToken: '' },
      check_status: 1,
      session: {},
      appid: 1,
      __token: String(pageToken),
      _bid: 'ffa_goods',
      _lid: String(Date.now()),
    },
    tabUrl: currentUrl.toString(),
  }
}

function getQueryParam(name) {
  try {
    return new URL(location.href).searchParams.get(name)
  } catch (_error) {
    return ''
  }
}

function applyStructuredPatchToRequest(baseRequest, structuredPatch) {
  const request = cloneJson(baseRequest)
  const model = request?.schema?.model
  if (!model) throw new Error('提交基座里没有 schema.model')

  const colorSpec = Array.isArray(model.spec_detail?.value)
    ? model.spec_detail.value.find((item) => item?.name === '颜色分类')
    : null
  if (!colorSpec) throw new Error('提交基座里找不到颜色分类规格')

  const beforeColorCount = Array.isArray(colorSpec.spec_values) ? colorSpec.spec_values.length : 0
  const beforeSkuCount = Array.isArray(model.sku_detail?.value) ? model.sku_detail.value.length : 0

  if (!Array.isArray(colorSpec.spec_values)) colorSpec.spec_values = []
  for (const item of structuredPatch.createSpecValues || []) {
    colorSpec.spec_values.push(item.newSpecValue)
  }

  if (!Array.isArray(model.sku_detail?.value)) throw new Error('提交基座里找不到 sku_detail.value')
  for (const item of structuredPatch.createSkus || []) {
    model.sku_detail.value.push(item.sku)
  }

  for (const update of structuredPatch.updateSkuCodes || []) {
    const target = model.sku_detail.value.find((sku) => String(sku.sku_id || sku.id || '') === String(update.skuId || ''))
    if (target) target.code = update.nextCode
  }

  const afterColorCount = Array.isArray(colorSpec.spec_values) ? colorSpec.spec_values.length : 0
  const afterSkuCount = Array.isArray(model.sku_detail?.value) ? model.sku_detail.value.length : 0
  request.__dde_patch_debug = {
    beforeColorCount,
    afterColorCount,
    beforeSkuCount,
    afterSkuCount,
    createSpecValues: structuredPatch.createSpecValues?.length || 0,
    createSkus: structuredPatch.createSkus?.length || 0,
    updateSkuCodes: structuredPatch.updateSkuCodes?.length || 0,
    lastCreatedSpec: structuredPatch.createSpecValues?.slice(-1)?.[0]?.newSpecValue || null,
    lastCreatedSku: structuredPatch.createSkus?.slice(-1)?.[0]?.sku || null,
  }

  return request
}

function isLikelyCreatePageNow() {
  const href = String(location.href || '')
  return href.includes('/ffa/g/create') && (href.includes('entrance=copy') || (!href.includes('entrance=draft') && !href.includes('product_id=')))
}

function getSavedDraftProductState() {
  const saved = EXTENSION_STATE.latestSavedDraftBase
  const model = saved?.body?.schema?.model
  if (!saved || !model) return null
  const extracted = extractSkuRows(model)
  return {
    parsed: { model, source: saved.url, capturedAt: saved.capturedAt },
    model,
    rows: extracted.rows,
    colorSpec: extracted.colorSpec,
    sizeSpec: extracted.sizeSpec,
    colorCount: extracted.colorCount,
    sizeCount: extracted.sizeCount,
    skuCount: extracted.skuCount,
    context: saved.body?.context || null,
    schemaContext: saved.body?.schema?.context || null,
    liveSnapshot: {
      sourceUrl: saved.url,
      capturedAt: saved.capturedAt,
      model,
      context: saved.body?.context || null,
      schemaContext: saved.body?.schema?.context || null,
    },
  }
}

function findNextPatchableItem(validItems, productState) {
  for (const item of validItems) {
    const patch = buildStructuredPatch('upsert-both', [item], productState)
    if (patch.createSpecValues.length || patch.createSkus.length || patch.updateSkuCodes.length) {
      return { item, patch }
    }
  }
  return { item: null, patch: null }
}

async function prepareDraftSubmissionBase({ autoCaptureAction = '' } = {}) {
  const savedBase = EXTENSION_STATE.latestSavedDraftBase
  if (!savedBase && !isLikelyCreatePageNow()) {
    if (autoCaptureAction) {
      await startAutoBaseCapture({ maxRecords: 30, pendingAction: autoCaptureAction })
      return { waitingForBase: true }
    }
    return { errorHtml: '<div><span class="dde-badge error">缺少手工保存基座</span></div><div class="dde-status-line">旧商品/草稿页请先点“自动获取草稿基座”，然后点击页面“保存草稿”。插件会精准等待成功保存包并自动停止。</div>' }
  }

  if (!savedBase && !hasFreshSyncedSnapshot()) {
    return { errorHtml: '<div><span class="dde-badge error">缺少最新同步快照</span></div><div class="dde-status-line">请先点“同步当前页面状态”，并在页面做一次触发诊断/校验的动作。</div>' }
  }

  const productState = getSavedDraftProductState() || getParsedProductState()
  if (!productState) {
    return { errorHtml: '<div><span class="dde-badge error">未解析到商品 schema</span></div><div class="dde-status-line">请先录制创建页业务请求。</div>' }
  }

  const base = savedBase
    ? { url: savedBase.url, body: savedBase.body, tabUrl: savedBase.tabUrl, mode: savedBase.mode }
    : (buildLiveCreateSubmissionBase(productState) || findCurrentCreateAddWithSchemaBase())
  if (!base) {
    return { errorHtml: '<div><span class="dde-badge error">缺少当前页实时提交基座</span></div><div class="dde-status-line">请先点开始录制，再手工保存一次草稿或触发一次业务请求。</div>' }
  }

  return { base, productState }
}

function submitStructuredPatch({ base, productState, structuredPatch, title, targetLine }) {
  const requestBody = applyStructuredPatchToRequest(base.body, structuredPatch)
  const patchDebug = requestBody.__dde_patch_debug || {}
  delete requestBody.__dde_patch_debug
  if (base.mode !== 'edit') {
    requestBody.context = requestBody.context || {}
    requestBody.context.product_id = 0
    if (requestBody.schema?.context) requestBody.schema.context.product_id = 0
  }
  EXTENSION_STATE.lastPatchedSubmitPreview = {
    url: base.url,
    mode: base.mode || 'create',
    at: Date.now(),
    patchDebug,
  }

  const submitToken = generateTempId('submit')
  setHtml('dde-summary-box', `
    <div><span class="dde-badge warn">${escapeHtml(title)}</span></div>
    <div class="dde-status-line">${targetLine}</div>
    <div class="dde-status-line">将新增规格值 ${structuredPatch.summary.createSpecs} / 新增 SKU ${structuredPatch.summary.createSkus} / 更新编码 ${structuredPatch.summary.updateCodes} / 跳过 ${structuredPatch.summary.skipped}</div>
    <div class="dde-status-line">patch 后：颜色 ${patchDebug.beforeColorCount} → ${patchDebug.afterColorCount}；SKU ${patchDebug.beforeSkuCount} → ${patchDebug.afterSkuCount}</div>
    <div class="dde-status-line">基座：${escapeHtml(base.url)}</div>
    <div class="dde-status-line">同步快照：${escapeHtml(productState.liveSnapshot?.sourceUrl || '-').slice(0, 120)} @ ${formatTime(productState.liveSnapshot?.capturedAt || 0)}</div>
  `)
  submitAddWithSchema(base.url, requestBody, submitToken)
}

async function autoCaptureDraftBase() {
  if (!location.href.includes('entrance=draft') && !location.href.includes('/ffa/g/edit')) {
    setHtml('dde-summary-box', '<div><span class="dde-badge error">只允许草稿商品</span></div><div class="dde-status-line">请进入草稿箱商品详情页后再自动获取基座。</div>')
    return
  }
  await startAutoBaseCapture({ maxRecords: 30 })
  setHtml('dde-summary-box', `
    <div><span class="dde-badge warn">正在自动获取草稿基座</span></div>
    <div class="dde-status-line">插件已自动开启精准录制，只等待成功的 editWithSchema/addWithSchema 保存包。</div>
    <div class="dde-status-line">请现在点击页面「保存草稿」。最多检查 30 条业务请求，命中后会自动停止录制。</div>
  `)
}

async function submitSingleCreateDraft() {
  const mappingSnapshot = await getMappingSnapshot()
  const allValidItems = mappingSnapshot.validItems
  if (!allValidItems.length) {
    setHtml('dde-summary-box', '<div><span class="dde-badge error">没有可提交数据</span></div><div class="dde-status-line">请先在 popup 导入至少 1 条有效映射。</div>')
    return
  }

  const prepared = await prepareDraftSubmissionBase({ autoCaptureAction: 'submit-single' })
  if (prepared.waitingForBase) {
    setHtml('dde-summary-box', `
      <div><span class="dde-badge warn">等待草稿基座</span></div>
      <div class="dde-status-line">插件已自动开启精准录制。请点击页面「保存草稿」，捕获成功后会自动继续提交 1 条。</div>
      <div class="dde-status-line">最多检查 30 条业务请求，未命中会自动停止并报错。</div>
    `)
    return
  }
  if (prepared.errorHtml) {
    setHtml('dde-summary-box', prepared.errorHtml)
    return
  }
  const { base, productState } = prepared

  const { item: nextItem, patch: structuredPatch } = findNextPatchableItem(allValidItems, productState)
  if (!nextItem || !structuredPatch) {
    setHtml('dde-summary-box', '<div><span class="dde-badge warn">无需提交</span></div><div class="dde-status-line">Excel 里的有效映射在当前模型下都没有新变更。</div>')
    return
  }

  submitStructuredPatch({
    base,
    productState,
    structuredPatch,
    title: '正在提交 1 条草稿',
    targetLine: `目标：${escapeHtml(nextItem.liveRoomCode || '-')} -> ${escapeHtml(nextItem.shopCode || '-')}`,
  })
}

async function submitAllCreateDraft() {
  const mappingSnapshot = await getMappingSnapshot()
  const allValidItems = mappingSnapshot.validItems
  if (!allValidItems.length) {
    setHtml('dde-summary-box', '<div><span class="dde-badge error">没有可提交数据</span></div><div class="dde-status-line">请先在 popup 导入至少 1 条有效映射。</div>')
    return
  }

  const prepared = await prepareDraftSubmissionBase({ autoCaptureAction: 'submit-all' })
  if (prepared.waitingForBase) {
    setHtml('dde-summary-box', `
      <div><span class="dde-badge warn">等待草稿基座</span></div>
      <div class="dde-status-line">插件已自动开启精准录制。请点击页面「保存草稿」，捕获成功后会自动继续提交全部到草稿。</div>
      <div class="dde-status-line">最多检查 30 条业务请求，未命中会自动停止并报错。</div>
    `)
    return
  }
  if (prepared.errorHtml) {
    setHtml('dde-summary-box', prepared.errorHtml)
    return
  }
  const { base, productState } = prepared
  const structuredPatch = buildStructuredPatch('upsert-both', allValidItems, productState)
  if (!structuredPatch.createSpecValues.length && !structuredPatch.createSkus.length && !structuredPatch.updateSkuCodes.length) {
    setHtml('dde-summary-box', '<div><span class="dde-badge warn">无需提交</span></div><div class="dde-status-line">Excel 里的有效映射在当前模型下都没有新变更。</div>')
    return
  }

  submitStructuredPatch({
    base,
    productState,
    structuredPatch,
    title: '正在提交全部到草稿',
    targetLine: `本次处理 Excel 有效映射 ${allValidItems.length} 条；新 SKU 参数已按手工 G001/G002 成功样本生成：规格值 18 位数字 ID，SKU 仅保留短 UUID id，不带 sku_id。`,
  })
}

async function previewPatchPlan(mode) {
  const mappingSnapshot = await getMappingSnapshot()
  EXTENSION_STATE.mappingItems = mappingSnapshot.items
  renderMappingStatus(mappingSnapshot)

  if (!mappingSnapshot.validItems.length) {
    setHtml('dde-summary-box', '<div><span class="dde-badge error">未导入可用映射</span></div><div class="dde-status-line">请先在 popup 导入 Excel，并确保至少有 1 条有效数据。</div>')
    return
  }

  const productState = getParsedProductState()
  if (!productState) {
    setHtml('dde-summary-box', '<div><span class="dde-badge error">未解析到商品 schema</span></div><div class="dde-status-line">请先录制编辑页业务请求，再生成变更预览。</div>')
    return
  }

  const plan = buildPatchPlan(mode, mappingSnapshot.validItems, productState)
  renderPatchPlan(plan)

  await sendRuntimeMessage({
    type: 'APPEND_EXECUTION_LOG',
    summary: `预览 ${mode}：创建 ${plan.createSpecs.length}，更新 ${plan.updateCodes.length}，跳过 ${plan.skipped.length}`,
    details: {
      phase: 'patch-preview',
      mode,
      counts: {
        createSpecs: plan.createSpecs.length,
        updateCodes: plan.updateCodes.length,
        skipped: plan.skipped.length,
        structuredCreateSpecs: plan.structuredPatch?.summary?.createSpecs || 0,
        structuredCreateSkus: plan.structuredPatch?.summary?.createSkus || 0,
        structuredUpdateCodes: plan.structuredPatch?.summary?.updateCodes || 0,
      },
      plan,
      url: location.href,
    },
  })
}

async function checkMappingAgainstCurrentProduct() {
  const mappingSnapshot = await getMappingSnapshot()
  EXTENSION_STATE.mappingItems = mappingSnapshot.items
  renderMappingStatus(mappingSnapshot)

  if (!mappingSnapshot.validItems.length) {
    setHtml('dde-summary-box', '<div><span class="dde-badge error">未导入可用映射</span></div><div class="dde-status-line">请先在 popup 导入 Excel，并确保至少有 1 条有效数据。</div>')
    return
  }

  const parsed = findBestSchemaModel(EXTENSION_STATE.httpRecords)
  if (!parsed) {
    setHtml('dde-summary-box', '<div><span class="dde-badge error">未解析到商品 schema</span></div><div class="dde-status-line">请先录制编辑页业务请求，再执行映射检查。</div>')
    return
  }

  const { rows } = extractSkuRows(parsed.model)
  const pageMap = buildPageMapping(rows)
  const excelMap = buildExcelMapping(mappingSnapshot.validItems)

  const matched = []
  const missingColor = []
  const missingCode = []
  const codeMismatch = []
  const extraInPage = []

  for (const [liveRoomCode, item] of excelMap.entries()) {
    const pageRow = pageMap.get(liveRoomCode)
    const expectedShopCode = String(item.shopCode || '').trim()
    if (!pageRow) {
      missingColor.push(item)
      continue
    }
    const actualShopCode = String(pageRow.code || '').trim()
    if (!actualShopCode) {
      missingCode.push({ ...item, expectedShopCode, actualShopCode, pageRow })
      continue
    }
    if (actualShopCode !== expectedShopCode) {
      codeMismatch.push({ ...item, expectedShopCode, actualShopCode, pageRow })
      continue
    }
    matched.push({ ...item, pageRow })
  }

  for (const [color, row] of pageMap.entries()) {
    if (!excelMap.has(color)) extraInPage.push(row)
  }

  const result = { matched, missingColor, missingCode, codeMismatch, extraInPage }
  renderCheckResult(result)

  await sendRuntimeMessage({
    type: 'APPEND_EXECUTION_LOG',
    summary: `映射检查：匹配 ${matched.length}，缺色 ${missingColor.length}，空码 ${missingCode.length}，错码 ${codeMismatch.length}`,
    details: {
      phase: 'mapping-check',
      counts: {
        matched: matched.length,
        missingColor: missingColor.length,
        missingCode: missingCode.length,
        codeMismatch: codeMismatch.length,
        extraInPage: extraInPage.length,
      },
      result,
      url: location.href,
    },
  })
}

async function refreshPanelData() {
  setText('dde-page-status', isTargetPage() ? '已识别商品创建/编辑页' : '当前页不匹配')
  const recorderSnapshot = await getHttpRecorderSnapshot()
  EXTENSION_STATE.recorderEnabled = recorderSnapshot.enabled
  EXTENSION_STATE.httpRecords = recorderSnapshot.records
  const mappingSnapshot = await getMappingSnapshot()
  EXTENSION_STATE.mappingItems = mappingSnapshot.items
  renderMappingStatus(mappingSnapshot)
  renderHttpRecorderStatus()
  renderParsedSummary()
  const savedBase = EXTENSION_STATE.latestSavedDraftBase
  if (savedBase) {
    setHtml('dde-summary-box', `
      <div><span class="dde-badge success">已捕获手工保存基座</span></div>
      <div class="dde-status-line">模式：${savedBase.mode}</div>
      <div class="dde-status-line">来源：${escapeHtml(savedBase.url || '-').slice(0, 180)}</div>
      <div class="dde-status-line">时间：${formatTime(savedBase.capturedAt)}；product_id：${escapeHtml(savedBase.productId || '-')}</div>
    `)
  }
}

function ensureUiInjected() {
  if (!isTargetPage()) return
  installUserEditTracker()
  void injectHttpRecorder()

  if (!EXTENSION_STATE.launcherInjected && !document.getElementById('doecommerce-tag-launcher')) {
    createLauncher()
    EXTENSION_STATE.launcherInjected = true
  }

  if (!EXTENSION_STATE.panelInjected && !document.getElementById('doecommerce-tag-panel')) {
    createPanel()
    EXTENSION_STATE.panelInjected = true
    void refreshPanelData()
  }
}

function bootObserver() {
  if (EXTENSION_STATE.observerStarted) return
  EXTENSION_STATE.observerStarted = true

  const observer = new MutationObserver(() => {
    ensureUiInjected()
  })

  observer.observe(document.documentElement, { childList: true, subtree: true })
  ensureUiInjected()
}

bootObserver()
