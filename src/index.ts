import "dotenv/config";
import { app } from "./app.js";

const PORT = Number(process.env.PORT ?? 3000);

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`ForgeQueue API running on http://127.0.0.1:${PORT}`);
});

async function shutdown() {
  console.log("Shutting down ForgeQueue API...");

  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
