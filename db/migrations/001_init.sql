-- WOM migration 001: initial schema.
--
-- Applied by the project owner (wom_owner). Three roles touch the data:
--   wom_owner   migrations only. Never deployed.
--   wom_app     the API and build worker. Subject to row-level security; can debit its own credits and redeem promo
--               codes, but cannot grant credits, change roles, or read other people's rows.
--   wom_system  the Stripe webhook, admin tools and promo minting. Full access.
-- wom_app and wom_system are created here without a login. scripts/db-roles.mjs gives them passwords, so no
-- password ever lives in git. On Neon, roles made with SQL are not members of neon_superuser, so row-level
-- security applies to them.
--
-- The API sets the caller once per transaction:
--   select set_config('app.user_id', $1, true), set_config('app.role', $2, true);

begin;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'wom_app')    then create role wom_app    nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'wom_system') then create role wom_system nologin; end if;
end $$;

create schema if not exists wom;
grant usage on schema wom to wom_app, wom_system;

create function wom.uid() returns text language sql stable as
  $$ select nullif(current_setting('app.user_id', true), '') $$;
create function wom.is_admin() returns boolean language sql stable as
  $$ select coalesce(current_setting('app.role', true), '') = 'admin' $$;

-- ---------------------------------------------------------------- users

create table users (
  id text primary key,                                   -- Clerk user id
  -- The public name in wom.quest/u/<handle>/<world>. 3 to 30 characters, lower case, digits and hyphens.
  handle text unique check (
    handle ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$'
    and handle not in (
      'admin','administrator','api','app','assets','static','files','cdn','www','u','w','wom','quest','help','support',
      'about','terms','privacy','legal','login','logout','signin','sign-in','signup','sign-up','register','account',
      'accounts','clerk','clkmail','billing','credits','pricing','bench','benchmark','settings','profile','explore',
      'discover','new','create','null','undefined','root','system','staff','mod','moderator','security','abuse',
      'report','status','blog','docs','mail','email'
    )
  ),
  handle_changed_at timestamptz,
  role text not null default 'user' check (role in ('user','admin')),
  credits bigint not null default 0 check (credits >= 0),
  stripe_customer_id text unique,
  created_at timestamptz not null default now()
);

alter table users enable row level security;
create policy users_read   on users for select using (id = wom.uid() or wom.is_admin());
create policy users_insert on users for insert with check (id = wom.uid() and role = 'user' and credits = 0);
create policy users_update on users for update using (id = wom.uid() or wom.is_admin()) with check (id = wom.uid() or wom.is_admin());
grant select on users to wom_app;
grant insert (id, handle) on users to wom_app;
grant update (handle, handle_changed_at, stripe_customer_id) on users to wom_app;

-- What the public pages need about an owner, without exposing the rest of the row.
create view public_profiles as select id, handle from users where handle is not null;
grant select on public_profiles to wom_app;

-- ---------------------------------------------------------------- worlds

