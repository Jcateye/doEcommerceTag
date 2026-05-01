const EXTENSION_STATE = {
  panelInjected: false,
  launcherInjected: false,
  observerStarted: false,
}

const STORAGE_KEYS = {
  mapping: 'mappingData',
  meta: 'mappingMeta',
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
  button.textContent = '批量直播间规格'
  button.addEventListener('click', () => {
    const panel = document.getElementById('doecommerce-tag-panel')
    if (!panel) return
    panel.classList.toggle('dde-hidden')
    refreshPanelData()
  })
  document.body.appendChild(button)
}

function createPanel() {
  const panel = document.createElement('aside')
  panel.id = 'doecommerce-tag-panel'
  panel.className = 'dde-hidden'
  panel.innerHTML = `
    <div class="dde-panel-header">
      <h3>批量直播间规格</h3>
      <p>导入 Excel 后，在这里预览并执行。第一版默认写入“商家编码”字段。</p>
    </div>
    <div class="dde-panel-body">
      <div class="dde-kv"><strong>页面识别</strong><span id="dde-page-status">检查中</span></div>
      <div class="dde-kv"><strong>导入数据</strong><span id="dde-data-status">未导入</span></div>
      <div class="dde-run-options">
        <label>执行数量
          <select id="dde-run-limit">
            <option value="1" selected>先试 1 条</option>
            <option value="5">试 5 条</option>
            <option value="10">试 10 条</option>
            <option value="all">全部</option>
          </select>
        </label>
      </div>
      <div class="dde-actions">
        <button class="dde-button secondary" id="dde-refresh-btn">刷新面板</button>
        <button class="dde-button secondary" id="dde-diagnose-btn">诊断页面</button>
        <button class="dde-button primary" id="dde-preview-btn">扫描预览</button>
        <button class="dde-button primary" id="dde-run-btn">开始执行</button>
      </div>
      <div class="dde-status" id="dde-summary-box">
        <div>等待操作</div>
        <div class="dde-status-line">先在插件弹窗里导入 Excel，再回到此页执行。</div>
      </div>
      <div class="dde-preview" id="dde-preview-box">
        <strong>预览数据</strong>
        <div class="dde-status-line">暂无</div>
      </div>
      <div class="dde-log" id="dde-log-box">
        <strong>执行日志</strong>
        <div class="dde-status-line">尚未开始</div>
      </div>
    </div>
  `
  document.body.appendChild(panel)

  panel.querySelector('#dde-refresh-btn')?.addEventListener('click', refreshPanelData)
  panel.querySelector('#dde-diagnose-btn')?.addEventListener('click', diagnosePage)
  panel.querySelector('#dde-preview-btn')?.addEventListener('click', previewExecution)
  panel.querySelector('#dde-run-btn')?.addEventListener('click', runExecution)
}

function setText(id, text) {
  const node = document.getElementById(id)
  if (node) node.textContent = text
}

function setHtml(id, html) {
  const node = document.getElementById(id)
  if (node) node.innerHTML = html
}

function getStorageSnapshot() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEYS.mapping, STORAGE_KEYS.meta], (result) => {
      resolve({
        items: Array.isArray(result[STORAGE_KEYS.mapping]) ? result[STORAGE_KEYS.mapping] : [],
        meta: result[STORAGE_KEYS.meta] || null,
      })
    })
  })
}

function getImportedAtText(meta) {
  if (!meta?.importedAt) return '-'
  return new Date(meta.importedAt).toLocaleString('zh-CN', { hour12: false })
}

async function refreshPanelData() {
  setText('dde-page-status', isTargetPage() ? '已识别商品创建/编辑页' : '当前页不匹配')
  const snapshot = await getStorageSnapshot()
  const count = snapshot.items.length
  setHtml('dde-data-status', count ? `${count} 条（${getImportedAtText(snapshot.meta)}）` : '未导入')

  if (!count) {
    setHtml('dde-preview-box', '<strong>预览数据</strong><div class="dde-status-line">暂无导入数据</div>')
    return
  }

  const previewRows = snapshot.items.slice(0, 8).map((item) => `
    <tr>
      <td>${item.liveRoomCode}</td>
      <td>${item.shopCode}</td>
      <td>${item.remark || '-'}</td>
    </tr>
  `).join('')

  setHtml('dde-preview-box', `
    <strong>预览数据</strong>
    <table>
      <thead><tr><th>直播间编号</th><th>商家编码</th><th>备注</th></tr></thead>
      <tbody>${previewRows}</tbody>
    </table>
  `)
}

