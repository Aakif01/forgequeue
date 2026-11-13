import "dotenv/config";

// Integration tests must never connect to the development database.
process.env.DB_NAME = "forgequeue_test";
