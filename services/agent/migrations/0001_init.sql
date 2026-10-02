-- Agent2DB application schema. Everything lives in the `agent2db` schema so that a target
-- database's own tables (usually in `public`) stay separate, even when the dev database
-- doubles as a target. The LangGraph checkpointer tables are created in the same schema by
-- the library (search_path is set on its connections).

create schema if not exists agent2db;

-- array_to_string is only STABLE, which generated columns reject; for text[] it is safe to wrap.
create or replace function agent2db.join_words(text[]) returns text
    language sql immutable parallel safe
    as $$ select coalesce(array_to_string($1, ' '), '') $$;

create table if not exists agent2db.sessions (
    id          text primary key,
    title       text,
    model       text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table if not exists agent2db.runs (
    id          text primary key,
    session_id  text not null references agent2db.sessions(id) on delete cascade,
    status      text not null,
    model       text,
    message     text not null,
    answer      text,
    tokens_in   integer not null default 0,
    tokens_out  integer not null default 0,
    cost_usd    numeric(12, 6),
    steps       integer not null default 0,
    error       text,
    started_at  timestamptz not null default now(),
    ended_at    timestamptz
);
create index if not exists runs_session_idx on agent2db.runs (session_id, started_at);

create table if not exists agent2db.run_events (
    run_id      text not null references agent2db.runs(id) on delete cascade,
    seq         integer not null,
    type        text not null,
    payload     jsonb not null,
    created_at  timestamptz not null default now(),
    primary key (run_id, seq)
);

create table if not exists agent2db.approvals (
    id              bigserial primary key,
    run_id          text not null references agent2db.runs(id) on delete cascade,
    tool_call_id    text not null,
    tool_name       text not null,
    sql             text,
    statement_types text[] not null default '{}',
    warnings        text[] not null default '{}',
    estimate        jsonb,
    decision        text,
    feedback        text,
    requested_at    timestamptz not null default now(),
    decided_at      timestamptz,
    unique (run_id, tool_call_id)
);

create table if not exists agent2db.saved_queries (
    id          bigserial primary key,
    name        text not null,
    description text not null default '',
    sql         text not null,
    tables      text[] not null default '{}',
    tags        text[] not null default '{}',
    use_count   integer not null default 0,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    search      tsvector generated always as (
        to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '') || ' ' ||
                    agent2db.join_words(tables) || ' ' || agent2db.join_words(tags))
    ) stored,
    unique (name)
);
create index if not exists saved_queries_search_idx on agent2db.saved_queries using gin (search);

create table if not exists agent2db.facts (
    id          bigserial primary key,
    content     text not null,
    subject     text,
    tags        text[] not null default '{}',
    source      text not null default 'agent',
    created_at  timestamptz not null default now(),
    search      tsvector generated always as (
        to_tsvector('english', coalesce(content, '') || ' ' || coalesce(subject, '') || ' ' ||
                    agent2db.join_words(tags))
    ) stored
);
create index if not exists facts_search_idx on agent2db.facts using gin (search);

create table if not exists agent2db.schema_index (
    connection_id   text not null default 'default',
    table_name      text not null,            -- schema-qualified: public.orders
    kind            text not null,            -- table | view | materialized view | partitioned table
    comment         text,
    description     text not null,            -- searchable summary
    ddl             text not null,            -- rendered CREATE TABLE-like text
    columns         jsonb not null,
    foreign_keys    jsonb not null default '[]',
    row_estimate    bigint,
    embedding       real[],
    indexed_at      timestamptz not null default now(),
    primary key (connection_id, table_name)
);

create table if not exists agent2db.schema_index_meta (
    connection_id   text primary key default 'default',
    fingerprint     text not null,
    table_count     integer not null,
    embedding_model text,
    indexed_at      timestamptz not null default now()
);