function collectCurrentPageLiveRoomCodes() {
  const text = document.body?.innerText || ''
  const matches = text.match(/D\d{3,4}/g) || []
  return [...new Set(matches)]
}

function summarizeVisibleButtons() {
  return getVisibleElements('button, [role="button"], a')
    .map((node) => getElementText(node).replace(/\s+/g, ' '))
    .filter(Boolean)
    .slice(0, 40)
}

function summarizeVisibleInputs() {
  return getVisibleElements('input, textarea').slice(0, 60).map((node, index) => ({
    index,
    tag: node.tagName.toLowerCase(),
    type: node.getAttribute('type') || '',
    value: node.value || '',
    placeholder: node.getAttribute('placeholder') || '',
    ariaLabel: node.getAttribute('aria-label') || '',
    disabled: Boolean(node.disabled),
  }))
}

function summarizeCandidateRows() {
  return getVisibleElements('tr, [data-row-key], .semi-table-row, .arco-table-tr, [class*="row"], [class*="Row"]')
    .map((node) => getElementText(node).replace(/\s+/g, ' '))
    .filter((text) => /D\d{3,4}/.test(text) || text.includes('商家编码') || text.includes('SKU编码'))
    .slice(0, 30)
}

function copyText(text) {
  return navigator.clipboard?.writeText(text).catch(() => undefined)
}

