async function operator(proxies = [], targetPlatform, env) {
  const $ = $substore
  const cacheStore = typeof scriptResourceCache !== 'undefined' ? scriptResourceCache : undefined
  const cacheEnabled = parseBool($arguments.cache, true) && !!cacheStore
  const disableFailedCache = parseBool($arguments.disable_failed_cache ?? $arguments.ignore_failed_error, false)
  const telegramChatId = $arguments.telegram_chat_id
  const telegramBotToken = $arguments.telegram_bot_token
  const httpMetaHost = $arguments.http_meta_host ?? '127.0.0.1'
  const httpMetaPort = $arguments.http_meta_port ?? 9876
  const httpMetaProtocol = $arguments.http_meta_protocol ?? 'http'
  const httpMetaAuthorization = $arguments.http_meta_authorization ?? ''
  const httpMetaApi = `${httpMetaProtocol}://${httpMetaHost}:${httpMetaPort}`

  const timeout = parseFloat($arguments.timeout ?? 2500)
  const retries = parseFloat($arguments.retries ?? 0)
  const retryDelay = parseFloat($arguments.retry_delay ?? 250)
  const concurrency = parseInt($arguments.concurrency ?? 20)
  const httpMetaStartDelay = parseFloat($arguments.http_meta_start_delay ?? 1000)
  const httpMetaProxyTimeout = parseFloat(
    $arguments.http_meta_proxy_timeout ?? Math.max(4000, timeout * (retries + 1) + retryDelay * retries + 1500)
  )

  const method = String($arguments.method || 'head').toLowerCase()
  const keepIncompatible = parseBool($arguments.keep_incompatible, false)
  const validStatus = new RegExp($arguments.status || '204')
  const url = decodeURIComponent($arguments.url || 'http://connectivitycheck.platform.hicloud.com/generate_204')
  const ua = decodeURIComponent(
    $arguments.ua ||
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1'
  )

  const validProxies = []
  const incompatibleProxies = []
  const internalProxies = []
  const failedProxies = []

  let name = ''
  for (const [key, value] of Object.entries(env.source || {})) {
    if (!key.startsWith('_')) {
      name = value.displayName || value.name
      break
    }
  }
  if (!name) {
    const collection = env.source?._collection || {}
    name = collection.displayName || collection.name || 'Unknown'
  }

  proxies.forEach((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        for (const key in proxy) {
          if (/^_/i.test(key)) {
            node[key] = proxy[key]
          }
        }
        internalProxies.push({ ...node, _proxies_index: index })
      } else if (keepIncompatible) {
        incompatibleProxies.push(proxy)
      }
    } catch (e) {
      $.info(`节点转换失败: ${proxy?.name || 'Unknown'} | ${e.message || e}`)
    }
  })

  $.info(`核心支持节点数: ${internalProxies.length}/${proxies.length}`)
  if (!internalProxies.length) return keepIncompatible ? [...validProxies, ...incompatibleProxies] : validProxies

  const httpMetaTimeout = httpMetaStartDelay + internalProxies.length * httpMetaProxyTimeout

  let httpMetaPid
  let httpMetaPorts = []
  const startRes = await http({
    retries: 0,
    method: 'post',
    url: `${httpMetaApi}/start`,
    headers: {
      'Content-type': 'application/json',
      Authorization: httpMetaAuthorization,
    },
    body: JSON.stringify({
      proxies: internalProxies,
      timeout: httpMetaTimeout,
    }),
  })

  const startBody = safeJsonParse(startRes.body)
  const ports = startBody?.ports
  const pid = startBody?.pid
  if (!pid || !ports) {
    throw new Error(`======== HTTP META 启动失败 ====\n${typeof startBody === 'string' ? startBody : JSON.stringify(startBody)}`)
  }
  httpMetaPid = pid
  httpMetaPorts = ports

  $.info(
    `\n======== HTTP META 启动 ====\n[端口] ${ports}\n[PID] ${pid}\n[超时] 若未手动关闭 ${
      Math.round(httpMetaTimeout / 60 / 10) / 100
    } 分钟后自动关闭\n[缓存] ${cacheEnabled ? 'on' : 'off'}\n`
  )
  $.info(`等待 ${httpMetaStartDelay / 1000} 秒后开始检测`)
  await $.wait(httpMetaStartDelay)

  await executeAsyncTasks(internalProxies.map(proxy => () => check(proxy)), { concurrency })

  try {
    const stopRes = await http({
      method: 'post',
      url: `${httpMetaApi}/stop`,
      headers: {
        'Content-type': 'application/json',
        Authorization: httpMetaAuthorization,
      },
      body: JSON.stringify({
        pid: [httpMetaPid],
      }),
    })
    $.info(`\n======== HTTP META 关闭 ====\n${JSON.stringify(stopRes, null, 2)}`)
  } catch (e) {
    $.info(`HTTP META 关闭失败: ${e.message || e}`)
  }

  if (telegramChatId && telegramBotToken && failedProxies.length > 0) {
    const text = `\`${name}\` 节点测试:\n${failedProxies.map(proxy => `❌ [${proxy.type}] \`${proxy.name}\``).join('\n')}`
    await http({
      method: 'post',
      url: `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chat_id: telegramChatId, text, parse_mode: 'MarkdownV2' }),
      retries: 0,
      timeout: 5000,
    })
  }

  return keepIncompatible ? [...validProxies, ...incompatibleProxies] : validProxies

  async function check(proxy) {
    const id = cacheEnabled
      ? `http-meta:availability:${url}:${method}:${timeout}:${retries}:${retryDelay}:${ua}:${validStatus}:${JSON.stringify(
          Object.fromEntries(
            Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
          )
        )}`
      : undefined

    try {
      const cached = getCached(id)
      if (cached) {
        if (cached.latency) {
          validProxies.push({
            ...ProxyUtils.parse(JSON.stringify(proxy))[0],
            name: `${$arguments.show_latency ? `[${cached.latency}] ` : ''}${proxy.name}`,
            _latency: cached.latency,
          })
        }
        return
      }

      const index = internalProxies.indexOf(proxy)
      let lastError = null
      let lastStatus = 0

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const startedAt = Date.now()
          const res = await http({
            proxy: `http://${httpMetaHost}:${httpMetaPorts[index]}`,
            method,
            headers: {
              'User-Agent': ua,
            },
            url,
            retries: 0,
          })
          const status = parseInt(res.status || res.statusCode || 200)
          const latency = `${Date.now() - startedAt}`
          lastStatus = status

          if (validStatus.test(status)) {
            validProxies.push({
              ...ProxyUtils.parse(JSON.stringify(proxy))[0],
              name: `${$arguments.show_latency ? `[${latency}] ` : ''}${proxy.name}`,
              _latency: latency,
            })
            setCached(id, { latency })
            return
          }

          if (attempt < retries) {
            await $.wait(retryDelay)
            continue
          }
        } catch (e) {
          lastError = e
          if (attempt < retries) {
            await $.wait(retryDelay)
            continue
          }
        }
      }

      if (lastError) {
        $.error(`[${proxy.name}] ${lastError.message ?? lastError}`)
      } else if (lastStatus) {
        $.error(`[${proxy.name}] Status ${lastStatus}`)
      }

      setCached(id, {})
      failedProxies.push(proxy)
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`)
      setCached(id, {})
      failedProxies.push(proxy)
    }
  }

  function getCached(id) {
    if (!cacheEnabled || !id) return null
    try {
      const cached = cacheStore.get(id)
      if (!cached) return null
      if (cached.latency) return cached
      if (disableFailedCache) return null
      return cached
    } catch (e) {
      $.info(`缓存读取失败: ${e.message || e}`)
      return null
    }
  }

  function setCached(id, value) {
    if (!cacheEnabled || !id) return
    try {
      if (!value.latency && disableFailedCache) return
      cacheStore.set(id, value)
    } catch (e) {
      $.info(`缓存写入失败: ${e.message || e}`)
    }
  }

  async function http(opt = {}) {
    const requestMethod = String(opt.method || method || 'get').toLowerCase()
    const requestTimeout = parseFloat(opt.timeout || timeout)
    const requestRetries = parseFloat(opt.retries ?? retries)
    const requestRetryDelay = parseFloat(opt.retry_delay ?? retryDelay)
    let count = 0

    const fn = async () => {
      try {
        return await $.http[requestMethod]({ ...opt, timeout: requestTimeout })
      } catch (e) {
        if (count < requestRetries) {
          count++
          const delay = requestRetryDelay * count
          await $.wait(delay)
          return await fn()
        }
        throw e
      }
    }

    return await fn()
  }

  function executeAsyncTasks(tasks, { wrap, result, concurrency = 1 } = {}) {
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
                if (result) {
                  results[taskIndex] = wrap ? { data } : data
                }
              })
              .catch(error => {
                if (result) {
                  results[taskIndex] = wrap ? { error } : error
                }
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

  function parseBool(value, defaultValue = false) {
    if (value === undefined || value === null) return defaultValue
    const normalized = String(value).trim().toLowerCase()
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
    return defaultValue
  }

  function safeJsonParse(value) {
    try {
      return JSON.parse(value)
    } catch (e) {
      return value
    }
  }
}
