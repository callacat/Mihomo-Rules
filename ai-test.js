/**
 * Gemini 检测脚本 (Sub-Store 兼容版)
 * 依赖: 必须在环境中有运行 http-meta 服务 (监听 127.0.0.1:9876)
 */
async function operator(proxies = [], targetPlatform, context) {
  const USER_API_KEY = $arguments.api_key || 'AIzaSyDc7sCw2X6wC6dUxzdeKrWxG9TLfr7mGkg'; 
  const GM_PREFIX = $arguments.prefix ?? '[GM] ';
  
  // --- 关键设置 ---
  // 如果你的 http-meta 在另一个 Docker 容器，这里不能填 127.0.0.1，要填容器名或宿主IP
  const http_meta_host = $arguments.http_meta_host ?? '127.0.0.1'; 
  const http_meta_port = $arguments.http_meta_port ?? 9876;
  
  const $ = $substore;
  const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${USER_API_KEY}`;
  const internalProxies = [];

  // 1. 转换节点
  proxies.map((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0];
      if (node) {
        // 过滤掉特殊字段，保留核心配置
        for (const key in proxy) {
            if (/^_/i.test(key)) node[key] = proxy[key];
        }
        internalProxies.push({ ...node, _proxies_index: index });
      }
    } catch (e) {}
  });

  if (!internalProxies.length) return proxies;

  // 2. 启动 HTTP META (必须先成功这一步)
  const http_meta_api = `http://${http_meta_host}:${http_meta_port}`;
  let http_meta_pid;
  let http_meta_ports = [];

  try {
      // 修复：使用小写 post
      const res = await http({
        method: 'post', 
        url: `${http_meta_api}/start`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxies: internalProxies, timeout: 20000 }),
      });
      
      const body = JSON.parse(res.body);
      if (!body.pid) throw new Error("无 PID 返回");
      
      http_meta_pid = body.pid;
      http_meta_ports = body.ports;
      $.info(`Meta 启动成功 PID: ${http_meta_pid}`);
      await $.wait(3000); // 等待服务就绪
  } catch(e) {
      $.error(`❌ 无法连接 HTTP Meta 服务: ${e.message}`);
      $.error(`请检查 Docker 是否安装了 http-meta，并且端口 ${http_meta_port} 是否可达`);
      return proxies; // 脚本终止，返回原节点
  }

  // 3. 执行检测
  // 限制并发为 5，避免把 API 冲爆
  const concurrency = 5; 
  await executeAsyncTasks(
    internalProxies.map(proxy => () => check(proxy)),
    { concurrency }
  );

  // 4. 关闭服务
  try {
    await http({
      method: 'post',
      url: `${http_meta_api}/stop`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: [http_meta_pid] }),
    });
  } catch (e) {}

  return proxies;

  // --- 核心检测逻辑 ---
  async function check(proxy) {
    try {
      const index = internalProxies.indexOf(proxy);
      // 修复：$.http 通常不支持 proxy 参数，这里通过直接访问 Meta 映射的端口来实现代理
      // 访问 http://127.0.0.1:PORT/url 这种形式 (HTTP 代理特性)
      // 或者配置 $.http 的 agent。但最通用的方法是直接把请求发给代理端口。
      
      const proxyPort = http_meta_ports[index];
      // 注意：这里需要 Sub-Store 环境支持通过代理发起请求
      // 如果 $.http 不支持 proxy 选项，这个脚本在 Sub-Store Node 版是跑不通的
      
      const res = await http({
        method: 'get',
        url: targetUrl,
        timeout: 5000,
        // 尝试传递代理参数 (取决于 Sub-Store 具体实现)
        proxy: `http://${http_meta_host}:${proxyPort}` 
      });

      const status = parseInt(res.status || res.statusCode || 0);
      if (status === 200) {
        $.info(`[${proxy.name}] ✅ 可用`);
        if (!proxies[proxy._proxies_index].name.startsWith(GM_PREFIX)) {
             proxies[proxy._proxies_index].name = `${GM_PREFIX}${proxies[proxy._proxies_index].name}`;
        }
      } else {
        $.info(`[${proxy.name}] ❌ 不可用 (${status})`);
      }
    } catch (e) {
        // 忽略网络错误
    }
  }

  // 修复：封装 $.http 避免方法不存在报错
  async function http(opt = {}) {
    const method = (opt.method || 'get').toLowerCase(); // 强制小写
    // Sub-Store 的 $.http.get/post 签名通常是 (opts) => Promise
    if (typeof $.http[method] === 'function') {
        return await $.http[method](opt);
    } else {
        throw new Error(`$.http.${method} 不是一个函数`);
    }
  }

  function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise(async (resolve) => {
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
