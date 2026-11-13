CREATE TABLE IF NOT EXISTS clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    api_key_hash TEXT NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id),
    type TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    idempotency_key TEXT NOT NULL,
    locked_by TEXT,
    locked_until TIMESTAMPTZ,
    lease_token UUID,
    last_error TEXT,
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    CONSTRAINT valid_job_status
        CHECK (status IN (
            'pending',
            'running',
            'completed',
            'failed',
            'dead',
            'cancelled'
        )),

    CONSTRAINT valid_attempts
        CHECK (attempts >= 0 AND max_attempts >= 1),

    CONSTRAINT unique_client_idempotency
        UNIQUE (client_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_jobs_pending_run_at
ON jobs (run_at, created_at)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_jobs_expired_leases
ON jobs (locked_until)
WHERE status = 'running';
