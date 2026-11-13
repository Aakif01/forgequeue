import { readFile } from "node:fs/promises";
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

describe("Jobs API integration tests", () => {
  let server: Server;
  let baseUrl: string;

  let client: {
    id: string;
    apiKey: string;
  };

  const createdClientIds: string[] = [];

  beforeAll(async () => {
    const schema = await readFile(
      new URL("../src/database/schema.sql", import.meta.url),
      "utf8"
    );

    await pool.query(schema);

    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    const registered = await registerClient(
      `integration-${Date.now()}-${Math.random()}`
    );

    client = {
      id: registered.client.id,
      apiKey: registered.apiKey,
    };

    createdClientIds.push(client.id);
  });

  afterAll(async () => {
    try {
      if (createdClientIds.length > 0) {
        await pool.query(
          "DELETE FROM jobs WHERE client_id = ANY($1::uuid[])",
          [createdClientIds]
        );

        await pool.query(
          "DELETE FROM clients WHERE id = ANY($1::uuid[])",
          [createdClientIds]
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

  async function submitJob(
    apiKey: string,
    idempotencyKey: string,
    payload: unknown
  ) {
    return fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "test.email",
        payload,
        idempotencyKey,
      }),
    });
  }

  it("creates a job and returns HTTP 201", async () => {
    const response = await submitJob(
      client.apiKey,
      "integration-create-1",
      { to: "test@example.com" }
    );

    const data = await response.json() as {
      job: {
        id: string;
        status: string;
        client_id: string;
      };
    };

    expect(response.status).toBe(201);
    expect(data.job.id).toBeDefined();
    expect(data.job.status).toBe("pending");
    expect(data.job.client_id).toBe(client.id);
  });

  it("returns the existing job for an identical idempotent request", async () => {
    const payload = { to: "test@example.com" };

    const first = await submitJob(
      client.apiKey,
      "integration-idempotency-1",
      payload
    );

    const second = await submitJob(
      client.apiKey,
      "integration-idempotency-1",
      payload
    );

    const firstData = await first.json() as { job: { id: string } };
    const secondData = await second.json() as { job: { id: string } };

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(secondData.job.id).toBe(firstData.job.id);
  });

  it("rejects reuse of an idempotency key with a different payload", async () => {
    await submitJob(
      client.apiKey,
      "integration-idempotency-2",
      { to: "first@example.com" }
    );

    const response = await submitJob(
      client.apiKey,
      "integration-idempotency-2",
      { to: "different@example.com" }
    );

    expect(response.status).toBe(409);
  });

  it("allows a client to retrieve its own job", async () => {
    const created = await submitJob(
      client.apiKey,
      "integration-retrieve-1",
      { to: "test@example.com" }
    );

    const createdData = await created.json() as {
      job: { id: string };
    };

    const response = await fetch(
      `${baseUrl}/jobs/${createdData.job.id}`,
      {
        headers: {
          Authorization: `Bearer ${client.apiKey}`,
        },
      }
    );

    expect(response.status).toBe(200);
  });

  it("prevents one client from retrieving another client's job", async () => {
    const created = await submitJob(
      client.apiKey,
      "integration-isolation-1",
      { to: "private@example.com" }
    );

    const createdData = await created.json() as {
      job: { id: string };
    };

    const otherClient = await registerClient(
      `integration-other-${Date.now()}`
    );

    createdClientIds.push(otherClient.client.id);

    const response = await fetch(
      `${baseUrl}/jobs/${createdData.job.id}`,
      {
        headers: {
          Authorization: `Bearer ${otherClient.apiKey}`,
        },
      }
    );

    expect(response.status).toBe(404);
  });

  it("rejects an invalid job ID", async () => {
    const response = await fetch(`${baseUrl}/jobs/not-a-uuid`, {
      headers: {
        Authorization: `Bearer ${client.apiKey}`,
      },
    });

    expect(response.status).toBe(400);
  });

  
});
