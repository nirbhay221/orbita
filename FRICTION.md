# Friction log

Developer feedback from building Orbita, an Alexa+ MCP add-on, against the Alexa+ documentation
as it stood on 9 September 2026. Every entry is something that actually cost time on this build,
with what was expected, what happened, and what would fix it.

Severity is judged by effect on a developer trying to ship, not by how annoying it was.

---

## 1. The Display Modes page says "declare in your tool", but display modes are not declared in the tool

**Severity: high. Following the page as written leads to a panel that never renders.**

**Task.** Declare inline and fullscreen support so the Echo Show render is something better than a
text fallback.

**Steps.** Read *MCP Design Guide, Display Modes* (`/docs/alexaplus/add-ons/mcp-addon-display-modes.html`),
then *Layout and Rendering* (`mcp-addon-layout-and-rendering.html`), then *Components and Patterns*,
then the MCP Toolkit Overview, looking for the tool-side key the first page describes.

**Expected.** A literal metadata key and a short code sample.

**Actual.** The Display Modes page states: *"As the developer, you declare in your tool what you
support (inline, fullscreen, or both)."* No page gives a key, JSON or sample. The answer is in the
MCP Apps specification (`ext-apps`, version 2026-01-26), and it is not in the tool at all. A tool
only links its view, with a nested `_meta.ui.resourceUri` (the flat `ui/resourceUri` key is marked
deprecated). The **view** declares display modes, in `appCapabilities.availableDisplayModes` inside
the `ui/initialize` request it sends to the host, and the host may not send the view anything,
including the tool result, until the view has also sent `ui/notifications/initialized`.

An earlier version of this entry said display modes could not be implemented. That was wrong, and
the mistake cost more than the missing sample: this project's first panel pointed at itself with a
flat `'ui.resourceUri'` key and only listened for messages, never sending `ui/initialize`, so on a
real host it would have sat on its placeholder forever. No test caught it, because no test played
the host.

**Workaround.** Followed the MCP Apps specification: nested `_meta.ui.resourceUri` on each tool, and
a view that sends `ui/initialize` with `availableDisplayModes: ["inline", "fullscreen"]`, waits for
the answer, confirms initialization, then renders `ui/notifications/tool-result`. `test-panel.mjs`
now runs the panel script against a simulated host and checks every step of that handshake.

**Suggestion.** Change "declare in your tool" to say where the declaration actually lives, and put
the five lines that matter on the page: the tool's `_meta.ui.resourceUri`, the view's
`ui/initialize` request with `availableDisplayModes`, and the `ui/notifications/initialized`
notification. Link the MCP Apps specification by version. A developer who follows the current
sentence literally builds a panel that never receives data.

---

## 2. A design guide link in the MCP Toolkit Overview returns 404

**Severity: low. Costs minutes, but it is on the page most people start from.**

**Task.** Open the MCP Design Guide referenced from the MCP Toolkit Overview.

**Steps.** From `mcp-toolkit-overview.html`, follow the reference to the "MCP Design Guide for
Alexa+".

**Expected.** The design guide.

**Actual.** `https://developer.amazon.com/docs/alexaplus/add-ons/mcp-design-guide.html` returns
HTTP 404. The real pages exist under a different prefix: `mcp-addon-design-guide-overview.html`,
`mcp-addon-display-modes.html`, `mcp-addon-layout-and-rendering.html` and so on.

**Workaround.** Found the correct URLs from the index on `add-ons/home.html`.

**Suggestion.** Repoint the link, or add a redirect from the old path. Anyone who bookmarked the
pre-rename URL currently hits a dead end.

---

## 3. The MCP QuickStart reads as generally available when the add-on path is gated

**Severity: high. It shapes whether a project is deliverable at all.**

**Task.** Work out whether this add-on can be deployed and demonstrated on a real device before
the hackathon deadline.

**Steps.** Read the MCP QuickStart, which presents a clean three-command path: `alexa-ai
configure`, `alexa-ai new mcp --mcp-server-url ...`, `alexa-ai deploy`. Then read the Alexa+
Add-ons overview and the July 2026 launch blog.

**Expected.** Either the commands work, or the page says up front what access is required and how
to request it.

**Actual.** The overview states that MCP support is in preview and that "developers are required
to sign up and agree to the terms of the release to use" preview features. The QuickStart does not
carry that qualification where the commands are, so the natural reading is that the CLI is
available. Working out that the add-on path is gated took reading three pages plus a third-party
repository whose README says it exists precisely because "Alexa+ add-on tooling is not open to the
public yet".

