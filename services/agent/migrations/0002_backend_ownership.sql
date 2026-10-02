-- Several backend processes may share one app database (two desktop launches, or several cloud
-- instances). Each process registers itself and heartbeats; runs record their owner so restart
-- recovery only touches runs whose owner has stopped heartbeating.

create table if not exists agent2db.backends (
    id           text primary key,
    hostname     text,
    pid          integer,
    version      text,
    started_at   timestamptz not null default now(),
    heartbeat_at timestamptz not null default now()
);

alter table agent2db.runs add column if not exists backend_id text;
create index if not exists runs_backend_idx on agent2db.runs (backend_id) where status in ('running', 'awaiting_approval');
