# GraphQL API

> Status: **deferred**. Last updated 2026-10-02.

## Decision

v1 uses REST + SSE between the Electron app and the Python backend (see
[backend-python.md](backend-python.md)). Reasons: one local client, streaming agent events fit
SSE naturally, and FastAPI's OpenAPI output gives typed TypeScript clients for free.

GraphQL becomes worth it if any of these happen:
- multiple clients (web app, other tools) need flexible queries over runs, snippets, queries;
- the knowledge graph needs nested traversal queries from the UI;
- we want a "GraphQL MCP" that lets agents query Agent2DB's own data.

## If we add it

- Server: Strawberry (Python) mounted on the same FastAPI app at `/graphql`, same token auth.
- Read-mostly schema: `Session`, `Run`, `RunEvent`, `SavedQuery`, `Snippet`, `KgNode`, `KgEdge`.
- Mutations limited to saved queries, snippets and KG facts; agent runs stay on REST/SSE.
- Depth and complexity limits, no introspection in production builds.

## Open Questions

1. Is a GraphQL layer still wanted, or was "GraphQL" meant to be "LangGraph"? (LangGraph is
   covered in [agent-design.md](agent-design.md).)
