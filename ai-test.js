/**
 *
 * GPT & Gemini 双重检测 (最终修正版)
 *
 * 2026-01-02 更新:
 * 1. [精准] 适配 Gemini 访客模式 (无需登录直接显示对话框的情况)，修复部分节点误判。
 * 2. [极速] 保持低超时设置，防止 Sub-Store 订阅更新失败。
 *
 * HTTP META 参数
 * - [http_meta_start_delay] 初始启动延时. 默认: 500 (单位: ms)
 *
 * 其它参数
 * - [timeout] 单个请求超时. 默认 3000 (单位: ms)
 * - [concurrency] 并发数. 默认 15
 * - [gpt_prefix] GPT 显示前缀. 默认为 "[GPT] "
 * - [gemini_prefix] Gemini 显示前缀. 默认为 "[GM] "
 */

async function operator(proxies = [], targetPlatform, context) {
  const cacheEnabled = $arguments.cache
  const disableFailedCache = $arguments.disable_failed_cache || $arguments.ignore_failed_error
  const cache = scriptResourceCache
  const http_meta_host = $arguments.http_meta_host ?? '127.0.0.1'
  const http_meta_port = $arguments.http_meta_port ?? 9876
  const http_meta_protocol = $arguments.http_meta_protocol ?? 'http'
  const http_meta_authorization = $arguments.http_meta_authorization ?? ''
  const http_meta_api = `${http_meta_protocol}://${http_meta_host}:${http_meta_port}`
  
  // 极速设置：减少等待
  const http_meta_start_delay = parseFloat($arguments.http_meta_start_delay ?? 500) 
  const http_meta_proxy_timeout = parseFloat($arguments.http_meta_proxy_timeout ?? 5000)
  
  const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
  const geminiPrefix = $arguments.gemini_prefix ?? '[GM] '
  const method = $arguments.method || 'get'
  
  // 极速设置：请求超时 3秒
  const requestTimeout = parseFloat($arguments.timeout || 3000) 

  const urlGPT = $arguments.client === 'Android' ? `https://android.chat.openai.com` : `https://ios.chat.openai.com`
  const urlGemini = `https://gemini.google.com/app`

  const $ = $substore
  const internalProxies = []
  
  proxies.map((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        for (const key in proxy) {
          if (/^_/i.test(key)) node[key] = proxy[key]
        }
        internalProxies.push({ ...node, _proxies_index: index })
      }
    } catch (e) {
      $.error(e)
    }
  })

  // $.info(`核心支持节点数: ${internalProxies.length}/${proxies.length}`)
  if (!internalProxies.length) return proxies

  const http_meta_timeout = http_meta_start_delay + (internalProxies.length * http_meta_proxy_timeout)

  let http_meta_pid
  let http_meta_ports = []
  
  // 启动 HTTP META
  try {
    const res = await http({
      retries: 0,
      method: 'post',
      url: `${http_meta_api}/start`,
      headers: { 'Content-type': 'application/json', Authorization: http_meta_authorization },
      body: JSON.stringify({ proxies: internalProxies, timeout: http_meta_timeout }),
      timeout: 3000
    })
    let body = res.body
    try { body = JSON.parse(body) } catch (e) {}
    const { ports, pid } = body
    if (!pid || !ports) throw new Error(`启动失败: ${body}`)
    http_meta_pid = pid
    http_meta_ports = ports
    // $.info(`META启动: PID ${pid}`)
  } catch(e) {
    $.error(`HTTP META 启动异常: ${e.message}`)
    return proxies 
  }

  await $.wait(http_meta_start_delay)

  const concurrency = parseInt($arguments.concurrency || 15)
  
  await executeAsyncTasks(
    internalProxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

  // 关闭 HTTP META
  try {
    await http({
      method: 'post',
      url: `${http_meta_api}/stop`,
      headers: { 'Content-type': 'application/json', Authorization: http_meta_authorization },
      body: JSON.stringify({ pid: [http_meta_pid] }),
      timeout: 2000
    })
  } catch (e) {}

  return proxies

  async function check(proxy) {
    const index = internalProxies.indexOf(proxy)
    const proxyHost = `http://${http_meta_host}:${http_meta_ports[index]}`
    
    const [gptResult, geminiResult] = await Promise.all([
        checkTask(proxy, urlGPT, 'gpt', proxyHost),
        checkTask(proxy, urlGemini, 'gemini', proxyHost)
    ])

    let prefixToAdd = ""
    if (gptResult) prefixToAdd += gptPrefix
    if (geminiResult) prefixToAdd += geminiPrefix
    
    if (prefixToAdd) {
        proxies[proxy._proxies_index].name = `${prefixToAdd}${proxies[proxy._proxies_index].name}`
    }
  }

  async function checkTask(proxy, url, type, proxyUrl) {
    const id = cacheEnabled ? getCacheId({ proxy, url }) : undefined
    
    if (cacheEnabled) {
        const cached = cache.get(id)
        if (cached) {
            if (cached.ok) {
                updateProxyMetadata(proxy, type, cached.latency)
                return true
            } else if (!disableFailedCache) {
                return false
            }
        }
    }

    try {
        const startedAt = Date.now()
        const res = await http({
            proxy: proxyUrl,
            method,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            url,
            timeout: requestTimeout
        })
        
        const status = parseInt(res.status || res.statusCode || 200)
        const latency = Date.now() - startedAt
        let body = res.body ?? res.rawBody
        if (!body) body = ""
        body = String(body)

        let isSuccess = false
        
        // === 判定逻辑 ===
        if (type === 'gpt') {
            if (status === 403 && !body.includes('unsupported_country')) {
                isSuccess = true
            }
        } else if (type === 'gemini') {
            // Gemini 判定逻辑 (适配截图情况)
            // 成功条件：
            // 1. 状态码 200
            // 2. Body 不包含 "not available" (封锁提示)
            // 3. 必须包含 "Gemini" 字样
            // 4. 必须包含 登录相关 或者 对话相关 的交互元素
            
            if (status === 200 && !body.includes('not available in your country')) {
                // 特征 A: 传统的登录页 (Sign in / 登录 / identifierId)
                const isLoginPage = body.includes('identifierId') || body.includes('type="email"');
                
                // 特征 B: 访客模式 App (你的截图情况)
                // 包含 "Gemini" 且包含 "问问" 或 "Ask" 或 "Chat" 或 "登录"按钮
                const isGuestApp = body.includes('Gemini') && (
                    body.includes('问问') || 
                    body.includes('Ask') || 
                    body.includes('Chat') || 
                    body.includes('Sign in') ||
                    body.includes('登录')
                );

                if (isLoginPage || isGuestApp) {
                    isSuccess = true
                }
            }
        }

        if (isSuccess) {
            updateProxyMetadata(proxy, type, latency)
            if (cacheEnabled) cache.set(id, { ok: true, latency: latency })
            return true
        } else {
            if (cacheEnabled) cache.set(id, { ok: false })
            return false
        }

    } catch (e) {
        if (cacheEnabled) cache.set(id, { ok: false })
        return false
    }
  }

  function updateProxyMetadata(proxy, type, latency) {
      const p = proxies[proxy._proxies_index]
      if (type === 'gpt') {
          p._gpt = true
          p._gpt_latency = latency
      } else {
          p._gemini = true
          p._gemini_latency = latency
      }
  }

  async function http(opt = {}) {
    const METHOD = opt.method || 'get'
    const TIMEOUT = opt.timeout || 3000 
    const RETRIES = 0 
    const RETRY_DELAY = 100

    let count = 0
    const fn = async () => {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
      } catch (e) {
        if (count < RETRIES) {
          count++
          await $.wait(RETRY_DELAY)
          return await fn()
        } else {
          throw e
        }
      }
    }
    return await fn()
  }

  function getCacheId({ proxy = {}, url }) {
    return `http-meta:check:${url}:${JSON.stringify(
      Object.fromEntries(Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key)))
    )}`
  }

  function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        let running = 0
        let index = 0
        function executeNextTask() {
          while (index < tasks.length && running < concurrency) {
            const indexCopy = index++
            running++
            tasks[indexCopy]()
              .finally(() => {
                running--
                executeNextTask()
              })
          }
          if (running === 0 && index >= tasks.length) {
            resolve()
          }
        }
        executeNextTask()
      } catch (e) {
        reject(e)
      }
    })
  }
}