async function diagnosePage() {
  const diagnosis = {
    url: location.href,
    isTargetPage: isTargetPage(),
    liveRoomCodes: collectCurrentPageLiveRoomCodes(),
    colorSpecRootText: getElementText(findColorSpecRoot()).slice(0, 500),
    specRootText: getElementText(findSpecRoot()).slice(0, 500),
    addSpecButtonText: getElementText(findSpecAddButton()),
    addSpecTypeButtonText: getElementText(findSpecTypeAddButton()),
    popupText: getElementText(findOpenPopup()).slice(0, 500),
    buttons: summarizeVisibleButtons(),
    inputs: summarizeVisibleInputs(),
    candidateRows: summarizeCandidateRows(),
    createdAt: new Date().toISOString(),
  }

  const text = JSON.stringify(diagnosis, null, 2)
  await copyText(text)
  setHtml('dde-summary-box', `
    <div><span class="dde-badge success">诊断完成</span></div>
    <div class="dde-status-line">已扫描：按钮 ${diagnosis.buttons.length} 个，输入框 ${diagnosis.inputs.length} 个，候选行 ${diagnosis.candidateRows.length} 条。</div>
    <div class="dde-status-line">诊断 JSON 已尝试复制到剪贴板。</div>
  `)
  setHtml('dde-log-box', `
    <strong>页面诊断</strong>
    <pre class="dde-code">${escapeHtml(text)}</pre>
  `)

  chrome.runtime.sendMessage({
    type: 'APPEND_EXECUTION_LOG',
    summary: `页面诊断：输入框 ${diagnosis.inputs.length}，候选行 ${diagnosis.candidateRows.length}`,
    details: {
      phase: 'diagnose',
      diagnosis,
      url: location.href,
    },
  })
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

async function previewExecution() {
  const snapshot = await getStorageSnapshot()
  if (!snapshot.items.length) {
    setHtml('dde-summary-box', '<div class="dde-badge error">未导入 Excel</div><div class="dde-status-line">请先在插件弹窗导入数据。</div>')
    return
  }

  const existingCodes = collectCurrentPageLiveRoomCodes()
  const existingSet = new Set(existingCodes)
  const duplicated = snapshot.items.filter((item) => existingSet.has(item.liveRoomCode))
  const pending = snapshot.items.filter((item) => !existingSet.has(item.liveRoomCode))

  setHtml('dde-summary-box', `
    <div><span class="dde-badge success">Excel 总数 ${snapshot.items.length}</span></div>
    <div class="dde-status-line">页面已存在：${duplicated.length}；待创建：${pending.length}</div>
    <div class="dde-status-line">第一版执行器将以“商家编码”字段为目标。</div>
  `)

  chrome.runtime.sendMessage({
    type: 'APPEND_EXECUTION_LOG',
    summary: `预览完成：总 ${snapshot.items.length}，待创建 ${pending.length}`,
    details: {
      phase: 'preview',
      total: snapshot.items.length,
      existing: duplicated.length,
      pending: pending.length,
      url: location.href,
    },
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function getVisibleElements(selector) {
  return [...document.querySelectorAll(selector)].filter((node) => {
    const rect = node.getBoundingClientRect()
    const style = window.getComputedStyle(node)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  })
}

function getElementText(node) {
  return String(node?.innerText || node?.textContent || '').trim()
}

function findClickableByText(textList, scope = document) {
  const candidates = [...scope.querySelectorAll('button, [role="button"], a, span, div')].filter((node) => {
    const rect = node.getBoundingClientRect()
    const style = window.getComputedStyle(node)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  })
  return candidates.find((node) => {
    const text = getElementText(node)
    return textList.some((fragment) => text === fragment || text.includes(fragment))
  })
}

function clickElement(el) {
  if (!el) throw new Error('元素不存在')
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function setNativeInputValue(input, value) {
  if (!input) throw new Error('输入框不存在')
  const prototype = Object.getPrototypeOf(input)
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  if (descriptor?.set) {
    descriptor.set.call(input, value)
  } else {
    input.value = value
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }))
}

function findNearestBlockByText(labels) {
  const anchors = getVisibleElements('section, div, form, article').filter((node) => {
    const text = getElementText(node)
    return labels.some((label) => text.includes(label))
  })

  return anchors
    .map((node) => ({ node, area: node.getBoundingClientRect().width * node.getBoundingClientRect().height }))
    .filter((item) => item.area > 1000)
    .sort((a, b) => a.area - b.area)[0]?.node || document.body
}

function findSpecRoot() {
  return findNearestBlockByText(['颜色分类', '商品规格', '销售规格', '规格类型', '规格值', '尺码大小', '尺码表'])
}

function findColorSpecRoot() {
  return findNearestBlockByText(['颜色分类'])
}

function findSpecAddButton() {
  const colorRoot = findColorSpecRoot()
  const specRoot = findSpecRoot()
  return findClickableByText(['添加规格值', '新增规格值', '添加规格', '新增规格'], colorRoot)
    || findClickableByText(['添加规格值', '新增规格值', '添加规格', '新增规格'], specRoot)
    || findClickableByText(['添加规格值', '新增规格值', '添加规格', '新增规格'])
}

function findSpecTypeAddButton() {
  const root = findSpecRoot()
  return findClickableByText(['添加规格类型', '新增规格类型'], root)
    || findClickableByText(['添加规格类型', '新增规格类型'])
}

function getPopupCandidates() {
  const popupSelectors = [
    '[role="dialog"]',
    '[role="listbox"]',
    '[class*="popover"]',
    '[class*="Popover"]',
    '[class*="dropdown"]',
    '[class*="Dropdown"]',
    '[class*="select"]',
    '[class*="Select"]',
    '[class*="tooltip"]',
    '[class*="Tooltip"]',
  ]
  return popupSelectors
    .flatMap((selector) => getVisibleElements(selector))
    .filter((node, index, list) => list.indexOf(node) === index)
}

function findOpenPopup() {
  return getPopupCandidates()
    .filter((node) => {
      const text = getElementText(node)
      return text.includes('创建类型') || text.includes('确定') || text.includes('无合适选项') || /D\d{3,4}/.test(text)
    })
    .sort((a, b) => (b.getBoundingClientRect().width * b.getBoundingClientRect().height) - (a.getBoundingClientRect().width * a.getBoundingClientRect().height))[0] || null
}

function findConfirmButton(scope = document) {
  return findClickableByText(['确定', '确认', '完成', '保存'], scope)
}

async function waitForCondition(fn, timeout = 3000, interval = 100) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const result = fn()
    if (result) return result
    await sleep(interval)
  }
  return null
}

function findOptionByText(text, scope = document) {
  const candidates = [...scope.querySelectorAll('[role="option"], li, div, span, button')].filter((node) => {
    const rect = node.getBoundingClientRect()
    const style = window.getComputedStyle(node)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  })
  return candidates
    .map((node) => ({ node, label: getElementText(node).replace(/\s+/g, '') }))
    .filter((item) => item.label === text || item.label.includes(text))
    .sort((a, b) => a.label.length - b.label.length)[0]?.node || null
}

function findCheckButtonNear(node) {
  const scope = node?.closest?.('[role="dialog"], [class*="popover"], [class*="Popover"], [class*="dropdown"], [class*="Dropdown"], div') || document
  const buttons = [...scope.querySelectorAll('button, [role="button"], span, div')].filter((candidate) => {
    const rect = candidate.getBoundingClientRect()
    const style = window.getComputedStyle(candidate)
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return false
    const text = getElementText(candidate).replace(/\s+/g, '')
    const aria = String(candidate.getAttribute('aria-label') || '')
    const title = String(candidate.getAttribute('title') || '')
    return ['✓', '✔', '勾', '确定', '确认', '完成'].some((flag) => text.includes(flag) || aria.includes(flag) || title.includes(flag))
      || Boolean(candidate.querySelector('svg'))
  })
  return buttons.sort((a, b) => {
    const ar = a.getBoundingClientRect()
    const br = b.getBoundingClientRect()
    return (ar.width * ar.height) - (br.width * br.height)
  })[0] || null
}

function getEditableInputs() {
  return getVisibleElements('input:not([disabled]), textarea:not([disabled])')
}

function findLastEmptyTextInput(scope = document) {
  const root = scope === document ? document : scope
  const inputs = [...root.querySelectorAll('input:not([disabled]), textarea:not([disabled])')].filter((input) => {
    const rect = input.getBoundingClientRect()
    const style = window.getComputedStyle(input)
    const type = String(input.getAttribute('type') || 'text').toLowerCase()
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && ['text', 'search', ''].includes(type) && !input.value
  })
  return inputs[inputs.length - 1] || null
}

function findNewCandidateInput(beforeInputs) {
  const beforeSet = new Set(beforeInputs)
  const colorRoot = findColorSpecRoot()
  const specRoot = findSpecRoot()
  const newInput = getEditableInputs().find((input) => !beforeSet.has(input) && !input.value)
  return newInput || findLastEmptyTextInput(colorRoot) || findLastEmptyTextInput(specRoot) || findLastEmptyTextInput()
}

async function selectSpecValueFromDropdown(triggerInput, liveRoomCode) {
  const option = await waitForCondition(() => {
    const popup = findOpenPopup()
    return popup ? findOptionByText(liveRoomCode, popup) : findOptionByText(liveRoomCode)
  }, 2500)

  if (!option) return false
  clickElement(option)
  await sleep(250)

  const confirmButton = findConfirmButton(findOpenPopup() || document)
  if (confirmButton && getElementText(confirmButton).length <= 6) {
    clickElement(confirmButton)
    await sleep(250)
  } else if (triggerInput) {
    triggerInput.blur()
  }
  return true
}

async function clickCreateTypeIfPopupAppears(liveRoomCode, triggerInput) {
  const popup = findOpenPopup()
  if (!popup) return false

  const existingOption = findOptionByText(liveRoomCode, popup)
  if (existingOption) {
    clickElement(existingOption)
    await sleep(250)
    return true
  }

  const createButton = findClickableByText(['创建类型', '新建类型'], popup)
  if (!createButton) return false

  clickElement(createButton)
  await sleep(300)

  const createInput = await waitForCondition(() => findLastEmptyTextInput(findOpenPopup() || popup) || findLastEmptyTextInput(document), 2500)
  if (!createInput) throw new Error(`点击创建类型后找不到 ${liveRoomCode} 输入框`)

  clickElement(createInput)
  setNativeInputValue(createInput, liveRoomCode)
  await sleep(200)

  const checkButton = findCheckButtonNear(createInput) || findConfirmButton(findOpenPopup() || document)
  if (checkButton) {
    clickElement(checkButton)
  } else {
    createInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    createInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))
  }
  await sleep(500)

  const selected = await selectSpecValueFromDropdown(triggerInput, liveRoomCode)
  if (selected) return true

  if (triggerInput) {
    clickElement(triggerInput)
    await sleep(250)
    return selectSpecValueFromDropdown(triggerInput, liveRoomCode)
  }

  return true
}

