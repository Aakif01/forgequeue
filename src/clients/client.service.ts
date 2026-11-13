
import { pool } from "../config/database.js";
import {
  generateApiKey,
  hashApiKey,
} from "../auth/api-key.js";

interface Client {
  id: string;
  name: string;
  is_active: boolean;
  created_at: Date;
}

interface RegisteredClient {
  client: Client;
  apiKey: string;
}

export async function registerClient(
  name: string
): Promise<RegisteredClient> {
  const normalizedName = name.trim();

  if (!normalizedName) {
    throw new Error("Client name cannot be empty");
  }

  if (normalizedName.length > 100) {
    throw new Error("Client name cannot exceed 100 characters");
  }

  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  const result = await pool.query<Client>(
    `INSERT INTO clients (name, api_key_hash)
     VALUES ($1, $2)
     RETURNING id, name, is_active, created_at`,
    [normalizedName, apiKeyHash]
  );

  return {
    client: result.rows[0],
    apiKey,
  };
}
