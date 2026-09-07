# Driving a difit review over REST

An agent starts a review, gives a person its URL, and reads their comments back over
plain HTTP. No MCP server, no wrapper command, no library: `curl` and `jq` are enough.

## Starting a review

```bash
startup=$(difit --background --no-open HEAD)
```

`--background` starts a detached server and prints exactly **one** JSON document on
stdout, then the launcher exits. The server keeps running.

```json
{
  "sessionId": "0d8f5b6c-...",
  "port": 4966,
  "pid": 12345,
  "publicUrl": "http://localhost:4966",
  "apiUrl": "http://[::1]:4966",
  "url": "http://localhost:4966",
  "cursor": 0
}
```

| Field         | Use                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`   | Send it as `X-Difit-Session` on every request below.                                                                                     |
| `publicUrl`   | **Give this to the person.** Behind a reverse proxy it is the address they can actually open; `url` is an alias kept for older callers.  |
| `apiUrl`      | **Call this yourself.** Always a loopback origin — `http://127.0.0.1:<port>` or `http://[::1]:<port>` — never a proxy or wildcard alias. |
| `cursor`      | Where to start reading events. Zero, and the journal includes any comments imported at launch.                                           |
| `port`, `pid` | Diagnostics. Prefer `POST /api/session/stop` over signalling the pid.                                                                    |

```bash
difit_api=$(printf '%s' "$startup" | jq -er '.apiUrl')
difit_session=$(printf '%s' "$startup" | jq -er '.sessionId')
printf '%s\n' "$startup" | jq -r '.publicUrl'
```

Print the public URL **immediately**. The person cannot start reviewing until they have it,
and everything below is waiting for them.

> Every `curl` below passes `--noproxy '*'`. `apiUrl` is always loopback, but a `[::1]` origin is
> not covered by the usual `NO_PROXY=localhost,127.0.0.1`, so in a proxied environment the request
> would otherwise go to the proxy and come back as an error page rather than reaching the review.

## The seven routes

All are under `apiUrl`, all require `X-Difit-Session: <sessionId>`, and all are
`Cache-Control: no-store`.

| Route                                           | Returns                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/session`                              | `{ session }`                                                                       |
| `GET /api/threads`                              | A snapshot: `{ session, threads, version, cursor }`                                 |
| `GET /api/events?after=<cursor>&wait=<seconds>` | A page: `{ session, events, nextCursor, hasMore }`                                  |
| `GET /api/session/result?wait=<seconds>`        | Holds up to `wait`: `202 { session }` if still active, `200` snapshot once finished |
| `POST /api/threads/:id/messages`                | A snapshot plus `message` and `replayed`                                            |
| `PATCH /api/threads/:id`                        | A snapshot. Resolution is non-destructive                                           |
| `POST /api/session/stop`                        | The final snapshot, then the server shuts down                                      |

`session` carries the review's identity and state: `sessionId`, `state` (`active` or `finished`),
`reason`, `cursor`, `finishedCursor`, `finishedAt`, `cleanupAt`, `publicUrl`, `apiUrl`, `port`,
`pid`, `limits` (`idleGraceMs`, `timeoutMs`, `cleanupGraceMs`; `timeoutMs` is `null` only for a
foreground launch without `--timeout`, never for a background review), and `selection` /`selectionKey`
describing the revisions under review.

**The agent routes are pinned to the launch selection.** If the person browses a different
revision pair in the page, these routes keep reporting the review you started; there is no way to
retarget them, and no parameter that would.

Each event is `{ cursor, sessionId, type, actor, threadId?, messageId? }`. `actor` is `user` for
the person's own edits and for threads seeded at launch with `--comment`, `agent` for yours, and `system` for the single `review.finished` event.
Other types are `thread.created` / `.updated` / `.deleted`, `message.created` / `.updated` /
`.deleted`, `thread.resolved` and `thread.reopened`.

`wait` defaults to `0`, takes finite non-negative seconds, and is **capped at 25**. `after`
defaults to `0` when the parameter is omitted entirely; an empty, fractional, negative,
unsafe or ahead-of-current value is rejected. Always pass your own saved cursor explicitly.

An event page holds at most 100 events.

### Cursor and version are different numbers

- **`cursor`** indexes the event journal. It only ever moves forward, and it is how you
  avoid re-reading work you have already handled.
- **`version`** is the comment collection's version, and it is what a write must agree
  with. Send it as `expectedVersion`.

Completion moves the cursor without moving the version — finishing a review changes no
comment. So never derive one from the other.

### Errors

Every error is `{ "error": { "code", "message" }, "sessionId", "version" }`.

| Code                  | Status | Meaning                                                                 |
| --------------------- | ------ | ----------------------------------------------------------------------- |
| `session_required`    | 400    | No `X-Difit-Session` header.                                            |
| `invalid_request`     | 400    | Malformed body, parameter or query.                                     |
| `invalid_cursor`      | 400    | `after` is not a safe non-negative integer, or is ahead of the journal. |
| `version_required`    | 400    | A write arrived without `expectedVersion`.                              |
| `session_mismatch`    | 409    | The header names a different review. Nothing happened.                  |
| `version_conflict`    | 409    | Someone changed the collection first. Nothing happened.                 |
| `message_id_conflict` | 409    | That reply id was already used for different content.                   |
| `reply_deleted`       | 409    | The reply you are retrying was accepted and then deleted.               |
| `review_finished`     | 409    | Input is closed. Agent replies and resolutions still work.              |
| `session_stopping`    | 409    | The review is shutting down.                                            |
| `thread_not_found`    | 404    | No such thread.                                                         |

## Two ways to run the turn

### Event mode — react as comments arrive

```bash
cursor=0
while :; do
  page=$(curl --fail-with-body --noproxy '*' --max-time 30 -sS \
    -H "X-Difit-Session: $difit_session" \
    "$difit_api/api/events?after=$cursor&wait=25")
  case $? in
    0) ;;
    *) echo 'lost contact with the review server' >&2; exit 1 ;;
  esac

  cursor=$(printf '%s' "$page" | jq -er '.nextCursor')
  # ... handle the events, then re-read /api/threads for current text ...

  # The only thing that ends this loop: the review is over AND the journal is drained.
  state=$(printf '%s' "$page" | jq -er '.session.state')
  more=$(printf '%s' "$page" | jq -er '.hasMore')
  [ "$state" = finished ] && [ "$more" = false ] && break
