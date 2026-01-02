/**
 *
 * GPT & Gemini 双重检测 (精准版)
 *
 * 原作: https://t.me/zhetengsha/1207
 * 修改: 修复 Gemini 检测假阳性问题 (检测是否跳Login页)
 *
 * HTTP META(https://github.com/xream/http-meta) 参数
 * - [http_meta_protocol] 协议 默认: http
 * - [http_meta_host] 服务地址 默认: 127.0.0.1
 * - [http_meta_port] 端口号 默认: 9876
 * - [http_meta_authorization] Authorization 默认无
 * - [http_meta_start_delay] 初始启动延时(单位: 毫秒) 默认: 3000
 * - [http_meta_proxy_timeout] 每个节点耗时(单位: 毫秒). 默认: 10000
 *
 * 其它参数
 * - [timeout] 请求超时(单位: 毫秒) 默认 5000
 * - [retries] 重试次数 默认 1
 * - [concurrency] 并发数 默认 10
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
  const http_meta_start_delay = parseFloat($arguments.http_meta_start_delay ?? 3000)
  const http_meta_proxy_timeout = parseFloat($arguments.http_meta_proxy_timeout ?? 10000)

  // 前缀设置
  const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
  const geminiPrefix = $arguments.gemini_prefix ?? '[GM] '

  const method = $arguments.method || 'get'

  // 检测 URL
  const urlGPT = $arguments.client === 'Android' ? `https://android.chat.openai.com` : `https://ios.chat.openai.com`
  // 修改：检测 /app 路径，只有支持的地区才会跳登录页
  const urlGemini = `https://gemini.google.com/app`

  const $ = $substore
  const internalProxies = []

  // 预处理节点
  proxies.map((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{
        ...proxy
      }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        for (const key in proxy) {
          if (/^_/i.test(key)) {
            node[key] = proxy[key]
          }
        }
        internalProxies.push({
          ...node,
          _proxies_index: index
        })
      }
    } catch (e) {
      $.error(e)
    }
  })

  $.info(`核心支持节点数: ${internalProxies.length}/${proxies.length}`)
  if (!internalProxies.length) return proxies

  const http_meta_timeout = http_meta_start_delay + internalProxies.length * http_meta_proxy_timeout

  let http_meta_pid
  let http_meta_ports = []

  // 启动 HTTP META
  const res = await http({
    retries: 0,
    method: 'post',
    url: `${http_meta_api}/start`,
    headers: {
      'Content-type': 'application/json',
      Authorization: http_meta_authorization,
    },
    body: JSON.stringify({
      proxies: internalProxies,
      timeout: http_meta_timeout,
    }),
  })

  let body = res.body
  try {
    body = JSON.parse(body)
  } catch (e) {}
  const {
    ports,
    pid
  } = body
  if (!pid || !ports) {
    throw new Error(`======== HTTP META 启动失败 ====\n${body}`)
  }
  http_meta_pid = pid
  http_meta_ports = ports
  $.info(
    `\n======== HTTP META 启动 ====\n[端口] ${ports}\n[PID] ${pid}\n[超时] ${
      Math.round(http_meta_timeout / 60 / 10) / 100
    } 分钟后自动关闭\n`
  )
  $.info(`等待 ${http_meta_start_delay / 1000} 秒后开始检测`)
  await $.wait(http_meta_start_delay)

  const concurrency = parseInt($arguments.concurrency || 10)

  // 执行检测任务
  await executeAsyncTasks(
    internalProxies.map(proxy => () => check(proxy)), {
      concurrency
    }
  )

  // 关闭 HTTP META
  try {
    const res = await http({
      method: 'post',
      url: `${http_meta_api}/stop`,
      headers: {
        'Content-type': 'application/json',
        Authorization: http_meta_authorization,
      },
      body: JSON.stringify({
        pid: [http_meta_pid],
      }),
    })
    $.info(`\n======== HTTP META 关闭 ====\n${JSON.stringify(res, null, 2)}`)
  } catch (e) {
    $.error(e)
  }

  return proxies

  // 主检测函数
  async function check(proxy) {
    const index = internalProxies.indexOf(proxy)
    const proxyHost = `http://${http_meta_host}:${http_meta_ports[index]}`

    // 并行执行两个检测
    const [gptResult, geminiResult] = await Promise.all([
      checkTask(proxy, urlGPT, 'gpt', proxyHost),
      checkTask(proxy, urlGemini, 'gemini', proxyHost)
    ])

    // 组合重命名
    let prefixToAdd = ""
    if (gptResult) prefixToAdd += gptPrefix
    if (geminiResult) prefixToAdd += geminiPrefix

    if (prefixToAdd) {
      proxies[proxy._proxies_index].name = `${prefixToAdd}${proxies[proxy._proxies_index].name}`
    }
  }

  // 通用单项检测任务
  async function checkTask(proxy, url, type, proxyUrl) {
    const id = cacheEnabled ? getCacheId({
      proxy,
      url
    }) : undefined

    if (cacheEnabled) {
      const cached = cache.get(id)
      if (cached) {
        if (cached.ok) {
          if (type === 'gpt') {
            proxies[proxy._proxies_index]._gpt = true
            proxies[proxy._proxies_index]._gpt_latency = cached.latency
          } else if (type === 'gemini') {
            proxies[proxy._proxies_index]._gemini = true
            proxies[proxy._proxies_index]._gemini_latency = cached.latency
          }
          $.info(`[${proxy.name}] [${type}] 使用成功缓存`)
          return true
        } else if (disableFailedCache) {
          $.info(`[${proxy.name}] [${type}] 不使用失败缓存，重新检测`)
        } else {
          $.info(`[${proxy.name}] [${type}] 使用失败缓存`)
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
          // 使用通用 UA 确保触发标准行为
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
        },
        url,
      })
      const status = parseInt(res.status || res.statusCode || 200)
      let body = String(res.body ?? res.rawBody)

      // 尝试解析JSON（仅针对可能的JSON响应），大部分情况是HTML
      let jsonBody = null
      try {
        jsonBody = JSON.parse(body)
      } catch (e) {}

      const latency = Date.now() - startedAt
      let isSuccess = false
      const msg = jsonBody?.error?.code || jsonBody?.error?.error_type || jsonBody?.cf_details || "OK"

      // === 判定逻辑修正 ===
      if (type === 'gpt') {
        // GPT 逻辑保持不变
        if (status == 403 && !/unsupported_country/.test(msg)) {
          isSuccess = true
        }
      } else if (type === 'gemini') {
        // Gemini 逻辑修正：
        // 访问 /app
        // 成功：会重定向到 accounts.google.com 登录页，body 里包含 "identifierId" 或 "Sign in"
        // 失败：会重定向回首页，或者 body 包含 "Supercharge" 等营销文案，且没有登录框

        // 检查 body 关键字
        const isLoginPage = body.includes('identifierId') ||
          body.includes('accounts.google.com') ||
          body.includes('Sign in');

        if (status === 200 && isLoginPage) {
          isSuccess = true
        } else {
          // 虽然是 200，但不是登录页，说明被踢回了 Landing Page
          isSuccess = false
        }
      }

      $.info(`[${proxy.name}] [${type}] status: ${status}, latency: ${latency}, success: ${isSuccess}`)

      if (isSuccess) {
        if (type === 'gpt') {
          proxies[proxy._proxies_index]._gpt = true
          proxies[proxy._proxies_index]._gpt_latency = latency
        } else if (type === 'gemini') {
          proxies[proxy._proxies_index]._gemini = true
          proxies[proxy._proxies_index]._gemini_latency = latency
        }

        if (cacheEnabled) {
          cache.set(id, {
            ok: true,
            latency: latency
          })
        }
        return true
      } else {
        if (cacheEnabled) {
          cache.set(id, {
            ok: false
          })
        }
        return false
      }

    } catch (e) {
      $.error(`[${proxy.name}] [${type}] Error: ${e.message ?? e}`)
      if (cacheEnabled) {
        cache.set(id, {
          ok: false
        })
      }
      return false
    }
  }

  async function http(opt = {}) {
    const METHOD = opt.method || $arguments.method || 'get'
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000)
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1)
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000)

    let count = 0
    const fn = async () => {
      try {
        return await $.http[METHOD]({
          ...opt,
          timeout: TIMEOUT
        })
      } catch (e) {
        if (count < RETRIES) {
          count++
          const delay = RETRY_DELAY * count
          await $.wait(delay)
          return await fn()
        } else {
          throw e
        }
      }
    }
    return await fn()
  }

  function getCacheId({
    proxy = {},
    url
  }) {
    return `http-meta:check:${url}:${JSON.stringify(
      Object.fromEntries(Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key)))
    )}`
  }

  function executeAsyncTasks(tasks, {
    wrap,
    result,
    concurrency = 1
  } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        let running = 0
        const results = []
        let index = 0

        function executeNextTask() {
          while (index < tasks.length && running < concurrency) {
            const taskIndex = index++
            const currentTask = tasks[taskIndex]
            running++
            currentTask()
              .then(data => {
                if (result) results[taskIndex] = wrap ? {
                  data
                } : data
              })
              .catch(error => {
                if (result) results[taskIndex] = wrap ? {
                  error
                } : error
              })
              .finally(() => {
                running--
                executeNextTask()
              })
          }
          if (running === 0) {
            return resolve(result ? results : undefined)
          }
        }
        await executeNextTask()
      } catch (e) {
        reject(e)
      }
    })
  }
}
