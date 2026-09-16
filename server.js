import { createApp } from "./lib/app.js";

const port = Number(process.env.PORT || 3038);
const { server } = createApp({
  dbPath: process.env.DB_PATH || new URL("./data/knot-acceptance.json", import.meta.url).pathname,
});

server.listen(port, () => console.log(`绳结成型与滑移验收 listening on http://localhost:${port}`));
