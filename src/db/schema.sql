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

-- A payout: the ledger is debited in the same transaction that creates this row, before any money moves.
-- contributor_id is NULL for the sweep of seed people's shares into the labelled demo treasury.
CREATE TABLE IF NOT EXISTS claims (
  id             uuid PRIMARY KEY,
  contributor_id uuid REFERENCES contributors(id),
  micro          bigint NOT NULL,
  public_key     text,
  account_id     text,
  create_tx      text,
  transfer_tx    text,
  status         text NOT NULL CHECK (status IN ('pending', 'paid', 'failed')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS claim_id uuid REFERENCES claims(id);

-- A sign-in or re-check in flight. Bound to the browser by a cookie holding the state; used once.
CREATE TABLE IF NOT EXISTS auth_attempts (
  state        text PRIMARY KEY,
  nonce        text NOT NULL,
  verifier     text NOT NULL,
  expected_iss text,
  expected_sub text,
  return_to    text NOT NULL,
  created_at   double precision NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used'))
);

-- Contributor sessions. Only a hash of the cookie is stored. checked_at is the last passed identity check,
-- which gates anything that widens sharing or moves money.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash     text PRIMARY KEY,
  contributor_id uuid NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  provider       text NOT NULL,
  checked_at     timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Small settings that must survive restarts, such as the Ultrahuman client id registered for this deployment.
CREATE TABLE IF NOT EXISTS app_config (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- One data source per person: their Ultrahuman ring, or labelled sample data. Tokens are sealed with the
-- person's own key. last_sync holds counts per group, never values.
CREATE TABLE IF NOT EXISTS connections (
  contributor_id uuid PRIMARY KEY REFERENCES contributors(id) ON DELETE CASCADE,
  source         text NOT NULL CHECK (source IN ('ultrahuman', 'sample')),
  client_id      text,
  tokens_iv      bytea,
  tokens_blob    bytea,
  expires_at     timestamptz,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reconnect')),
  last_sync_at   timestamptz,
  last_sync      jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- An Ultrahuman authorization in flight: PKCE verifier, bound to the browser and the signed-in person, used once.
CREATE TABLE IF NOT EXISTS ring_attempts (
  state          text PRIMARY KEY,
  contributor_id uuid NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  client_id      text NOT NULL,
  verifier       text NOT NULL,
  return_to      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used'))
);

-- One person's answer to one pattern question over one date range, from one sealed read. Sealed with their key:
-- it is a fact about their health. Reused when the same question and range come again, so no new read is needed.
CREATE TABLE IF NOT EXISTS labels (
  contributor_id uuid NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  question_hash  text NOT NULL,
  from_day       date NOT NULL,
  to_day         date NOT NULL,
  iv             bytea NOT NULL,
  blob           bytea NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contributor_id, question_hash, from_day, to_day)
);

-- Things written for one person about their own data (the daily brief). Sealed with their key.
CREATE TABLE IF NOT EXISTS personal_insights (
  contributor_id uuid NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  ref            text NOT NULL,
  iv             bytea NOT NULL,
  blob           bytea NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contributor_id, ref)
);

-- Proof that a query's reads ran sealed: request ids and providers, with no person id, stored in shuffled order.
CREATE TABLE IF NOT EXISTS inference_calls (
  id          bigserial PRIMARY KEY,
  query_id    uuid REFERENCES queries(id),
  request_id  text,
  provider    text,
  model       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Which planted pattern each seed person carries, for checking demo answers. No query, prompt or price reads it.
CREATE TABLE IF NOT EXISTS seed_truth (
  contributor_id uuid PRIMARY KEY REFERENCES contributors(id) ON DELETE CASCADE,
  cohort         text NOT NULL
);
