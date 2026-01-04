/**
 * Gemini 批量检测脚本 (官方逻辑增强版)
 * * 使用方法 (Argument 参数):
 * api_key=AIzaSy...&timeout=3000&concurrency=20&retries=1
 * * 全部支持的参数:
 * - api_key: (必填) Google Gemini API Key
 * - prefix: 命名前缀，默认 "[GM] "
 * - timeout: 请求超时 (ms)，默认 5000
 * - retries: 重试次数，默认 1
 * - retry_delay: 重试间隔 (ms)，默认 1000
 * - concurrency: 并发数，默认 10
 * - http_meta_host: Meta 地址，默认 127.0.0.1
 * - http_meta_port: Meta 端口，默认 9876
 * - http_meta_start_delay: 启动等待 (ms)，默认 3000
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const args = $arguments || {};

  // --- 1. 参数解析 (兼容官方命名) ---
  const API_KEY = args.api_key;
  const PREFIX = args.prefix ?? '[GM] ';
  const TIMEOUT = parseInt(args.timeout ?? 5000);
  const RETRIES = parseInt(args.retries ?? 1);
  const RETRY_DELAY = parseInt(args.retry_delay ?? 1000);
  const CONCURRENCY = parseInt(args.concurrency ?? 10);
  
  const META_HOST = args.http_meta_host ?? '127.0.0.1';
  const META_PORT = parseInt(args.http_meta_port ?? 9876);
  const META_PROTOCOL = args.http_meta_protocol ?? 'http';
  const META_START_DELAY = parseInt(args.http_meta_start_delay ?? 3000);
  // 单个节点预计最大耗时 (用于计算核心保活时间)
  const PER_PROXY_TIMEOUT = parseInt(args.http_meta_proxy_timeout ?? 10000);

  if (!API_KEY) {
    $.error("❌ 缺少 api_key。请在 Arguments 中填写 api_key=xxx");
    return proxies;
  }

  const TARGET_URL = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;

  // --- 2. 节点预处理 ---
  const internalProxies = [];
  proxies.forEach((proxy, index) => {
    try {
      // 转换为 Meta 格式
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0];
      if (node) {
        // 保留内部字段
        for (const key in proxy) {
            if (/^_/i.test(key)) node[key] = proxy[key];
        }
        internalProxies.push({ ...node, _proxies_index: index });
      }
    } catch (e) {}
  });

  if (internalProxies.length === 0) return proxies;

  // --- 3. 启动 HTTP Meta (优化版保活逻辑) ---
  const metaApiBase = `${META_PROTOCOL}://${META_HOST}:${META_PORT}`;
  
  // 关键优化：动态计算核心需要存活多久
  // 总耗时 ≈ 启动延迟 + (节点总数 / 并发数 * (超时+重试耗时))
  // 为了安全，我们直接用官方的宽松算法：StartDelay + Count * PerProxyTimeout
  const metaTimeoutCalc = META_START_DELAY + (internalProxies.length * PER_PROXY_TIMEOUT);

  let metaPid;
  let metaPorts = [];

  try {
    const startRes = await http({
        method: 'post',
        url: `${metaApiBase}/start`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            proxies: internalProxies, 
            timeout: metaTimeoutCalc 
        })
    });
    
    const body = JSON.parse(startRes.body);
    if (!body.pid) throw new Error("Meta 未返回 PID");
    
    metaPid = body.pid;
    metaPorts = body.ports;
    
    $.info(`🚀 Meta 启动 (PID:${metaPid}) | 节点:${internalProxies.length} | 保活:${Math.round(metaTimeoutCalc/1000)}s`);
    await $.wait(META_START_DELAY); // 预热

  } catch (e) {
    $.error(`❌ Meta 启动失败: ${e.message}`);
    $.error(`请确保已安装 http-meta 且端口 ${META_PORT} 未被占用`);
    return proxies;
  }

  // --- 4. 并发执行检测 ---
  let finishedCount = 0;
  let validCount = 0;

  // 任务队列
  await executeAsyncTasks(
    internalProxies.map((proxy, idx) => async () => {
        // 传入对应的本地映射端口
        const port = metaPorts[idx];
        const isSupported = await checkWithRetry(proxy, port);
        
        finishedCount++;
        if (finishedCount % 5 === 0 || finishedCount === internalProxies.length) {
            $.info(`进度: ${finishedCount}/${internalProxies.length} (可用: ${validCount})`);
        }

        if (isSupported) {
            validCount++;
            const originalNode = proxies[proxy._proxies_index];
            if (!originalNode.name.includes(PREFIX)) {
                originalNode.name = `${PREFIX}${originalNode.name}`;
            }
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
    $.info(`🏁 检测结束，Meta 已关闭`);
  } catch (e) {}

  return proxies;

  // ================= 核心逻辑 =================

  // 带重试机制的检测函数
  async function checkWithRetry(proxy, port) {
    let lastErr;
    for (let i = 0; i <= RETRIES; i++) {
        try {
            const res = await http({
                method: 'get',
                url: TARGET_URL,
                timeout: TIMEOUT,
                // 这里假设 Sub-Store 环境通过 http://IP:PORT 代理
                proxy: `http://${META_HOST}:${port}`
            });
            
            const status = parseInt(res.status || res.statusCode || 0);
            
            // 成功：200
            if (status === 200) return true;
            
            // 明确失败：400 (地区不支持) -> 不需要重试，直接判负
            if (status === 400 || status === 403) return false;
            
            // 其他错误 (500, 502 等) -> 抛出异常以触发重试
            throw new Error(`Status ${status}`);

        } catch (e) {
            lastErr = e;
            if (i < RETRIES) await $.wait(RETRY_DELAY);
        }
    }
    // $.info(`[${proxy.name}] 失败: ${lastErr.message}`); // 调试用
    return false;
  }

  // 通用 HTTP 封装 (适配 Sub-Store)
  async function http(opt = {}) {
    const method = (opt.method || 'get').toLowerCase();
    if (typeof $.http[method] === 'function') {
        return await $.http[method](opt);
    } else {
        throw new Error(`$.http.${method} 不存在`);
    }
  }

  // 并发控制器
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
