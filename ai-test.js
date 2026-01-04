/**
 * Gemini 批量检测脚本 (高性能参数化版)
 * * 使用方法:
 * 在 Sub-Store 脚本操作的 "Argument" 栏填入参数，格式如下 (URL Query 格式):
 * api_key=你的Key&concurrency=20&timeout=3000&prefix=[GM] 
 */

async function operator(proxies = [], targetPlatform, context) {
  // --- 1. 参数获取 (优先读取 Arguments，无参数则使用默认值) ---
  const args = $arguments || {};
  
  // [必填] Google API Key
  const USER_API_KEY = args.api_key || ''; 
  
  // [选填] 节点前缀 (默认 "[GM] ")
  const GM_PREFIX = args.prefix || '[GM] ';
  
  // [选填] 并发数 (默认 20，建议 10-50，太高可能会被 Google 429 限流)
  const CONCURRENCY = parseInt(args.concurrency || 20);
  
  // [选填] 超时时间 (毫秒，默认 3000ms，越短速度越快但可能误杀高延迟节点)
  const TIMEOUT = parseInt(args.timeout || 3000);

  // [选填] HTTP Meta 地址 (通常不用改)
  const META_HOST = args.meta_host || '127.0.0.1';
  const META_PORT = parseInt(args.meta_port || 9876);

  // 安全检查
  if (!USER_API_KEY) {
    $substore.error("❌ 错误: 未填写 api_key。请在 Sub-Store 参数栏填写 api_key=xxx");
    return proxies;
  }

  const $ = $substore;
  const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${USER_API_KEY}`;
  const internalProxies = [];

  // --- 2. 预处理：筛选并转换节点 ---
  proxies.forEach((proxy, index) => {
    // 简单过滤：只检测没有 [GM] 前缀的？(这里暂时全测，依靠逻辑去重)
    try {
      // 转换为 Meta 核心可识别的格式
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0];
      if (node) {
        // 保留 Sub-Store 内部字段
        for (const key in proxy) {
            if (/^_/i.test(key)) node[key] = proxy[key];
        }
        internalProxies.push({ ...node, _proxies_index: index });
      }
    } catch (e) {}
  });

  if (internalProxies.length === 0) return proxies;

  // --- 3. 启动 HTTP Meta 服务 ---
  const metaApiBase = `http://${META_HOST}:${META_PORT}`;
  let metaPid, metaPorts;

  try {
    const startRes = await http({
        method: 'post',
        url: `${metaApiBase}/start`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            proxies: internalProxies, 
            timeout: TIMEOUT + 5000 // 核心存活时间要略长于检测超时
        })
    });
    
    const body = JSON.parse(startRes.body);
    metaPid = body.pid;
    metaPorts = body.ports;
    $.info(`🚀 Meta 启动 (PID: ${metaPid}) | 并发: ${CONCURRENCY} | 超时: ${TIMEOUT}ms`);
    
    // 必须等待核心端口监听就绪，2秒通常足够
    await $.wait(2000); 

  } catch (e) {
    $.error(`❌ HTTP Meta 启动失败: ${e.message}`);
    return proxies;
  }

  // --- 4. 执行并发检测 ---
  const total = internalProxies.length;
  let finished = 0;
  let validCount = 0;

  // 使用 Promise 队列控制并发
  await executeAsyncTasks(
    internalProxies.map((proxy, idx) => async () => {
        const isOk = await checkNode(proxy, metaPorts[idx]);
        finished++;
        if (finished % 10 === 0 || finished === total) {
            $.info(`进度: ${finished}/${total} (可用: ${validCount})`);
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
    $.info(`🏁 检测完成，Meta 已关闭`);
  } catch (e) {}

  return proxies;

  // ================= 核心逻辑函数 =================

  async function checkNode(proxy, port) {
    try {
      // 通过本地 Meta 端口发起请求
      const res = await http({
        method: 'get',
        url: targetUrl,
        timeout: TIMEOUT,
        // 这里依赖 Sub-Store 环境能否正确处理 proxy 参数
        // 如果不能，通常通过 http://127.0.0.1:port/url 方式也不太行(HTTPS证书问题)
        // 所以我们假设 $.http 支持 proxy 选项
        proxy: `http://${META_HOST}:${port}`
      });

      const status = parseInt(res.status || res.statusCode || 0);
      
      // 200 = 成功返回模型列表
      if (status === 200) {
        validCount++;
        const originalProxy = proxies[proxy._proxies_index];
        // 避免重复加前缀
        if (!originalProxy.name.includes(GM_PREFIX)) {
            originalProxy.name = `${GM_PREFIX}${originalProxy.name}`;
        }
        return true;
      }
    } catch (e) {
      // 超时或网络错误，视为不可用，不打印日志以免刷屏
    }
    return false;
  }

  // 兼容性 HTTP 封装
  async function http(opt = {}) {
    const method = (opt.method || 'get').toLowerCase();
    if (typeof $substore.http[method] === 'function') {
        return await $substore.http[method](opt);
    } else {
        throw new Error(`Env Error: $.http.${method} not found`);
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
