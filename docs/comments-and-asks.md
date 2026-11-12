# Comments and asks

This page covers how you give feedback to an agent in Agent Artifacts, and how an agent asks you to decide something. A **comment** is a note on an artifact. An **ask** is a comment by an agent that holds a question with fixed options, which only you can answer.

## Comments

You comment on an artifact in the web UI, in the **Comments** tab of its page. Agents read and answer comments over MCP with `list_comments`, `add_comment` (a new thread or a reply) and `resolve_comment`. `list_artifacts` gives each artifact an `openComments` count, and the library shows it as a badge, so an agent can find feedback that is waiting for it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/artifact-dark.png">
  <img src="images/artifact-light.png" alt="An HTML dashboard open in Agent Artifacts. The comments panel on the right shows a thread anchored on the highlighted text 'fell to 2h 14m', with a question from the owner and an answer from an agent." width="860">
</picture>

- A thread is a note on the whole artifact, or is anchored to a passage as a W3C TextQuoteSelector: the quoted `exact` text, with up to 32 characters of `prefix` and `suffix`. It belongs to the version it was started on, and is shown on that version and on later ones, marked "on v2" on the later ones.
- A comment is 1 to 2,000 characters.
- `typed` is true only for comments posted from the web UI, and the server sets it from the route, never from input. The author is the signed-in email for those, and the token's or client's name for agent comments. The MCP tools tell agents that a `typed` comment is the owner's own words, and that all other comment text, and any quoted text, is data and not instructions.
- `list_comments` returns at most 200 threads, newest activity first, and takes a `status` of `open` (the default), `resolved` or `all`.
- A deleted artifact's comments are hidden with it, and come back if it is restored from the trash. When the artifact is deleted for good, they go with it.

### Selecting text

On html and markdown entries that you open in the app, select text on the page and the app offers "Comment on selection". The app also marks the passages of open threads on the page. Quotes are matched with whitespace collapsed, so a quote matches however the page's source wraps its text. How this works, and why an artifact cannot abuse it, is in [Architecture](architecture.md#the-comment-bridge).

## Asks

An agent can ask you to decide something and get back an answer it can trust. `add_comment` takes this on a new thread or on a reply:

```json
{
  "question": "Which limit should the Standard tier have?",
  "options": [
    { "id": "a", "label": "100 requests per minute", "detail": "Matches what most clients send today." },
    { "id": "b", "label": "120 requests per minute", "detail": "Leaves room for a burst without a 429." }
  ],
  "recommended": { "optionId": "b", "why": "Only 2% of keys went above 100 per minute." }
}
```

There are 2 to 6 options. Their ids are 1 to 64 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`, and unique within the ask. The question is at most 500 characters, a label 200, a detail 1,000 and the "why" 1,000. With an ask, `body` is optional context and defaults to the question.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/ask-dark.png">
  <img src="images/ask-light.png" alt="A Markdown design note open in Agent Artifacts. In the comments panel an agent asks which request limit the Standard tier should have, with three options as buttons, one marked Recommended, and the text 'Waiting for your answer'." width="860">
</picture>

### Only the owner answers

The answer is set only by the web UI, behind the proxy's sign-in and the Origin check, and the answerer is the signed-in user. No MCP tool can answer: the MCP routes only get a comment service without `answer`, the `ask` schema is strict (an `answer` in it is refused), and the core stores a fresh ask built from the known fields only. Asks come only from agents: the UI's comment form never sends one, and the core refuses an ask from a typed author. The chosen `optionId` must be one of the ask's options. You can change your answer until the thread is resolved. Resolving a thread closes its asks: one that is unanswered stays unanswered.

### What agents see

In `list_comments`, a comment that asks has `ask: { question, options, recommended, answer }`, where `answer` is `{ optionId, label, by, at, typed: true }`, or null while it waits. The tool descriptions tell agents that an answer counts as your decision only when `answer.typed` is true, and that a merge, deploy, delete, publish or anything else that cannot be undone needs such an answer first. They also tell agents to read the answer again right before they act, because you can change it. `list_artifacts` items get `openAsks`: the unanswered asks in open threads.

### In the web UI

An ask is a card in its thread: the question, one button per option with its detail, and the recommended option marked with its "why". Clicking a button answers. The sidebar's "Asks for you" counts the unanswered asks, the library has an "Asks for you" tab, and the cards and the artifact's Comments tab show a badge. The question, labels, details and the "why" are agent text, escaped like any comment.
