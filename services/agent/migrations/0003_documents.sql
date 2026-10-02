-- Documents for retrieval-augmented answers, plus a small key/value settings table.
-- Chunk embeddings live here as real[] (Python-side cosine) unless Qdrant is configured, in which
-- case the vectors live in Qdrant and `embedding` stays NULL.

create table if not exists agent2db.settings (
    key         text primary key,
    value       jsonb not null,
    updated_at  timestamptz not null default now()
);

create table if not exists agent2db.documents (
    id           bigserial primary key,
    name         text not null,
    kind         text not null,              -- pdf | docx | markdown | text | html
    size_bytes   bigint not null,
    sha256       text not null,
    status       text not null default 'pending',   -- pending | processing | ready | failed
    error        text,
    chunk_count  integer not null default 0,
    char_count   integer not null default 0,
    pages        integer,
    tags         text[] not null default '{}',
    embedding_model text,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
create unique index if not exists documents_sha_idx on agent2db.documents (sha256);

create table if not exists agent2db.chunks (
    id           bigserial primary key,
    document_id  bigint not null references agent2db.documents(id) on delete cascade,
    idx          integer not null,
    heading      text,
    page         integer,
    content      text not null,
    char_count   integer not null,
    embedding    real[],
    search       tsvector generated always as (to_tsvector('english', coalesce(heading, '') || ' ' || content)) stored,
    unique (document_id, idx)
);
create index if not exists chunks_search_idx on agent2db.chunks using gin (search);
create index if not exists chunks_document_idx on agent2db.chunks (document_id);
