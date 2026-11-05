-- One schema for PGlite locally and Postgres on Railway. Idempotent: safe to run on every start.

CREATE TABLE IF NOT EXISTS contributors (
  id          uuid PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('real', 'seed')),
  world_iss   text,
  world_sub   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_iss, world_sub)
);

-- The person's data key, wrapped by POOL_KEK. Deleting this row is withdrawal: their records become unreadable.
CREATE TABLE IF NOT EXISTS contributor_keys (
  contributor_id uuid PRIMARY KEY REFERENCES contributors(id) ON DELETE CASCADE,
  wrapped        bytea NOT NULL
);

-- A standing grant: these metric groups, history from this date, new days until expiry.
CREATE TABLE IF NOT EXISTS grants (
  id             uuid PRIMARY KEY,
  contributor_id uuid NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  groups         text[] NOT NULL,
  history_from   date NOT NULL,
  expires_at     date NOT NULL,
  auto_collect   boolean NOT NULL DEFAULT true,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grants_active ON grants (contributor_id) WHERE status = 'active';

-- One sealed row per person, day and metric group. date and grp stay plaintext for eligibility and day counts.
CREATE TABLE IF NOT EXISTS records (
  contributor_id uuid NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  day            date NOT NULL,
  grp            text NOT NULL,
  iv             bytea NOT NULL,
  blob           bytea NOT NULL,
  PRIMARY KEY (contributor_id, day, grp)
);
CREATE INDEX IF NOT EXISTS records_grp_day ON records (grp, day);

-- A priced plan for one query. The price is fixed here so the paid retry is charged exactly what the 402 said.
CREATE TABLE IF NOT EXISTS quotes (
  id           uuid PRIMARY KEY,
  spec         jsonb NOT NULL,
  price_micro  bigint NOT NULL,
  eligible     integer NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS queries (
  id            uuid PRIMARY KEY,
  quote_id      uuid UNIQUE REFERENCES quotes(id),
  route         text NOT NULL,
  spec          jsonb NOT NULL,
  price_micro   bigint NOT NULL,
  payer_account text,
  payment_tx    text UNIQUE,
  payment_id    text UNIQUE,
  epsilon       double precision NOT NULL,
  group_size    integer,
  result        jsonb,
  status        text NOT NULL CHECK (status IN ('pending', 'answered', 'unpaid')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Who was counted in a query: their privacy spend (summed for the lifetime cap) and days of data (for the pay split).
CREATE TABLE IF NOT EXISTS budget_spend (
  contributor_id uuid NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  query_id       uuid NOT NULL REFERENCES queries(id),
  epsilon        double precision NOT NULL,
  days           integer NOT NULL,
  PRIMARY KEY (contributor_id, query_id)
);

-- Off-chain money: earnings in, claims out. Kept on withdrawal for accounting, so no cascade.
CREATE TABLE IF NOT EXISTS ledger (
  id             bigserial PRIMARY KEY,
  contributor_id uuid,
  query_id       uuid REFERENCES queries(id),
  kind           text NOT NULL CHECK (kind IN ('earning', 'claim', 'platform')),
  micro          bigint NOT NULL,
  days           integer,
  tx             text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contributor_id, query_id, kind)
);
