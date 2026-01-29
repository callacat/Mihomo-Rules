/**
 * ChatGPT 批量检测脚本 (增强指纹/调试版)
 * * * 使用方法 (Argument 参数):
 * timeout=5000&concurrency=10&prefix=[GPT] 
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const args = $arguments || {};

  const PREFIX = args.prefix ?? '[GPT] ';
  const TIMEOUT = parseInt(args.timeout ?? 5000);
  const RETRIES = parseInt(args.retries ?? 1);
  const CONCURRENCY = parseInt(args.concurrency ?? 10);
  
  const META_HOST = args.http_meta_host ?? '127.0.0.1';
  const META_PORT = parseInt(args.http_meta_port ?? 9876);
  const META_PROTOCOL = args.http_meta_protocol ?? 'http';
  const META_START_DELAY = parseInt(args.http_meta_start_delay ?? 3000);
  const PER_PROXY_TIMEOUT = parseInt(args.http_meta_proxy_timeout ?? 10000);

  // 更换为更通用的网页检测地址
  const TARGET_URL = `https://chatgpt.com`;

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
    } catch (e) {}
  });

  if (internalProxies.length === 0) return proxies;

  const metaApiBase = `${META_PROTOCOL}://${META_HOST}:${META_PORT}`;
  const metaTimeoutCalc = META_START_DELAY + (internalProxies.length * PER_PROXY_TIMEOUT);

  let metaPid;
  let metaPorts = [];

  try {
    const startRes = await http({
        method: 'post',
        url: `${metaApiBase}/start`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxies: internalProxies, timeout: metaTimeoutCalc })
    });
    const body = JSON.parse(startRes.body);
    metaPid = body.pid;
    metaPorts = body.ports;
    $.info(`🚀 检测启动 | 节点:${internalProxies.length}`);
    await $.wait(META_START_DELAY); 
  } catch (e) {
    $.error(`❌ Meta 启动失败: ${e.message}`);
    return proxies;
  }

  let finishedCount = 0;
  let validCount = 0;

  await executeAsyncTasks(
    internalProxies.map((proxy, idx) => async () => {
        const port = metaPorts[idx];
        const isSupported = await checkWithRetry(proxy, port);
        
        finishedCount++;
        if (isSupported) {
            validCount++;
            const originalNode = proxies[proxy._proxies_index];
            if (!originalNode.name.includes(PREFIX)) {
                originalNode.name = `${PREFIX}${originalNode.name}`;
            }
        }
        if (finishedCount % 5 === 0) $.info(`进度: ${finishedCount}/${internalProxies.length} (有效: ${validCount})`);
    }),
    { concurrency: CONCURRENCY }
  );

  try {
    await http({
        method: 'post',
        url: `${metaApiBase}/stop`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: [metaPid] })
    });
  } catch (e) {}

  return proxies;

  // ================= 核心逻辑 =================

  async function checkWithRetry(proxy, port) {
    for (let i = 0; i <= RETRIES; i++) {
        try {
            const res = await http({
                method: 'get',
                url: TARGET_URL,
                timeout: TIMEOUT,
                headers: {
                    // 模拟现代浏览器 Header
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Sec-Fetch-Mode': 'navigate',
                    'Referer': 'https://www.google.com/'
                },
                proxy: `http://${META_HOST}:${port}`
            });
            
            const status = parseInt(res.status || res.statusCode || 0);

            // ChatGPT 正常访问通常返回 200
            if (status === 200) return true;
            
            // 如果返回 403，通常是 Cloudflare 拦截，也可能是地区不支持。
            // 在脚本环境中，很多时候 403 是因为脚本指纹被封。
            // 如果你确认节点可用，可以尝试将 403 也视为通过（仅限检测网页时），但这样准确率会下降。
            $.info(`[${proxy.name}] 返回状态码: ${status}`);
            
            return false;
        } catch (e) {
            if (i === RETRIES) {
                // $.info(`[${proxy.name}] 错误: ${e.message}`);
            }
            await $.wait(500);
        }
    }
    return false;
  }

  async function http(opt = {}) {
    const method = (opt.method || 'get').toLowerCase();
    return await $.http[method](opt);
  }

  function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise((resolve) => {
      let index = 0;
      let running = 0;
      function next() {
        while (index < tasks.length && running < concurrency) {
          tasks[index++]().finally(() => {
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
