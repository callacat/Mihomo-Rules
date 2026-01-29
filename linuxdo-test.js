/**
 * Linux.do 论坛访问检测脚本
 * * 使用方法 (Argument 参数):
 * timeout=5000&concurrency=10&prefix=[LD] 
 * * 参数说明:
 * - prefix: 命命名前缀，默认 "[LD] "
 * - timeout: 请求超时 (ms)，默认 5000
 * - concurrency: 并发数，默认 10
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

  // 检测目标：Linux.do 首页
  const TARGET_URL = `https://linux.do/`;

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
    $.info(`🚀 Linux.do 检测启动 | 节点:${internalProxies.length}`);
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
        const isSupported = await checkWithRetry(proxy, port);
        
        finishedCount++;
        if (isSupported) {
            validCount++;
            const originalNode = proxies[proxy._proxies_index];
            if (!originalNode.name.includes(PREFIX)) {
                originalNode.name = `${PREFIX}${originalNode.name}`;
            }
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
    $.info(`🏁 检测结束，Linux.do 有效节点: ${validCount}`);
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
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                },
                proxy: `http://${META_HOST}:${port}`
            });
            
            const status = parseInt(res.status || res.statusCode || 0);
            // 200 为正常，部分重定向 301/302 也可视为通
            if (status === 200 || status === 301 || status === 302) return true;
            
            return false;
        } catch (e) {
            if (i < RETRIES) await $.wait(500);
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
