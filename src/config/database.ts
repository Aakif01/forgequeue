import "dotenv/config"; import { Pool } from "pg"; 
const requiredVariables = [
  "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", 
  "DB_PASSWORD",
]; for (const variable of requiredVariables) { if 
  (!process.env[variable]) {
    throw new Error(`Missing environment variable: 
    ${variable}`);
  }
}
const port = Number(process.env.DB_PORT); const 
poolMax = Number(process.env.DB_POOL_MAX ?? 5); if 
(!Number.isInteger(port) || port < 1 || port > 65535) 
{
  throw new Error("Invalid DB_PORT");
}
if (!Number.isInteger(poolMax) || poolMax < 1) { 
  throw new Error("Invalid DB_POOL_MAX");
}
export const pool = new Pool({ host: 
  process.env.DB_HOST, port, database: 
  process.env.DB_NAME, user: process.env.DB_USER, 
  password: process.env.DB_PASSWORD, max: poolMax, 
  idleTimeoutMillis: 30000, connectionTimeoutMillis: 
  5000,
});
pool.on("error", (error: Error) => { 
  console.error("Unexpected PostgreSQL pool error:", 
  error.message);
});
