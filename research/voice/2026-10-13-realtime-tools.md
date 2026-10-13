# Voice on OpenAI Realtime over a local MCP server: research note

Date: 2026-10-13. All pages were fetched on that date. OpenAI doc pages carry no per-page date, so dates come from the OpenAI changelog (https://developers.openai.com/api/docs/changelog) unless a page shows one. Labels: **Confirmed** means the cited source states it. **Inference** is my reading. **Not found** means I searched and found nothing.

## 0. Context the question assumes away

**Confirmed.** OpenAI now has two speech-to-speech APIs:

- **Realtime API** (`v1/realtime`). Current models are `gpt-realtime-2` (changelog May 7, 2026) and `gpt-realtime-2.1` / `gpt-realtime-2.1-mini` (Jul 6, 2026, both "reasoning" models with 128k context). The Beta interface was removed on May 12, 2026. The older `gpt-realtime*` and `gpt-4o-realtime*` models shut down on Jan 20, 2027 (https://developers.openai.com/api/docs/deprecations).
- **GPT-Live** (`v1/live/sessions`, model `gpt-live-1`, GA on Sep 10, 2026). It is a full-duplex voice model that "delegate[s] reasoning and tool use to a backend agent". It costs $0.05/min, and backend usage is billed separately (https://developers.openai.com/api/docs/models/gpt-live-1).

OpenAI's comparison describes Realtime as "Speech, reasoning, and tool use in one session" and GPT-Live as "Full-duplex conversations with a separate backend" (https://developers.openai.com/api/docs/guides/voice-agents).

## 1. How Realtime calls tools

**Confirmed** from the Realtime client and server event references (https://developers.openai.com/api/reference/resources/realtime/client-events, https://developers.openai.com/api/reference/resources/realtime/server-events) and "Realtime with tools" (https://developers.openai.com/api/docs/guides/realtime-mcp):

- **Where tools are defined.** Tools go in `session.tools` via `session.update`, or in `response.tools` via `response.create` for a single turn.
- **Function tool shape.** A function tool is `{type:"function", name, description, parameters}`, where `parameters` is JSON Schema. Unlike Responses, there is **no `strict` field**. The reference says the description should include "guidance on when and how to call it, and guidance about what to tell the user when calling (if anything)".
- **Event flow.**
  1. The arguments stream as `response.function_call_arguments.delta`.
  2. Then comes `response.function_call_arguments.done`, with `name`, `call_id`, `item_id`, `arguments`, `response_id` and `output_index`. The reference adds: "Also emitted when a Response is interrupted, incomplete, or cancelled."
  3. The client runs the tool and sends `conversation.item.create` with `{type:"function_call_output", call_id, output:"<string>"}`.
  4. The client then sends `response.create`. The API does not create the follow-up response by itself.
- **Transports.** The same events run over the WebRTC data channel, a server WebSocket, or a sideband WebSocket attached to a WebRTC or SIP call (`wss://api.openai.com/v1/realtime?call_id=…`, https://developers.openai.com/api/docs/guides/realtime-sip). WebSocket is recommended for server-to-server use with a standard API key, and WebRTC for browsers and mobile with an ephemeral key minted by your server (https://developers.openai.com/api/docs/guides/realtime-websocket).
- **`tool_choice`.** The values are `none`, `auto`, `required`, `{type:"function", name}` or `{type:"mcp", server_label, name?}`.
- **Parallel calls.** On `parallel_tool_calls`, the reference says: "Whether the model may call multiple tools in parallel. Only supported by reasoning Realtime models such as `gpt-realtime-2`."
- **Speaking while a call runs:**
  - **Preambles.** "`gpt-realtime-2` generates preambles by default". Tool calls happen in the user-visible `commentary` channel (https://developers.openai.com/api/docs/guides/voice-prompting).
  - **Async function calling.** In OpenAI's GA developer notes (2025, no exact date on the page): "the Realtime API allows clients to continue a session while a function call is pending … the model sometimes hallucinates the content of a nonexistent function response". OpenAI adds placeholder responses ("I'm still waiting on that"), and these are "automatically enabled for new models" (https://developers.openai.com/blog/realtime-api).
  - **The SDK says the opposite.** The OpenAI Agents JS voice guide states: "While the tool is executing the agent will not be able to process new requests from the user". It offers `backgroundResult()` instead (https://openai.github.io/openai-agents-js/guides/voice-agents/build/).
  - **The `async: true` flag does not apply.** That tool flag (Sep 3, 2026) exists only in the Responses API, for GPT-6 Astra and later (https://developers.openai.com/api/docs/guides/async-tool-calling).
- **Reasoning effort.** `reasoning.effort` takes `minimal|low|medium|high|xhigh`. The prompting guide maps `minimal` to "Smart-home commands, timers, simple calendar checks" and recommends `low` as the default for most production agents.
- **Output cap.** `max_output_tokens` is 1–4096 or `inf`, and it includes tool calls.

**Inference.** A relay can start the tool on `function_call_arguments.done`, because that event carries the `name`. It does not need to wait for `response.done`. But the same event also fires for cancelled responses, so a write should check the response status, or accept that a barge-in may still switch the light.

## 2. Remote MCP (`type:"mcp"`) in Realtime

**Confirmed** (same reference and guide):

- **Fields.** `server_label`, then exactly one of `server_url`, `tunnel_id` or `connector_id`. Optional fields are `authorization` (an OAuth token), `headers` ("Use for authentication or other purposes"; you cannot send both this and `authorization`), `allowed_tools`, `require_approval`, `server_description`, `defer_loading` ("discovered via tool search") and `allowed_callers`.
  - `allowed_tools` takes a list of names or `{read_only, tool_names}`; `read_only` matches the MCP `readOnlyHint` annotation.
  - `require_approval` takes `always`, `never` or `{always:{…}, never:{…}}`.
  - `connector_id` is deprecated for models released after Sep 1, 2026.
- **Who calls the server.** "The Realtime API calls the remote MCP server." Your client only handles lifecycle events and approvals.
- **Event lifecycle:**
  - Listing: `mcp_list_tools.in_progress` → `.completed` or `.failed`.
  - Calls: `response.mcp_call_arguments.delta/.done`, then `mcp_approval_request` if approval is needed, then `response.mcp_call.in_progress`, then `response.output_item.done` (an `mcp_call` item) or `response.mcp_call.failed`.
  - "`response.done` can arrive before MCP calls finish". After that, the client must send `response.create` itself. The Agents JS SDK does this automatically (`automaticallyTriggerResponseForMcpToolCalls`, default true).
- **Listing and caching:**
  - Tools are imported when the tool is configured.
  - A turn that starts before `mcp_list_tools.completed` sees only the tools loaded so far.
  - A definition is reused by `server_label` within the session, but "A new session needs the full definition again so the server can import its tools."
  - The Responses guide adds that the API won't refetch the tool list while the `mcp_list_tools` item stays in context.
- **Transports.** The Realtime pages do not say which MCP transports are supported. The Responses MCP guide, which the Realtime reference links to, says it "works with remote MCP servers that support either the Streamable HTTP or the HTTP/SSE transport protocols" (https://developers.openai.com/api/docs/guides/tools-connectors-mcp).
- **Reachability:**
  - "Remote MCP servers can be any server on the public Internet". Private servers go through **Secure MCP Tunnel**: a customer-run `tunnel-client` makes outbound HTTPS to `api.openai.com:443` and needs no inbound port.
  - The tunnel was released on May 19, 2026 "for enterprise customers". Its guide names ChatGPT, Codex, the Responses API and AgentKit, not Realtime, and it needs organization roles with Tunnels permissions (https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
  - The Realtime reference does list a `tunnel_id` field.
- **Approval default.** In Responses, MCP calls require approval by default, and skipping approval is described as reducing latency.
- **Security guidance.** The server "can see any data the model sends in a tool call". OpenAI says to keep `allowed_tools` narrow and to require approval for actions you wouldn't auto-run.

**Not found:**
- any documented or measured latency overhead of Realtime MCP calls;
- which MCP protocol version OpenAI's MCP client speaks (for example, whether it supports the 2026-07-28 spec);
- whether `tunnel_id` works in Realtime for a non-enterprise account.

**Community report.** A thread from Nov 30, 2025 describes a FastMCP SSE server that listed 10 tools elsewhere but returned "0 tools" in Realtime. It has no resolution (https://community.openai.com/t/realtime-api-mcp-server-sends-10-tools-but-api-receives-0/1367933).

**Inference.** Hosted MCP saves no round trip for a home server:
- every call is an OpenAI→home HTTPS request through a public endpoint or the tunnel;
- the client still has to send `response.create` afterwards;
- every new voice session triggers a `tools/list` against the home server.

## 3. Limits that shape tool design

**Confirmed:**
- **Realtime reference.** It gives no maximum tool count and no length limit for descriptions or instructions (Not found). Tool definitions count toward instruction tokens: `token_limits.post_instructions` is described as "tokens allowed in the conversation after instructions (which including tool definitions)".
- **Model sizes.** The 2.1 and 2.1-mini models have 128k context and 32k max output.
- **No strict mode in Realtime.** Strict mode in Responses relies on the Structured Outputs subset: `additionalProperties:false` and every field `required`. Realtime has no such mode, and its reference describes no JSON-Schema subset (Not found).
- **General function-calling guide** (https://developers.openai.com/api/docs/guides/function-calling):
  - "Aim for fewer than 20 functions available at the start of a turn … just a soft suggestion".
  - Definitions are billed as input tokens.
  - Tool search (`tool_search`, needs gpt-5.4 or later) is a Responses feature. Realtime has `defer_loading` only on MCP tools.
- **128-tool cap.** Third parties report a 128-entry cap on the `tools` array (`array_above_max_length`, e.g. https://docs.katalon.com/katalon-studio/troubleshooting/troubleshoot-studioassist-issues/invalid-tools-array-too-long). I did not find it in current OpenAI docs.
- **Realtime prompting guide:**
  - Expose only the tools relevant to the current phase.
  - "Use only the tools explicitly provided in the current tool list".
  - Use "Use when / Do NOT use when" lines.
  - Start with a minimal prompt, because gpt-realtime-2 follows instructions more literally.
- **Other ecosystems:**
  - MCP spec: tool names SHOULD be 1–128 characters from `[A-Za-z0-9_.-]` (https://modelcontextprotocol.io/specification/2026-07-28/server/tools).
  - Gemini: function names are at most 128 characters, and the docs say "Keep active set to 10-20 tools maximum" (https://ai.google.dev/gemini-api/docs/function-calling).

**Inference.** The model does not guarantee arguments match the schema. The server must validate, and should return a short, speakable error that the model can repair.

## 4. Relay at home or MCP through a tunnel

**What OpenAI says (Confirmed):**
- Function tools are for when "your application owns the business logic, approval checks, or private system access". MCP tools are for when "the Realtime API should connect to a remote tool server for you" (realtime-mcp guide).
- "you'll most likely want tool use and other business logic to reside on your application server to keep this logic private and client-agnostic", via a sideband (developer notes).
- The GPT-Live guides say to keep API keys and tool credentials on your server. They also note that prompt instructions "do not enforce those checks"; the application must enforce them (https://developers.openai.com/api/docs/guides/live-migration).
- GPT-Live's Responses delegation supports only `function` and `web_search` tools, with no MCP. Client delegation lets your application run any backend (https://developers.openai.com/api/docs/guides/live-delegation).

**Comparison (Inference, except where marked):**

| | Local relay + function tools | `type:"mcp"` via public HTTPS | `type:"mcp"` via Secure MCP Tunnel |
| --- | --- | --- | --- |
| Inbound exposure | none (outbound WebSocket only) | internet endpoint that controls real devices | none (outbound tunnel) |
| Who holds secrets | OpenAI key + hub credentials stay at home | the MCP token sits in OpenAI session config; a leaked URL+token = house control | the tunnel key stays at home |
| Hops per tool call | events already flow on the session socket; the tool runs on the LAN (stdio or localhost) | extra OpenAI→home HTTPS hop + `tools/list` every session + client `response.create` | same as public, plus the tunnel queue |
| Policy enforcement | in relay/server code (voice subset, confirmations for locks or alarms) | only through `allowed_tools` / `require_approval` plus server auth | same |
| Availability | any account | any account | "enterprise customers" (Confirmed); Realtime not listed in the guide (Confirmed) |
| Portability | the same relay pattern fits Gemini, Pipecat, LiveKit, GPT-Live client delegation | OpenAI-specific config | OpenAI-specific |

OpenAI sees tool arguments and results in every option, because they enter the conversation either way.

## 5. Platform neutrality

**Confirmed.** An MCP `tools/list` entry is `{name, description, inputSchema, annotations}`. Here is how each platform consumes tools:

- **OpenAI Realtime:** `{type:"function", name, description, parameters: inputSchema}`. The result is a string in `function_call_output.output`.
- **OpenAI GPT-Live:** Responses delegation takes `function` tools in `delegation.responses.tools`, and the app executes them and returns results with `response.item.create`. Client delegation calls any backend, and results go back via `session.commentary.append` / `session.thinking.append`, each limited to 500 tokens. GPT-Live "can continue speaking while the backend works".
- **Gemini Live** (`gemini-3.8-live` is stable; pages updated 2026-09-15 and 2026-10-09):
  - Format: `functionDeclarations: {name, description, parameters (OpenAPI 3.0 subset) | parametersJsonSchema (JSON Schema, "mutually exclusive with parameters"), behavior}`.
  - "Async execution (`behavior: NON_BLOCKING`) is now the default" in 3.8 Live, with response `scheduling: INTERRUPT | WHEN_IDLE | SILENT`.
  - Tool responses are sent manually; "the Live API doesn't support automatic tool response handling".
  - The Live pages do not mention MCP (Not found). Gemini's Interactions API has a remote `mcp_server` tool that accepts Streamable HTTP only, not SSE.
  - Sources: https://ai.google.dev/gemini-api/docs/live-tools, https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live, https://ai.google.dev/api/generate-content
- **Pipecat:** `MCPClient` supports stdio, SSE and Streamable HTTP. It converts MCP tools into `ToolsSchema` and registers them on an LLM service, with `tools_filter` to narrow them. For Gemini Live, tools must be given at construction time (`get_tools_schema()`) (https://docs.pipecat.ai/api-reference/server/utilities/mcp/mcp).
- **LiveKit Agents:** MCP support is **Python only** (Node.js unchecked), installed as `livekit-agents[mcp]~=1.8`. You use `mcp.MCPToolset` wrapping `MCPServerHTTP` (streamable_http or SSE) or `MCPServerStdio`, filtered with `allowed_tools`. The `mcp_servers=` parameter is deprecated (https://docs.livekit.io/agents/logic/tools/mcp).
- **OpenAI Agents JS `RealtimeAgent`:** supports local function tools plus hosted MCP tools that the Realtime API executes. Local stdio MCP servers are not described for realtime (guide linked in section 1).

**Inference.** Name and description map 1:1 everywhere. For schemas, pass `inputSchema` as-is to OpenAI and as `parametersJsonSchema` to Gemini; this avoids the OpenAPI subset. Flat objects with string, enum and number fields map cleanly on all three. A small relay that is an MCP client covers OpenAI Realtime, GPT-Live client delegation and Gemini Live. Pipecat (all languages) and LiveKit (Python) can consume the MCP server directly.

## 6. `@modelcontextprotocol/sdk`: stdio and Streamable HTTP together

**Confirmed:**
- **Version in the repo.** `/Users/dmitry/Dev/sprut-agent/package.json` pins `"@modelcontextprotocol/sdk": "1.30.0"` (released 2026-07-27). The installed copy is 1.30.0, with `LATEST_PROTOCOL_VERSION = '2025-11-25'`.
- **Newer versions.** The latest v1 on npm is 1.32.1 (2026-10-05). The Streamable HTTP transport first shipped in 1.10.0 (2025-04-17) (https://github.com/modelcontextprotocol/typescript-sdk/releases).
- **v2.** v2 split into `@modelcontextprotocol/server` 2.3.1, `/node` and `/express`; v2.0.0 shipped on 2026-07-27. It implements spec 2026-07-28: stateless, no `initialize`, no `Mcp-Session-Id`, and HTTP+SSE deprecated (https://modelcontextprotocol.io/specification/2026-07-28/changelog). v1.x gets bug and security fixes for "at least six months after the v2 release (2026-07-27)" (https://github.com/modelcontextprotocol/typescript-sdk).
- **One transport per server instance.** `Protocol.connect` throws "Already connected to a transport … use a separate Protocol instance per connection". `src/server.mjs` builds one module-level `McpServer` and connects `StdioServerTransport` at line 1154. Serving both transports therefore needs a `createServer()` factory: one instance for stdio, plus one per HTTP request (stateless) or per session.
- **Minimal stateless HTTP setup (v1)**, from the SDK example `src/examples/server/simpleStatelessStreamableHttp.ts` on the v1.x branch:
  1. `createMcpExpressApp()` binds 127.0.0.1 and turns on DNS-rebinding protection automatically.
  2. `app.post('/mcp')` creates a new server and a `new StreamableHTTPServerTransport({sessionIdGenerator: undefined})`, calls `server.connect(transport)` and `transport.handleRequest(req, res, req.body)`, and closes both on `res` close.
  3. GET and DELETE return 405.
  - Transport options include `enableJsonResponse`, `allowedHosts` / `allowedOrigins` (the built-in `enableDnsRebindingProtection` is deprecated in favour of middleware) and `eventStore`.
- **Auth helpers in 1.30.0:**
  - `requireBearerAuth({verifier, requiredScopes, resourceMetadataUrl})` puts `AuthInfo` on `req.auth`;
  - an OAuth router and providers;
  - `hostHeaderValidation()` / `localhostHostValidation()`.
  - (https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md)
- **Dependencies.** sdk 1.30.0 already depends on `express` ^5.2.1, `hono` and `cors`.

**Inference.** `StreamableHTTPServerTransport.handleRequest` takes Node's `IncomingMessage` and `ServerResponse`, so a `node:http` server with a body parser works without adding Express as a direct dependency. Stateless mode matches where the 2026-07-28 spec is going.

## What this means for sprut-agent

- **Use a home-local relay with plain function tools, not a hosted `type:"mcp"` tool.** OpenAI frames function tools as the choice for "private system access". Hosted MCP needs a public HTTPS endpoint that controls the house, or a tunnel that is enterprise-only and not documented for Realtime. It adds an OpenAI→home hop per call and a `tools/list` per session, and its latency is undocumented. The relay holds the Realtime WebSocket (or a sideband to a WebRTC/SIP call) and reaches sprut-agent over stdio.
- **Keep the server plain MCP, with nothing OpenAI-specific.** This matches the 13.10.2026 PLAN decision. The relay is a thin MCP client that maps `tools/list` to each platform's function format: 1:1 for OpenAI, `parametersJsonSchema` for Gemini. Pipecat and LiveKit (Python) can consume the server directly.
- **Shape the voice subset for a fast model.** Use one to three tools with flat schemas, and descriptions with "use when / don't use when" plus what to say. The server must validate arguments, because Realtime has no strict mode, and should answer with a short speakable result and stable refs. Run at `reasoning.effort: minimal`, which OpenAI documents for smart-home commands.
- **The hub dominates the latency budget, not the MCP transport.** The 2026-10-13 baseline measured about 485 ms per device, done one after another, so 20 lamps take roughly 3.4–7 s. The in-memory snapshot and parallel commands (PLAN step 2) decide whether a phrase finishes in well under a second. Start the tool on `function_call_arguments.done` and send the output and `response.create` immediately.
- **Streamable HTTP isn't needed for the OpenAI relay.** Keep PLAN step 4 conditional. If it is added: a per-connection server factory (the current single `McpServer` cannot serve two transports), stateless mode, bound to 127.0.0.1 with host validation, bearer auth if it ever leaves loopback, and staying on v1.x (1.30.0 or newer 1.32.x). The v2 migration is a separate decision.
- **Measure GPT-Live (Sep 10, 2026) against Realtime before committing.** GPT-Live is full duplex and keeps talking while tools run, but it adds a backend-model hop. Its managed delegation accepts only function and web_search tools, so sprut-agent would be reached through client delegation, which is the same relay pattern. Realtime's async function calling also lets the model talk while a call is pending; the relay must confirm success only after the tool returns.
