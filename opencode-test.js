// ==Script==
// @name: OpenCode 测活
// @description: 测试节点能否访问 OpenCode（zen/v1/models 返回模型清单），通过的节点名前加 [OC]
// @author: laoma
// @version: 1.0.0
// @trigger: manual
// ==/Script==
//
// 用法（Sub-Store → 订阅 → 脚本操作 → 添加脚本，脚本参数可留空）：
//   prefix=[OC]  timeout=5000  retries=1  concurrency=20  cache=true  clean=true  require_models=true
//
// 判据（与 nodepool/reg_pool.py 的 L1 一致）：经节点 GET https://opencode.ai/zen/v1/models
//   状态 200 且响应体含 "data" => 该节点通 OpenCode，加前缀。
//   * 与 nvidia/gemini 参考脚本故意不同：不把 401/403 当可用 —— 那种响应通常是 CF 挑战或风控拦截，
//     拿到它的节点注册时同样会被挡，标成 [OC] 会误导选路。
//   * 依赖 Sub-Store 后端的 http-meta 服务（127.0.0.1:9876），与参考脚本同一套。

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const args = $arguments || {};
  const cacheStore = typeof scriptResourceCache !== 'undefined' ? scriptResourceCache : undefined;

  const PREFIX = args.prefix ?? '[OC] ';
  const TIMEOUT = parseInt(args.timeout ?? 5000, 10);
  const RETRIES = parseInt(args.retries ?? 1, 10);
  const RETRY_DELAY = parseInt(args.retry_delay ?? 400, 10);
  const CONCURRENCY = parseInt(args.concurrency ?? 20, 10);
  const CACHE_ENABLED = parseBool(args.cache, true) && !!cacheStore;
  const DISABLE_FAILED_CACHE = parseBool(args.disable_failed_cache ?? args.ignore_failed_error, false);
  const CLEAN = parseBool(args.clean, true);
  const REQUIRE_MODELS = parseBool(args.require_models, true);

  const TARGET_URL = args.target_url ?? 'https://opencode.ai/zen/v1/models';

  const META_HOST = args.http_meta_host ?? '127.0.0.1';
  const META_PORT = parseInt(args.http_meta_port ?? 9876, 10);
  const META_PROTOCOL = args.http_meta_protocol ?? 'http';
  const META_START_DELAY = parseInt(args.http_meta_start_delay ?? 1000, 10);
  const PER_PROXY_TIMEOUT = parseInt(
    args.http_meta_proxy_timeout ?? Math.max(6000, TIMEOUT * (RETRIES + 1) + RETRY_DELAY * RETRIES + 1500),
    10
  );
  const LOG_EVERY = Math.max(20, CONCURRENCY);

  const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
  };

  if (!Array.isArray(proxies) || proxies.length === 0) return proxies;

  // 幂等：已有前缀先剥掉，避免重复跑堆成 [OC] [OC] xxx
  if (CLEAN) {
    for (const p of proxies) {
      if (!p || typeof p.name !== 'string') continue;
      if (p.name.startsWith(PREFIX)) p.name = p.name.slice(PREFIX.length);
    }
  }

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

  if (internalProxies.length === 0) {
    $.info('⚠️ 没有可检测的节点');
    return proxies;
  }

  const metaApiBase = `${META_PROTOCOL}://${META_HOST}:${META_PORT}`;
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
    $.info(`🚀 OpenCode 检测启动 | 节点:${internalProxies.length} | 缓存:${CACHE_ENABLED ? 'on' : 'off'}`);
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
      if (!originalNode) return;
      if (!port) {
        $.info(`⚠️ 节点 ${proxy.name} 没有分配到端口`);
        return;
      }

      const result = await resolveSupport(proxy, port);

      finishedCount++;
      if (result.ok) {
        validCount++;
        if (!originalNode.name.startsWith(PREFIX)) originalNode.name = `${PREFIX}${originalNode.name}`;
      }

      if (finishedCount % LOG_EVERY === 0 || finishedCount === internalProxies.length) {
        $.info(`进度: ${finishedCount}/${internalProxies.length} (可访问: ${validCount})`);
      }
    }),
    { concurrency: CONCURRENCY }
  );

  try {
    await http({
      method: 'post',
      url: `${metaApiBase}/stop`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: metaPid }),
    });
  } catch (e) {
    $.info(`⚠️ http-meta 停止失败（可忽略）: ${e.message || e}`);
  }

  $.info(
    `✅ OpenCode 检测完成 | 总计: ${internalProxies.length} | 可访问: ${validCount} | 不可访问: ${
      internalProxies.length - validCount
    }`
  );
  return proxies;

  // ===================== Helpers =====================

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
          headers: REQUEST_HEADERS,
          timeout: TIMEOUT,
          proxy: `http://${META_HOST}:${port}`,
        });
        const status = parseInt(res.status || res.statusCode || 0, 10);
        const text = String(res.body ?? '');
        if (status === 200 && (!REQUIRE_MODELS || text.includes('"data"'))) return { ok: true };
        if (i < RETRIES) {
          await $.wait(RETRY_DELAY);
          continue;
        }
        return { ok: false };
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
    return `opencode:availability:${TARGET_URL}:${TIMEOUT}:${RETRIES}:${RETRY_DELAY}:${REQUIRE_MODELS}:${JSON.stringify(
      stableProxy
    )}`;
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
    if (typeof $.http[method] !== 'function') throw new Error(`$.http.${method} 不存在`);
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
            .catch((e) => $.info(`任务执行失败: ${e.message || e}`))
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