async function createSpecValue(liveRoomCode) {
  if (collectCurrentPageLiveRoomCodes().includes(liveRoomCode)) {
    return { status: 'skipped', message: '页面已存在规格值' }
  }

  const addButton = findSpecAddButton()
  if (!addButton) {
    const typeButton = findSpecTypeAddButton()
    if (typeButton) throw new Error('只找到“添加规格类型”，未找到“颜色分类”下的添加规格值入口')
    throw new Error('找不到“颜色分类”下的添加规格值按钮')
  }

  const beforeInputs = getEditableInputs()
  clickElement(addButton)
  await sleep(400)

  const input = findNewCandidateInput(beforeInputs)
  if (!input) throw new Error('点击添加后找不到规格值输入框')

  clickElement(input)
  await sleep(120)
  setNativeInputValue(input, liveRoomCode)
  await sleep(350)

  const createdFromPopup = await clickCreateTypeIfPopupAppears(liveRoomCode, input)
  if (!createdFromPopup) {
    const selected = await selectSpecValueFromDropdown(input, liveRoomCode)
    if (!selected) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))
      input.blur()
    }
  }

  await sleep(500)
  return { status: 'success', message: createdFromPopup ? '规格值已创建并尝试选中' : '规格值已输入/选中' }
}

function findRowByLiveRoomCode(liveRoomCode) {
  const selectors = [
    'tr',
    '[class*="table"] [class*="row"]',
    '[class*="Table"] [class*="Row"]',
    '[data-row-key]',
    '.semi-table-row',
    '.arco-table-tr',
  ]
  for (const selector of selectors) {
    const row = getVisibleElements(selector).find((node) => getElementText(node).includes(liveRoomCode))
    if (row) return row
  }
  return null
}

