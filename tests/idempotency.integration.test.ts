import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { app } from "../src/app.js";
import { pool } from "../src/config/database.js";
import { registerClient } from "../src/clients/client.service.js";

describe("Idempotency payload comparison", () => {
  let server: Server;
  let baseUrl: string;
  let client: { id: string; apiKey: string };

  beforeAll(async () => {
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    const registered = await registerClient(
      `idempotency-${Date.now()}-${Math.random()}`
    );

    client = {
      id: registered.client.id,
      apiKey: registered.apiKey,
    };
  });

  afterAll(async () => {
    try {
      await pool.query(
        "DELETE FROM jobs WHERE client_id = $1",
        [client?.id]
      );

      if (client?.id) {
        await pool.query(
          "DELETE FROM clients WHERE id = $1",
          [client.id]
        );
      }
    } finally {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }

      await pool.end();
    }
  });

  it("treats objects with different property order as identical", async () => {
    const first = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "test.email",
        idempotencyKey: "property-order-test",
        payload: {
          to: "test@example.com",
          priority: 1,
        },
      }),
    });

    const second = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "test.email",
        idempotencyKey: "property-order-test",
        payload: {
          priority: 1,
          to: "test@example.com",
        },
      }),
    });

    const firstData = await first.json() as {
      job: { id: string };
    };

    const secondData = await second.json() as {
      job: { id: string };
    };

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(secondData.job.id).toBe(firstData.job.id);
  });
});