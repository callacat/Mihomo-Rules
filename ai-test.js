/**
 *
 * GPT & Gemini 双重检测 (核心数据签名版)
 *
 * 版本: v5.0 (Final)
 * * 核心原理:
 * 不再检测 UI 元素 (因为是动态渲染的)，而是检测 Google Wiz 框架的核心数据签名。
 * * 1. [SNlM0e] 或 [WIZ_global_data]: 只有真正的 Gemini 应用(含访客模式)才会加载这些初始化数据。
 * 2. [glue-header]: 只有营销/介绍页面才会有这个组件。
 *
 * 此逻辑可完美区分:
 * - 访客模式/已登录 (通过, 包含 WIZ_global_data)
 * - 地区不支持/跳营销页 (失败, 包含 glue-header 或 缺核心数据)
 *
 * HTTP META 参数
 * - [http_meta_start_delay] 初始启动延时. 默认: 500
 * - [timeout] 单个请求超时. 默认 5000
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
  
  const http_meta_start_delay = parseFloat($arguments.http_meta_start_delay ?? 500) 
  const http_meta_proxy_timeout = parseFloat($arguments.http_meta_proxy_timeout ?? 8000)
  
  const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
  const geminiPrefix = $arguments.gemini_prefix ?? '[GM] '
  const method = $arguments.method || 'get'
  
  const requestTimeout = parseFloat($arguments.timeout || 5000) 

  const urlGPT = $arguments.client === 'Android' ? `https://android.chat.openai.com` : `https://ios.chat.openai.com`
  // 必须检测 /app 路径，这是应用入口
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

  if (!internalProxies.length) return proxies

  const http_meta_timeout = http_meta_start_delay + (internalProxies.length * 200) + 10000
  let http_meta_pid
  let http_meta_ports = []
  
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
  } catch(e) {
    $.error(`HTTP META 启动异常: ${e.message}`)
    return proxies 
  }

  await $.wait(http_meta_start_delay)

  const concurrency = parseInt($arguments.concurrency || 10)
  
  await executeAsyncTasks(
    internalProxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

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
            if (status === 200) {
                // 1. 登录跳转检测 (最强特征，直接过)
                if (body.includes('identifierId') || body.includes('type="email"')) {
                    isSuccess = true;
                } 
                // 2. 应用数据检测 (针对访客模式/SPA应用)
                // WIZ_global_data: Google Wiz App 核心数据对象
                // SNlM0e: Gemini 特有的后端数据 ID
                else if (body.includes('WIZ_global_data') || body.includes('SNlM0e')) {
                    // 3. 排除营销页 (双重保险)
                    // 营销页通常包含 "glue-header" 或其他静态页特征
                    if (!body.includes('glue-header')) {
                        isSuccess = true;
                    }
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
    const TIMEOUT = opt.timeout || 5000 
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