function getElementCenterX(node) {
  const rect = node.getBoundingClientRect()
  return rect.left + rect.width / 2
}

function findTableLikeRoot(node) {
  let current = node
  while (current && current !== document.body) {
    const text = getElementText(current)
    if ((text.includes('商家编码') || text.includes('SKU编码')) && /D\d{3,4}/.test(text)) return current
    if (current.matches?.('table, [class*="table"], [class*="Table"], [role="table"], [class*="sku"], [class*="Sku"]')) return current
    current = current.parentElement
  }
  return document.body
}

function findHeaderCellByLabel(tableRoot, labels) {
  const candidates = [...tableRoot.querySelectorAll('th, [role="columnheader"], div, span')].filter((node) => {
    const text = getElementText(node).replace(/\s+/g, '')
    return labels.some((label) => text === label || text.includes(label))
  })
  return candidates
    .map((node) => ({ node, area: node.getBoundingClientRect().width * node.getBoundingClientRect().height }))
    .filter((item) => item.area > 20)
    .sort((a, b) => a.area - b.area)[0]?.node || null
}

function findInputNearestColumn(row, targetX) {
  const inputs = [...row.querySelectorAll('input:not([disabled]), textarea:not([disabled])')]
  if (!inputs.length) return null
  return inputs
    .map((input) => ({ input, distance: Math.abs(getElementCenterX(input) - targetX) }))
    .sort((a, b) => a.distance - b.distance)[0].input
}

function findMerchantCodeInputInRow(row) {
  if (!row) return null
  const inputs = [...row.querySelectorAll('input:not([disabled]), textarea:not([disabled])')]
  if (!inputs.length) return null
  if (inputs.length === 1) return inputs[0]

  const labels = ['商家编码', '店铺编号', 'SKU编码', '编码']

  const direct = inputs.find((input) => {
    const placeholder = String(input.getAttribute('placeholder') || '')
    const ariaLabel = String(input.getAttribute('aria-label') || '')
    const name = String(input.getAttribute('name') || '')
    return labels.some((label) => placeholder.includes(label) || ariaLabel.includes(label) || name.includes(label))
  })
  if (direct) return direct

  const tableRoot = findTableLikeRoot(row)
  const header = findHeaderCellByLabel(tableRoot, ['商家编码', 'SKU编码', '店铺编号'])
  if (header) {
    const byColumn = findInputNearestColumn(row, getElementCenterX(header))
    if (byColumn) return byColumn
  }

  const rowText = getElementText(row)
  if (labels.some((label) => rowText.includes(label))) return inputs[inputs.length - 1] || null
  return inputs[inputs.length - 1] || null
}

async function scrollFindRowByLiveRoomCode(liveRoomCode) {
  let row = findRowByLiveRoomCode(liveRoomCode)
  if (row) return row

  const scrollContainers = getVisibleElements('div, section, main').filter((node) => node.scrollHeight > node.clientHeight + 40)
  for (const container of scrollContainers.slice(0, 8)) {
    const originalTop = container.scrollTop
    for (let i = 0; i < 12; i += 1) {
      container.scrollTop = Math.min(container.scrollHeight, i * Math.max(160, container.clientHeight * 0.7))
      await sleep(120)
      row = findRowByLiveRoomCode(liveRoomCode)
      if (row) return row
    }
    container.scrollTop = originalTop
  }

  return null
}