done
```

Rules that matter:

- **Only `state: "finished"` with `hasMore: false` ends the loop.** Once the review has finished,
  `wait` stops blocking and an empty page returns immediately — so a loop with no exit test spins
  as fast as the network allows until the server exits under you. That is not the server going
  away; it is you having missed the end.
- **Keep your own cursor**, and advance it only from `nextCursor` on a page you actually
  received. A page can come back empty; that is not an error and not completion.
- **Coalesce.** Several events can describe one thread. Handle the thread once, then
  re-read `/api/threads` for its current text rather than reconstructing it from events.
- **Ignore your own replies.** Your writes appear in the journal as `actor: 'agent'`.
  Reacting to them loops.
- **A 25-second wait expiring is not completion.** It means nobody has said anything yet, and the
  page still says `state: "active"`.
- **A network failure is not an empty page.** Above, a non-zero `curl` status exits rather than
  advancing the cursor: you do not know what the server did, so the same cursor must be retried or
  the loss reported. Only a page you actually received may move it.

### Batch mode — wait for the whole review

```bash
while :; do
  answer=$(curl --fail-with-body --noproxy '*' --max-time 30 -sS -w '\n%{http_code}' \
    -H "X-Difit-Session: $difit_session" \
    "$difit_api/api/session/result?wait=25")
  code=$(printf '%s' "$answer" | tail -n1)
  body=$(printf '%s' "$answer" | sed '$d')

  case "$code" in
    200) break ;;                                            # finished; $body is the snapshot
    202) ;;                                                  # still active; ask again
    *) echo "review request failed: $code $body" >&2; exit 1 ;;
  esac
done
```

`202` means still active — repeat. `200` carries the final snapshot. **Anything else must stop the
loop**: `000` is a server that has gone away, `409` is a session that is not yours, and treating
either as "not finished yet" turns a fault into an infinite loop. Note the trailing status line has
to be stripped before the body is JSON again.

## Replying and resolving

```bash
curl --fail-with-body --noproxy '*' --max-time 30 -sS -X POST \
  -H "X-Difit-Session: $difit_session" -H 'Content-Type: application/json' \
  -d '{"id":"fix-null-check","body":"Fixed in abc1234.","expectedVersion":7}' \
  "$difit_api/api/threads/t1/messages"
```

**Choose the reply `id` yourself and keep it across retries.** A retry with the same id,
thread and body returns the original reply with `replayed: true` instead of posting a
duplicate. That is the only thing standing between an ambiguous network failure and two
identical comments.

On `version_conflict`, re-read `/api/threads`, look at what actually changed, and decide
again. Do not simply resend with a fresh version: the change you are overwriting may be
the person answering you.

```bash
curl --fail-with-body --noproxy '*' --max-time 30 -sS -X PATCH \
  -H "X-Difit-Session: $difit_session" -H 'Content-Type: application/json' \
  -d '{"resolved":true,"expectedVersion":8}' \
  "$difit_api/api/threads/t1"
```

Resolution hides nothing and deletes nothing — the thread and every message stay readable.
(The separate `difit comment resolve` CLI command still _removes_ a thread; the two are
not the same operation.)

## Finishing

A review finishes on its own in one of two ways, and the difference matters:

- **`browser_idle`** — the person opened the page and then closed it. The idle clock only starts
  once a browser has connected and then gone away; it runs for `--idle-grace` seconds (default 10).
- **`review_timeout`** — `--timeout` elapsed (default 3600). This is the _only_ thing that ends a
  review nobody ever opened: with no browser having connected, the idle clock never arms, and the
  review stays `active` however long you wait.

An explicit stop reports `agent_stop`.

Completion **closes user input**: the person can no longer add, edit or delete. Your
replies and resolutions still work, so you can record what you did.

After completion the server stays reachable for `--cleanup-grace` seconds (default 300)
and then exits. `cleanupAt` in the session tells you when. If you need longer for final
processing, **ask for it at launch** — there is no way to extend it afterwards.

```bash
curl --fail-with-body --noproxy '*' --max-time 30 -sS -X POST \
  -H "X-Difit-Session: $difit_session" \
  "$difit_api/api/session/stop"
```

Stop returns the final snapshot itself, so a separate last read is not needed — but stopping is
still the last thing you do, because the server goes away immediately afterwards.

**There is no recovery after the process exits.** Everything lives in memory: no restart
resumes a review, and a `sessionId` from a dead process is gone. If the server stops
answering, report that you lost it. Never infer that a review "must have finished".

## Migrating from `--format json`

The top-level `difit --format json` option is **gone**, along with its `session.started`
and `review.snapshot` NDJSON lines and the exit-code legend that went with them. Read the
review over REST instead, using the routes above.

Two things that sound similar and are **not** removed:

- `difit --background` still prints its startup JSON. That is the handshake documented at
  the top of this page.
- `difit comment get --format json` still works. Its payload has grown `sessionId`, `review` and
  `selection` alongside the threads it always returned, so a reader that indexes by name is
  unaffected. Without a selection the comment CLI addresses the review difit was launched for,
  even after the page has been switched to another revision pair.