create table worlds (
  id text primary key check (id ~ '^[a-z0-9]{6,32}$'),
  owner_id text not null references users(id),
  title text not null default 'Untitled memory',
  status text not null default 'queued',
  visibility text not null default 'link' check (visibility in ('private','link')),   -- link = anyone with the link
  removed_at timestamptz,                                -- takedown: hides the world from everyone but its owner
  removed_reason text,
  manifest jsonb not null,
  objects_count int not null default 0,                  -- denormalised for the list
  has_world boolean not null default false,
  cost_usd numeric(10,4) not null default 0,
  scene_key text,                                        -- current scene.<version>.json in storage
  version bigint not null default 0,                     -- optimistic concurrency on manifest writes
  lease_until timestamptz,                               -- one pipeline worker per world
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index worlds_owner_created on worlds (owner_id, created_at desc);

alter table worlds enable row level security;
create policy worlds_read on worlds for select
  using ((visibility = 'link' and removed_at is null) or owner_id = wom.uid() or wom.is_admin());
create policy worlds_insert on worlds for insert with check (owner_id = wom.uid());
create policy worlds_update on worlds for update
  using (owner_id = wom.uid() or wom.is_admin()) with check (owner_id = wom.uid() or wom.is_admin());
create policy worlds_delete on worlds for delete using (owner_id = wom.uid() or wom.is_admin());
grant select, delete on worlds to wom_app;
grant insert (id, owner_id, title, status, visibility, manifest, objects_count, has_world, cost_usd, scene_key, version, lease_until, created_at, updated_at) on worlds to wom_app;
grant update (title, status, visibility, manifest, objects_count, has_world, cost_usd, scene_key, version, lease_until, updated_at) on worlds to wom_app;   -- not removed_at

create table world_log (
  world_id text not null references worlds(id) on delete cascade,
  seq int not null,
  at timestamptz not null default now(),
  message text not null,
  primary key (world_id, seq)
);
alter table world_log enable row level security;
create policy world_log_owner on world_log for all
  using (exists (select 1 from worlds w where w.id = world_id and (w.owner_id = wom.uid() or wom.is_admin())))
  with check (exists (select 1 from worlds w where w.id = world_id and (w.owner_id = wom.uid() or wom.is_admin())));
grant select, insert, delete on world_log to wom_app;

-- ---------------------------------------------------------------- dollars spent on models (the old ledger.jsonl)

create table ledger (
  id bigserial primary key,
  at timestamptz not null,
  owner_id text not null references users(id),
  context text not null,                                 -- pipeline | bench
  provider text not null,
  label text not null,
  usd numeric(12,6) not null check (usd > 0),
  estimated boolean,
  world_id text references worlds(id) on delete set null,
  model text, job_id text, ref text, backfilled boolean
);
create index ledger_owner_at on ledger (owner_id, at desc);
create index ledger_world on ledger (world_id);
alter table ledger enable row level security;
create policy ledger_read   on ledger for select using (owner_id = wom.uid() or wom.is_admin());
create policy ledger_insert on ledger for insert with check (owner_id = wom.uid());
grant select, insert on ledger to wom_app;
grant usage on sequence ledger_id_seq to wom_app;

-- ---------------------------------------------------------------- observations and slides

create table observations (
  id text primary key,
  world_id text not null references worlds(id) on delete cascade,
  owner_id text not null references users(id),           -- the world's owner
  author text,                                           -- Clerk user id, or 'agent:<name>'
  status text not null,                                  -- open | confirmed | false alarm | fixed | won't fix
  layer text, category text,
  record jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index observations_owner_status on observations (owner_id, status);
alter table observations enable row level security;
create policy observations_read on observations for select using (owner_id = wom.uid() or author = wom.uid() or wom.is_admin());
create policy observations_insert on observations for insert
  with check (author = wom.uid() and owner_id = (select w.owner_id from worlds w where w.id = world_id));   -- worlds RLS: only worlds the caller may see
create policy observations_update on observations for update
  using (owner_id = wom.uid() or wom.is_admin()) with check (owner_id = wom.uid() or wom.is_admin());
grant select, insert, update on observations to wom_app;

create table slides (
  id text primary key,
  world_id text not null references worlds(id) on delete cascade,
  owner_id text not null references users(id),
  position int not null,
  record jsonb not null,
  created_at timestamptz not null default now()
);
alter table slides enable row level security;
create policy slides_read  on slides for select using (exists (select 1 from worlds w where w.id = world_id));   -- visible when the world is
create policy slides_write on slides for all
  using (owner_id = wom.uid() or wom.is_admin()) with check (owner_id = wom.uid() or wom.is_admin());
grant select, insert, update, delete on slides to wom_app;

-- ---------------------------------------------------------------- benchmarks (owner only)

create table bench_runs (
  owner_id text not null references users(id),
  task text not null,
  id text not null,                                      -- 20261101-215829; unique per owner, not globally
  visibility text not null default 'private' check (visibility in ('private','public')),   -- reserved; only 'private' is honoured today
  summary jsonb not null,                                -- RunItem: caseCount, spendUsd, subjects, dims
  results_key text not null,                             -- results.json in storage
  started_at timestamptz, finished_at timestamptz,
  primary key (owner_id, task, id)
);
alter table bench_runs enable row level security;
create policy bench_runs_owner on bench_runs for all
  using (owner_id = wom.uid() or wom.is_admin()) with check (owner_id = wom.uid() or wom.is_admin());
grant select, insert, update, delete on bench_runs to wom_app;

create table bench_labels (                              -- human notes and expected verdicts
  owner_id text not null references users(id),
  task text not null,
  key text not null,
  label jsonb not null,                                  -- { exclude?, note?, expected?, revision? }
  updated_at timestamptz not null default now(),
  primary key (owner_id, task, key)
);
alter table bench_labels enable row level security;
create policy bench_labels_owner on bench_labels for all
  using (owner_id = wom.uid() or wom.is_admin()) with check (owner_id = wom.uid() or wom.is_admin());
grant select, insert, update, delete on bench_labels to wom_app;

-- ---------------------------------------------------------------- credits

create table credit_ledger (
  id bigserial primary key,
  user_id text not null references users(id),
  at timestamptz not null default now(),
  delta bigint not null check (delta <> 0),              -- + grant, - charge
  kind text not null check (kind in ('purchase','promo','hold','release','refund','adjustment')),
  ref text,                                              -- checkout session, promo id, world id, run id
  idem text not null unique,                             -- 'stripe:cs_...', 'promo:<id>:<user>', 'hold:<world>:1'
  note text
);
create index credit_ledger_user_at on credit_ledger (user_id, at desc);
alter table credit_ledger enable row level security;
create policy credit_ledger_read on credit_ledger for select using (user_id = wom.uid() or wom.is_admin());
grant select on credit_ledger to wom_app;                -- writes happen only through the functions below

-- Apply a change atomically and idempotently. Overdrawing trips users_credits_check and rolls everything back.
create function wom.credit_apply(p_user text, p_delta bigint, p_kind text, p_ref text, p_idem text, p_note text)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare bal bigint;
begin
  insert into credit_ledger (user_id, delta, kind, ref, idem, note)
  values (p_user, p_delta, p_kind, p_ref, p_idem, p_note)
  on conflict (idem) do nothing;
  if not found then                                      -- replay of a change already applied
    select credits into bal from users where id = p_user;
    return bal;
  end if;
  update users set credits = credits + p_delta where id = p_user returning credits into bal;
  if bal is null then raise exception 'unknown user %', p_user; end if;
  return bal;
end $$;
revoke all on function wom.credit_apply(text, bigint, text, text, text, text) from public;

-- Charge the signed-in user (a world, a benchmark run). Fails when the balance is too low.
create function wom.credit_debit(p_amount bigint, p_ref text, p_idem text)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if wom.uid() is null then raise exception 'not signed in'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be positive'; end if;
  return wom.credit_apply(wom.uid(), -p_amount, 'hold', p_ref, p_idem, null);
end $$;

-- Give back part of what was charged for a ref (a failed build, an unused benchmark estimate). Never more than was charged.
create function wom.credit_release(p_ref text, p_amount bigint, p_idem text)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare outstanding bigint;
begin
  if wom.uid() is null then raise exception 'not signed in'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be positive'; end if;
  perform 1 from users where id = wom.uid() for update;  -- serialise concurrent releases
  select coalesce(-sum(delta) filter (where kind = 'hold'), 0) - coalesce(sum(delta) filter (where kind = 'release'), 0)
    into outstanding from credit_ledger where user_id = wom.uid() and ref = p_ref;
  if p_amount > outstanding then raise exception 'cannot release more than was charged'; end if;
  return wom.credit_apply(wom.uid(), p_amount, 'release', p_ref, p_idem, null);
end $$;

-- System only: purchases, promos and admin adjustments.
create function wom.credit_grant(p_user text, p_amount bigint, p_kind text, p_ref text, p_idem text, p_note text default null)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be positive'; end if;
  if p_kind not in ('purchase','promo','adjustment') then raise exception 'bad kind'; end if;
  return wom.credit_apply(p_user, p_amount, p_kind, p_ref, p_idem, p_note);
end $$;
-- System only: refunds and disputes (negative) or corrections (either sign).
create function wom.credit_adjust(p_user text, p_delta bigint, p_kind text, p_ref text, p_idem text, p_note text default null)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_kind not in ('refund','adjustment') then raise exception 'bad kind'; end if;
  return wom.credit_apply(p_user, p_delta, p_kind, p_ref, p_idem, p_note);
end $$;

revoke all on function wom.credit_debit(bigint, text, text)                          from public;
revoke all on function wom.credit_release(text, bigint, text)                        from public;
revoke all on function wom.credit_grant(text, bigint, text, text, text, text)        from public;
revoke all on function wom.credit_adjust(text, bigint, text, text, text, text)       from public;
grant execute on function wom.credit_debit(bigint, text, text)                       to wom_app, wom_system;
grant execute on function wom.credit_release(text, bigint, text)                     to wom_app, wom_system;
grant execute on function wom.credit_grant(text, bigint, text, text, text, text)     to wom_system;
grant execute on function wom.credit_adjust(text, bigint, text, text, text, text)    to wom_system;
grant execute on function wom.credit_apply(text, bigint, text, text, text, text)     to wom_system;

-- ---------------------------------------------------------------- promo codes

create table promo_codes (
  id bigserial primary key,
  code_hash text not null unique,                        -- sha-256 of the upper-case code; shown once, when minted
  credits bigint not null check (credits > 0),
  max_redemptions int not null default 1 check (max_redemptions > 0),
  redeemed int not null default 0,
  expires_at timestamptz,
  disabled boolean not null default false,
  note text,                                             -- 'judges', 'testing', who it was minted for
  created_at timestamptz not null default now()
);
create table promo_redemptions (
  promo_id bigint not null references promo_codes(id),
  user_id text not null references users(id),
  at timestamptz not null default now(),
  primary key (promo_id, user_id)                        -- one redemption per user
);
alter table promo_codes enable row level security;       -- no policy for wom_app: invisible to it
alter table promo_redemptions enable row level security;
create policy promo_redemptions_read on promo_redemptions for select using (user_id = wom.uid() or wom.is_admin());
grant select on promo_redemptions to wom_app;

create function wom.redeem_promo(p_code text)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare p promo_codes%rowtype;
begin
  if wom.uid() is null then raise exception 'not signed in'; end if;
  select * into p from promo_codes
    where code_hash = encode(sha256(convert_to(upper(trim(p_code)), 'UTF8')), 'hex') for update;
  -- One message for every failure, so a guess learns nothing.
  if not found or p.disabled or (p.expires_at is not null and p.expires_at < now()) or p.redeemed >= p.max_redemptions then
    raise exception 'invalid or expired code';
  end if;
  insert into promo_redemptions (promo_id, user_id) values (p.id, wom.uid());
  update promo_codes set redeemed = redeemed + 1 where id = p.id;
  return wom.credit_apply(wom.uid(), p.credits, 'promo', 'promo:' || p.id, 'promo:' || p.id || ':' || wom.uid(), null);
end $$;
revoke all on function wom.redeem_promo(text) from public;
grant execute on function wom.redeem_promo(text) to wom_app, wom_system;

-- ---------------------------------------------------------------- Stripe webhook bookkeeping

create table stripe_events (
  id text primary key,                                   -- Stripe event id; insert first, skip the event if it conflicts
  type text not null,
  received_at timestamptz not null default now()
);
alter table stripe_events enable row level security;

-- ---------------------------------------------------------------- wom_system: everything, on every table

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('grant all on public.%I to wom_system', t);
    execute format('create policy system_all on public.%I to wom_system using (true) with check (true)', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to wom_system;
grant select on public_profiles to wom_system;

commit;
