import "dotenv/config";

// Integration tests must never connect to the development database.
process.env.DB_NAME = "forgequeue_test";

// Allow concurrency tests to exercise PostgreSQL row locking.
process.env.DB_POOL_MAX = "20";