**Workaround.** Documented a second demo path through
[`KayLerch/alexa-skill-mcp-bridge`](https://github.com/KayLerch/alexa-skill-mcp-bridge), which
stands an ordinary Alexa Skill where the add-on would go and runs in the developer console
simulator. That works, but a developer should not have to find it on GitHub.

**Suggestion.** Put a one-line availability banner at the top of the QuickStart: whether the CLI
is open, who can get it, and a direct enrolment link. If it is gated during the hackathon window,
say so in the hackathon resources too, and point at a supported way to demo. This is the single
highest-value documentation change on this list, because it determines whether a submission has a
demo video.

---

## 4. Certification requirements are excellent and should be linked from the QuickStart

**Severity: low. This one is praise with a placement note.**

`functional-requirements.html` is the most useful page in the set. It is specific and testable:
never return an empty response, give an actionable next step on every error, no jargon or internal
IDs in customer-facing text, complete every critical feature by voice alone, never reference a
screen on a screenless device, keep spoken and displayed content from contradicting, cap options
at five, and put synonyms and abbreviations in parameter descriptions.

Four defects in this codebase were found by reading it rather than by testing: a bare "I can't
reach NOAA right now" with no next step, a status sweep hardcoded to three agriculture jobs so
newer trades were unreachable, a guard reporting "no fields" when equipment was the missing thing,
and an enum with no synonyms in its description, which is the parameter the entire verdict turns
on.

**Suggestion.** Link it from the QuickStart and from the hackathon resources page. It reads as a
certification gate, so it is easy to file under "later", when it is really a build checklist.
Everything on it is cheaper to do on day one than to retrofit.

---

## 5. Minor: the NOAA SWPC alert feed is fixed-format text inside JSON

**Severity: informational. Not an Amazon issue, recorded because it shaped the design.**

`services.swpc.noaa.gov/products/alerts.json` returns JSON whose `message` field is a fixed-width
plain-text bulletin, so the message code and the human-readable sentence have to be pulled out with
a regex. It works and the feed is free with no key and no documented rate limit, which is why it is
used here, but any consumer has to write a small parser and re-check it whenever the bulletin
format shifts.

---

## 6. Account linking is not the generic MCP OAuth shape it looks like it should be

**Severity: high. Building against the wrong shape would have shipped a linking flow that fails
the first time a real Alexa+ customer tries it.**

**Task.** Implement OAuth 2.1 account linking for the MCP endpoint.

**Steps.** Read `mcp-toolkit-quickstart.html`, which documents PKCE and the S256 requirement in
detail, then implement the general MCP-ecosystem shape: Dynamic Client Registration (RFC 7591)
so any caller can self-register, plus a `WWW-Authenticate` challenge on 401 pointing at protected
resource metadata (RFC 9728). That is the shape every generic MCP OAuth library, and this project's
first pass, produces.

**Expected.** That shape working against Alexa+ once a tunnel and an add-on registration are in
place.

**Actual.** `category-sdk-mcp-account-linking.html`, a different page from the one QuickStart
sends a builder to, states plainly: *"Alexa+ add-ons support only the Authorization Code Grant.
The implicit grant isn't supported,"* and *"Dynamic Client Registration (DCR) isn't supported."*
The developer generates their own `client_id`, runs `alexa-ai configure-account-linking
--client-id <id>`, and the CLI hands back **Alexa's own set of redirect URIs**, one per region,
to register: *"use exactly the value Alexa passes, don't hardcode a single URI."* DCR issuing a
fresh `client_id` to anyone who calls `/oauth/register` is the opposite of that: it is built for
many different unknown clients, and Alexa+ is exactly one known client that registers out of band.

**Workaround.** Added static client pre-registration from environment variables
(`ORBITA_CLIENT_ID`, `ORBITA_REDIRECT_URIS`, comma-separated) at server boot, matching the CLI
flow above. DCR is kept as a fallback, useful for local testing and the KayLerch bridge, but the
client Alexa+ actually links against is never dynamically registered.

**Suggestion.** The QuickStart's account-linking section links to the PKCE requirements but not to
`category-sdk-mcp-account-linking.html`, so a builder following it in order builds the wrong OAuth
shape before ever reading the page that corrects it. Cross-link the two pages, or fold the
static-registration requirement into the QuickStart directly.

---

## 7. Minor: NOAA's scales feed carries a word and a number, and only the number is safe to read

**Severity: informational. Not an Amazon issue, recorded because it silently broke a feature.**

`services.swpc.noaa.gov/products/noaa-scales.json` gives each scale two fields: `Scale`, a digit
such as `"2"`, and `Text`, a word such as `"moderate"`. This project read `Text` and then looked
for codes like `"G2"`, so during any real storm every level scored zero and "what else is this
storm hitting" would have answered that nothing was affected. The tests passed throughout,
because they fed in `"G2"` rather than what NOAA actually sends. The feed also mixes kinds of
value by key: `"0"` is today's observed level, `"-1"` yesterday, and `"1"` to `"3"` are the
outlook, where R and S become day-ahead probabilities (`MinorProb`, `MajorProb`, `Prob`) instead
of levels. The server now stores the digit, keeps yesterday and the three day outlook, and the
level reader accepts digits, codes and NOAA's words alike.

---

## 8. "Detect and prevent duplicate transactions" is a requirement, and the protocol gives a stateless server nothing to detect them with

**Severity: medium. The requirement is right, and meeting it is left entirely to guesswork.**

**Task.** Meet the functional requirement *"Detect and prevent duplicate transactions"*, whose own
example is a customer who already has a booking being offered a modification rather than a second one.

**Expected.** Somewhere in the add-on documentation, a sentence saying whether Alexa+ retries a tool
call it believes failed, and if so, what arrives with the retry that a server can recognise.

**Actual.** Nothing in the MCP add-on pages, the QuickStart or the functional requirements says
whether the host retries, on what timeout, or how many times. The protocol does not close the gap
either: a JSON-RPC id is unique per connection, and a stateless Streamable HTTP server sees a new
connection for every call, so the id is no help. There is no idempotency key in `tools/call`. The
result is that a server cannot tell a retried request from a customer saying the same sentence
twice, and both have to be handled the same way whether that is right or not.

The newest specification, 2026-07-28, confirms this rather than fixing it. It states plainly that
"MCP has no protocol-level session, so a server cannot rely on implicit per-connection state to
relate one tool call to the next", its guidance on carrying state is explicitly non-normative, and
where it does define a retry, for multi round-trip input, it requires the opposite of what
deduplication needs: "the JSON-RPC `id` MUST be different between the initial request and the
retry".

This was not theoretical here. A probe sent the same job log twice, a millisecond apart, and the log came back with two entries. The same probe registered one field twice and the farm came back with two fields of the same name. Neither answer suggested anything was wrong.

**Workaround.** Treat identical writes inside a two minute window as one: a field or machine registered again updates the one already there, and the same job logged twice is logged once. A retry
arrives in seconds, and nobody does the same thing twice that fast. The second answer says what
happened, in the shape the requirement's own example uses.

**Suggestion.** One sentence in the add-on documentation about host retry behaviour, and, if
retries happen, a stable request identifier carried in `_meta` so a server can recognise one. Until
then, every add-on that writes anything is inventing the same window, and choosing it differently.

---

## 9. Nothing says which Accept header the host sends, and the reference transport refuses the wildcard

**Severity: medium for anyone testing by hand. It reads as a broken endpoint.**

**Task.** Confirm the MCP endpoint answers, the way anyone would: `curl` it.

**Expected.** A JSON-RPC answer, or an error that says what is wrong.

**Actual.** `406 Not Acceptable: Client must accept both application/json and text/event-stream`.
The Streamable HTTP specification does ask clients to send both types, and the reference TypeScript
SDK enforces it by string match, so `Accept: */*`, which is curl's default and is what several HTTP
clients send, is refused although it accepts both types by definition. A developer's first contact
with their own server is a 406 that looks like a fault in the server.

The Alexa+ documentation does not say what its host sends, so there is no way to know from the docs
whether this matters in production or only on the bench.

**Workaround.** A wildcard, or a missing Accept, is widened to the pair the transport wants before
the request reaches it; an Accept that names `application/json` and nothing else is still refused,
because that client genuinely cannot read the event stream we answer with. Tested both ways in
`test-web.mjs`.

**Suggestion.** State the headers the Alexa+ host sends, and the protocol versions it will
negotiate, on the MCP Toolkit page. One table would remove an entire class of guesswork. The
wildcard case belongs upstream in the SDK, but the documentation gap is Amazon's to close.

---

## 10. When arguments fail validation, the protocol's own error text is what the customer hears

**Severity: medium. It breaks two functional requirements at once, and the default is to do nothing.**

**Task.** Make sure a mis-heard word produces something a customer can act on, as
*"Provide actionable next step for every error"* and *"Surface no API codes, tool names, JSON, or
internal IDs in any customer-facing response"* both require.

**Expected.** That a schema mismatch produces an error the host turns into a question.

**Actual.** The tool result that comes back is, verbatim:
`MCP error -32602: Input validation error: Invalid arguments for tool can_i_run: Invalid enum value.
Expected 'planting' | 'tillage' | ..., received 'dancing'`. That string is the tool's output, so it
is what the host has to work from, and it contains an error code, a tool name and an internal enum.
Nothing in the documentation mentions this, and the default behaviour of the reference SDK breaks
both requirements without the developer doing anything wrong.

**Workaround.** The `tools/call` handler is wrapped, and a validation failure is rewritten into the
plainest true sentence: the choices we do have, at most five of them because the voice requirements
cap spoken options at five, with underscores removed and the rejected word never offered back as a
choice. `test-contract.mjs` calls every tool with arguments it never asked for and fails the build
if protocol text reaches the answer.

The specification is on the side of rewriting it. It sorts errors into protocol errors, for
"issues with the request structure itself that models are less likely to be able to fix", and tool
execution errors, which "contain actionable feedback that language models can use to self-correct",
and it lists "input validation errors (e.g., date in wrong format, value out of range)" under the
second kind. A schema mismatch arriving as a protocol error, with the code and the tool name in the
text, is the case the specification says should read as actionable feedback instead.

**Suggestion.** Say in the certification pages that a schema validation failure is customer-facing,
and recommend rewriting it. Better still, have the toolkit offer a hook for it, since every add-on
built on the reference SDK has this exact behaviour until someone notices.
