# Kanban board

The daemon keeps a kanban board that users drive from the CLI and that chat relays subscribe to. Cards move through `triage|todo|ready|running|blocked|done|archived`, and every change is an event a relay can drain.

## Sub-features

- `kanban-create` creates a card in `triage` with optional priority and assignee.
- `kanban-move` moves a card between statuses.
- `kanban-comment` adds a comment to a card.
- `kanban-board` shows columns and cards (`--archived` includes archived).
- `kanban-subscribe` records a chat subscription for a card.
- `kanban-events` drains card events since an id.
- `kanban-missing` rejects unknown card ids.
- `kanban-cockpit` the card shows in the cockpit `#board`.

## How to get to it (user POV)

- Run `osstack kanban create|move|comment|board|subscribe|events ...` in a terminal (daemon required).
- Open the cockpit at `/dashboard` and look at `KANBAN BOARD`.

## Driving it with verify-osstack.sh

Preconditions:

- Doctor healthy; the board is empty (`kanban board` shows `0 cards`).

- **Create.** Run `$V cli create -- kanban create "Verify card" --priority 1 --assignee codex-cli`. Exit `0`; stdout `created card_<id>: Verify card`. Save the id as `C`.
- **Board.** Run `$V cli board-1 -- kanban board`. Stdout `Board: default  (1 cards, ...)` and `TRIAGE (1)` lists `C  Verify card  [P1 · codex-cli]`.
- **Move.** Run `$V cli move -- kanban move "$C" running`. Stdout `<C> → running`. `kanban board` now lists it under `RUNNING (1)`.
- **Comment.** Run `$V cli comment -- kanban comment "$C" "verification note"`. Stdout `commented on <C>`.
- **Subscribe.** Run `$V cli subscribe -- kanban subscribe "$C" telegram 12345`. Exit `0`; stdout `subscribed telegram:12345 to <C>`.
- **Events.** Run `$V cli events -- kanban events --since 0`. JSON `events[]` has, in order, `created` (`status: triage`), `moved` (`from: triage, to: running, actor: cli`), `commented` (`body: verification note`), all with `card_id == C`. Subscribing adds no event.
- **Missing card.** Run `$V cli move-missing -- kanban move card_nosuch done`. Exit `1`; stderr `Kanban card not found: card_nosuch`.
- **Cockpit.** Run `$V screenshot kanban /dashboard "Verify card"`. Exit `0`; `ui/kanban.text.txt` contains `Verify card`; `ui/kanban.api-dashboard.json` `.board.columns[]` has the card under `running`.

## Gotchas

- Every kanban command needs the daemon; without it the CLI prints `daemon not running (socket: ...)` and exits `1`. This is a precondition failure, not a kanban bug.
- `kanban --help` is not a help flag; it prints `unknown kanban subcommand` and the subcommand list.
- Card ids are random (`card_<8 hex>`). Parse them from the `create` stdout; do not hard-code.
- `kanban events` payloads are JSON strings inside JSON; parse twice.
- `subscribe` records state only. No message is sent anywhere; there is no built-in Telegram/Feishu transport in this repo.
