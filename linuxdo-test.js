/**
 * Linux.do 论坛访问检测脚本 (抗 Cloudflare 干扰版)
 * * 使用方法:
 * timeout=5000&concurrency=10&prefix=[LD] 
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const args = $arguments || {};

  // --- 1. 参数解析 ---
  const PREFIX = args.prefix ?? '[LD] ';
  const TIMEOUT = parseInt(args.timeout ?? 5000);
  const RETRIES = parseInt(args.retries ?? 1);
  const CONCURRENCY = parseInt(args.concurrency ?? 10);
  
  const META_HOST = args.http_meta_host ?? '127.0.0.1';
  const META_PORT = parseInt(args.http_meta_port ?? 9876);
  const META_PROTOCOL = args.http_meta_protocol ?? 'http';
  const META_START_DELAY = parseInt(args.http_meta_start_delay ?? 3000);
  const PER_PROXY_TIMEOUT = parseInt(args.http_meta_proxy_timeout ?? 10000);

  // 检测目标：Linux.do
  // 策略：只要能连接到 Linux.do 的服务器（哪怕被 CF 拦截），就视为节点可用。
  // 因为脚本无法通过 CF 的人机验证，但浏览器可以。
  const TARGET_URL = `https://linux.do/challenge`;

  // --- 2. 节点预处理 ---
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

  // --- 3. 启动 HTTP Meta ---
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
    $.info(`🚀 Linux.do 检测启动 | 节点:${internalProxies.length} | 宽松模式`);
    await $.wait(META_START_DELAY); 
  } catch (e) {
    $.error(`❌ Meta 启动失败: ${e.message}`);
    return proxies;
  }

  // --- 4. 并发执行检测 ---
  let finishedCount = 0;
  let validCount = 0;

  await executeAsyncTasks(
    internalProxies.map((proxy, idx) => async () => {
        const port = metaPorts[idx];
        const result = await checkWithRetry(proxy, port);
        
        finishedCount++;
        if (result.ok) {
            validCount++;
            const originalNode = proxies[proxy._proxies_index];
            if (!originalNode.name.includes(PREFIX)) {
                originalNode.name = `${PREFIX}${originalNode.name}`;
            }
        }
        // 调试日志：显示失败节点的状态码，方便排查
        if (!result.ok && result.status !== 0) {
             // $.info(`[${proxy.name}] 状态码: ${result.status}`); 
        }

        if (finishedCount % 10 === 0 || finishedCount === internalProxies.length) {
            $.info(`进度: ${finishedCount}/${internalProxies.length} (有效: ${validCount})`);
        }
    }),
    { concurrency: CONCURRENCY }
  );

  // --- 5. 关闭服务 ---
  try {
    await http({
        method: 'post',
        url: `${metaApiBase}/stop`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: [metaPid] })
    });
    $.info(`🏁 检测结束，有效节点: ${validCount}`);
  } catch (e) {}

  return proxies;

  // ================= 核心逻辑 =================

  async function checkWithRetry(proxy, port) {
    let lastStatus = 0;
    for (let i = 0; i <= RETRIES; i++) {
        try {
            const res = await http({
                method: 'get',
                url: TARGET_URL,
                timeout: TIMEOUT,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                },
                proxy: `http://${META_HOST}:${port}`
            });
            
            const status = parseInt(res.status || res.statusCode || 0);
            lastStatus = status;
            
            // 宽松判定策略：
            // 200: 完美
            // 301/302: 重定向 (通常是跳转到登录或Challenge) -> 说明网络通
            // 403: Cloudflare 拦截 (Forbidden) -> 说明连上了 CF，网络通
            // 503: Cloudflare 正在检查 (Service Unavailable) -> 说明连上了 CF，网络通
            // 429: 请求过多 -> 网络通
            if (status === 200 || status === 301 || status === 302 || status === 403 || status === 503 || status === 429) {
                return { ok: true, status: status };
            }
            
            // 如果是 0 或者 502/504 (网关错误)，可能确实是节点问题，重试
            
        } catch (e) {
            // 网络错误 (status 0)
            if (i < RETRIES) await $.wait(500);
        }
    }
    return { ok: false, status: lastStatus };
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
