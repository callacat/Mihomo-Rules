/**
 *
 * GPT & Gemini 双重检测 (源码特征分析版)
 *
 * 更新日志:
 * v4.0: 针对 Gemini 动态网页特性，改为检测 "WIZ_global_data" (Google Web App 特征) 
 * 并排除 "glue-header" (营销页特征)，解决跳官网误判和访客模式漏判问题。
 *
 * HTTP META 参数
 * - [http_meta_start_delay] 初始启动延时. 默认: 500
 * - [timeout] 单个请求超时. 默认 5000
 *
 * 其它参数
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
  
  const http_meta_start_delay = parseFloat($arguments.http_meta_start_delay ?? 500) 
  const http_meta_proxy_timeout = parseFloat($arguments.http_meta_proxy_timeout ?? 8000)
  
  const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
  const geminiPrefix = $arguments.gemini_prefix ?? '[GM] '
  const method = $arguments.method || 'get'
  
  const requestTimeout = parseFloat($arguments.timeout || 5000) 

  const urlGPT = $arguments.client === 'Android' ? `https://android.chat.openai.com` : `https://ios.chat.openai.com`
  // 必须检测 /app 路径
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
            
            // 调试日志：提取页面标题 (只在 200 时提取)
            let pageTitle = "Unknown";
            const titleMatch = body.match(/<title>(.*?)<\/title>/);
            if (titleMatch) pageTitle = titleMatch[1];

            // 1. 登录页 (最强特征)
            // 跳转到了 accounts.google.com，body 里一定有 identifierId (账号输入框ID)
            const isLoginPage = body.includes('identifierId') || body.includes('type="email"');

            // 2. Google Web App (App / 访客模式特征)
            // 只要是 Google 的 Web App (Docs, Gemini, Drive)，源码里通常会有 "WIZ_global_data"
            // 或者 "CF_initDataCallback" 等初始化数据。
            // 营销页通常是纯静态 HTML，没有这些。
            const isWebApp = body.includes('WIZ_global_data') || body.includes('AF_initDataCallback');
            
            // 3. 营销页/官网 (负面特征)
            // 官网通常包含 "glue-header" (Google Marketing Header)
            // 或者标题是 "Google Gemini" (App 标题通常只有 "Gemini")
            const isMarketingPage = body.includes('glue-header') || pageTitle.includes('Google Gemini');

            if (status === 200) {
                if (isLoginPage) {
                    isSuccess = true;
                    // $.info(`[${proxy.name}] Gemini: 登录页通过`);
                } else if (isWebApp && !isMarketingPage) {
                    isSuccess = true;
                    // $.info(`[${proxy.name}] Gemini: APP/访客模式通过 (Title: ${pageTitle})`);
                } else {
                    // $.info(`[${proxy.name}] Gemini: 失败 (Title: ${pageTitle}, IsMarketing: ${isMarketingPage})`);
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
