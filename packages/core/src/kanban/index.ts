// @osstack/core/kanban — board layer over osstack tasks.
//
// Best practices borrowed from Hermes Agent's kanban (hermes-webui), adapted
// to osstack's SQLite state + Zod conventions:
//   - 6-lane board model + archived sink
//   - per-card event log → incremental polling + Telegram notify drain
//   - parent/child links, comments, priority, assignee, stats
//
// The Telegram path: Hermes relays a chat → osstack kanban skill → daemon
// RPC → KanbanRepository.subscribe(); KanbanNotifier.drain() pushes progress
// back through an injected transport.

export * from "./schema.js";
export * from "./repository.js";
export * from "./board.js";
export * from "./notify.js";
export * from "./transition-guard.js";
