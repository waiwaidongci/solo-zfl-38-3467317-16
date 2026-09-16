import { createApp, ConfigError } from "./lib/app.js";

const port = Number(process.env.PORT || 3038);

let app;
try {
  app = createApp({
    dbPath: process.env.DB_PATH || new URL("./data/knot-acceptance.json", import.meta.url).pathname,
  });
} catch (error) {
  // 配置错误：明确、稳定地以非零码退出，不带着失效保护启动
  if (error instanceof ConfigError) {
    console.error(`启动失败：${error.message}`);
    process.exit(1);
  }
  throw error;
}

const { server } = app;
server.on("error", (error) => {
  console.error(`服务启动失败：${error.code || error.message}`);
  process.exit(1);
});
server.listen(port, () => console.log(`绳结成型与滑移验收 listening on http://localhost:${port}`));
