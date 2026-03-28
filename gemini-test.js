async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const args = $arguments || {};
  const cacheStore = typeof scriptResourceCache !== 'undefined' ? scriptResourceCache : undefined;

  const API_KEY = args.api_key;
  const PREFIX = args.prefix ?? '[GM] ';
  const TIMEOUT = parseInt(args.timeout ?? 2500, 10);
  const RETRIES = parseInt(args.retries ?? 0, 10);
  const RETRY_DELAY = parseInt(args.retry_delay ?? 250, 10);
  const CONCURRENCY = parseInt(args.concurrency ?? 20, 10);
  const CACHE_ENABLED = parseBool(args.cache, true) && !!cacheStore;
  const DISABLE_FAILED_CACHE = parseBool(args.disable_failed_cache ?? args.ignore_failed_error, false);

  const META_HOST = args.http_meta_host ?? '127.0.0.1';
  const META_PORT = parseInt(args.http_meta_port ?? 9876, 10);
  const META_PROTOCOL = args.http_meta_protocol ?? 'http';
  const META_START_DELAY = parseInt(args.http_meta_start_delay ?? 1000, 10);
  const PER_PROXY_TIMEOUT = parseInt(
    args.http_meta_proxy_timeout ?? Math.max(4000, TIMEOUT * (RETRIES + 1) + RETRY_DELAY * RETRIES + 1500),
    10
  );
  const LOG_EVERY = Math.max(20, CONCURRENCY);

  if (!API_KEY) {
    $.error('❌ 缺少 api_key。请在 Arguments 中填写 api_key=xxx');
    return proxies;
  }

  const TARGET_URL = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;
  const metaApiBase = `${META_PROTOCOL}://${META_HOST}:${META_PORT}`;
  const internalProxies = [];

  proxies.forEach((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0];
      if (node) {
        for (const key in proxy) {
          if (/^_/i.test(key)) node[key] = proxy[key];
        }
        internalProxies.push({ ...node, _proxies_index: index });
      }
    } catch (e) {
      $.info(`节点转换失败: ${proxy?.name || 'Unknown'} | ${e.message || e}`);
    }
  });

  if (internalProxies.length === 0) return proxies;

  const metaTimeoutCalc = META_START_DELAY + internalProxies.length * PER_PROXY_TIMEOUT;
  let metaPid;
  let metaPorts = [];

  try {
    const startRes = await http({
      method: 'post',
      url: `${metaApiBase}/start`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxies: internalProxies, timeout: metaTimeoutCalc }),
    });
    const body = JSON.parse(startRes.body);
    if (!body.pid || !Array.isArray(body.ports)) throw new Error('Meta 未返回 PID 或 ports');

    metaPid = body.pid;
    metaPorts = body.ports;
    $.info(`🚀 Gemini 检测启动 | 节点:${internalProxies.length} | 保活:${Math.round(metaTimeoutCalc / 1000)}s | 缓存:${CACHE_ENABLED ? 'on' : 'off'}`);
    await $.wait(META_START_DELAY);
  } catch (e) {
    $.error(`❌ Meta 启动失败: ${e.message || e}`);
    $.error(`请确保已安装 http-meta 且端口 ${META_PORT} 未被占用`);
    return proxies;
  }

  let finishedCount = 0;
  let validCount = 0;

  await executeAsyncTasks(
    internalProxies.map((proxy, idx) => async () => {
      const originalNode = proxies[proxy._proxies_index];
      const port = metaPorts[idx];
      const result = await resolveSupport(proxy, port);

      finishedCount++;
      if (result.ok && originalNode) {
        validCount++;
        if (!originalNode.name.startsWith(PREFIX)) {
          originalNode.name = `${PREFIX}${originalNode.name}`;
        }
      }

      if (finishedCount % LOG_EVERY === 0 || finishedCount === internalProxies.length) {
        $.info(`进度: ${finishedCount}/${internalProxies.length} (可用: ${validCount})`);
      }
    }),
    { concurrency: CONCURRENCY }
  );

  try {
    await http({
      method: 'post',
      url: `${metaApiBase}/stop`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: [metaPid] }),
    });
    $.info('🏁 Gemini 检测结束，Meta 已关闭');
  } catch (e) {
    $.info(`Meta 关闭失败: ${e.message || e}`);
  }

  return proxies;

  async function resolveSupport(proxy, port) {
    const cacheId = getCacheId(proxy);
    const cached = getCachedResult(cacheId);
    if (cached) return cached;

    const result = await checkWithRetry(port);
    setCachedResult(cacheId, result);
    return result;
  }

  async function checkWithRetry(port) {
    for (let i = 0; i <= RETRIES; i++) {
      try {
        const res = await http({
          method: 'get',
          url: TARGET_URL,
          timeout: TIMEOUT,
          proxy: `http://${META_HOST}:${port}`,
        });

        const status = parseInt(res.status || res.statusCode || 0, 10);
        if (status === 200) return { ok: true };
        if (status === 400 || status === 403) return { ok: false };
        throw new Error(`Status ${status}`);
      } catch (e) {
        if (i < RETRIES) await $.wait(RETRY_DELAY);
      }
    }
    return { ok: false };
  }

  function getCacheId(proxy) {
    if (!CACHE_ENABLED) return '';
    const stableProxy = Object.fromEntries(
      Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
    );
    return `gemini:availability:${TARGET_URL}:${TIMEOUT}:${RETRIES}:${RETRY_DELAY}:${JSON.stringify(stableProxy)}`;
  }

  function getCachedResult(cacheId) {
    if (!CACHE_ENABLED || !cacheId) return null;
    try {
      const cached = cacheStore.get(cacheId);
      if (!cached || typeof cached.ok !== 'boolean') return null;
      if (!cached.ok && DISABLE_FAILED_CACHE) return null;
      return cached;
    } catch (e) {
      $.info(`缓存读取失败: ${e.message || e}`);
      return null;
    }
  }

  function setCachedResult(cacheId, result) {
    if (!CACHE_ENABLED || !cacheId) return;
    try {
      cacheStore.set(cacheId, { ok: !!result.ok });
    } catch (e) {
      $.info(`缓存写入失败: ${e.message || e}`);
    }
  }

  async function http(opt = {}) {
    const method = (opt.method || 'get').toLowerCase();
    if (typeof $.http[method] !== 'function') {
      throw new Error(`$.http.${method} 不存在`);
    }
    return await $.http[method](opt);
  }

  function parseBool(value, defaultValue = false) {
    if (value === undefined || value === null) return defaultValue;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    return defaultValue;
  }

  function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise((resolve) => {
      let index = 0;
      let running = 0;

      function next() {
        while (index < tasks.length && running < concurrency) {
          tasks[index++]()
            .catch((e) => {
              $.info(`任务执行失败: ${e.message || e}`);
            })
            .finally(() => {
              running--;
              if (index >= tasks.length && running === 0) resolve();
              else next();
            });
          running++;
        }
      }

      next();
    });
  }
}