async function writeMerchantCode(liveRoomCode, shopCode) {
  const row = await scrollFindRowByLiveRoomCode(liveRoomCode)
  if (!row) throw new Error(`找不到 ${liveRoomCode} 对应 SKU 行`)
  const input = findMerchantCodeInputInRow(row)
  if (!input) throw new Error(`找不到 ${liveRoomCode} 的商家编码输入框`)
  setNativeInputValue(input, shopCode)
  input.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
  return { status: 'success', message: '商家编码已写入' }
}

function renderExecutionResults(results) {
  const success = results.filter((item) => item.status === 'success').length
  const skipped = results.filter((item) => item.status === 'skipped').length
  const failed = results.filter((item) => item.status === 'failed').length
  const rows = results.slice(-12).reverse().map((item) => `
    <tr>
      <td>${item.liveRoomCode}</td>
      <td>${item.shopCode}</td>
      <td><span class="dde-badge ${item.status === 'success' ? 'success' : item.status === 'failed' ? 'error' : 'warn'}">${item.status}</span></td>
      <td>${item.message || '-'}</td>
    </tr>
  `).join('')

  setHtml('dde-log-box', `
    <strong>执行日志</strong>
    <div class="dde-status-line">成功：${success}；跳过：${skipped}；失败：${failed}</div>
    <div class="dde-preview" style="margin-top: 8px; padding: 8px;">
      <table>
        <thead><tr><th>直播间</th><th>商家编码</th><th>状态</th><th>说明</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `)
}

function getRunItems(items) {
  const select = document.getElementById('dde-run-limit')
  const value = select?.value || '1'
  if (value === 'all') return items
  const limit = Number(value) || 1
  return items.slice(0, limit)
}

async function runExecution() {
  const snapshot = await getStorageSnapshot()
  if (!snapshot.items.length) {
    setHtml('dde-log-box', '<strong>执行日志</strong><div class="dde-status-line">未导入 Excel，无法执行。</div>')
    return
  }

  const runItems = getRunItems(snapshot.items)
  const confirmed = window.confirm(`即将尝试处理 ${runItems.length}/${snapshot.items.length} 条规格。插件不会点击保存/发布。建议先只试 1 条。是否开始？`)
  if (!confirmed) return

  const results = []
  for (const item of runItems) {
    try {
      setHtml('dde-summary-box', `<div><span class="dde-badge warn">执行中</span></div><div class="dde-status-line">正在处理 ${item.liveRoomCode} -> ${item.shopCode}</div>`)
      const createResult = await createSpecValue(item.liveRoomCode)
      await sleep(randomBetween(600, 1000))
      const writeResult = await writeMerchantCode(item.liveRoomCode, item.shopCode)
      results.push({
        ...item,
        status: createResult.status === 'skipped' ? 'skipped' : writeResult.status,
        message: `${createResult.message}；${writeResult.message}`,
      })
    } catch (error) {
      results.push({
        ...item,
        status: 'failed',
        message: error.message || '执行失败',
      })
    }

    renderExecutionResults(results)
    await sleep(randomBetween(500, 1200))
  }

  const failed = results.filter((item) => item.status === 'failed').length
  setHtml('dde-summary-box', `
    <div><span class="dde-badge ${failed ? 'warn' : 'success'}">执行完成</span></div>
    <div class="dde-status-line">总数：${results.length}；失败：${failed}。请人工检查后再保存/发布。</div>
  `)

  chrome.runtime.sendMessage({
    type: 'APPEND_EXECUTION_LOG',
    summary: `执行完成：总 ${results.length}，失败 ${failed}`,
    details: {
      phase: 'run',
      total: results.length,
      failed,
      results,
      url: location.href,
    },
  })
}

function ensureUiInjected() {
  if (!isTargetPage()) return

  if (!EXTENSION_STATE.launcherInjected && !document.getElementById('doecommerce-tag-launcher')) {
    createLauncher()
    EXTENSION_STATE.launcherInjected = true
  }

  if (!EXTENSION_STATE.panelInjected && !document.getElementById('doecommerce-tag-panel')) {
    createPanel()
    EXTENSION_STATE.panelInjected = true
    refreshPanelData()
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
