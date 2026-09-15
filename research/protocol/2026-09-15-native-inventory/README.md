# S-SPRUT-89: public native protocol inventory

Observed on 2026-09-15. Static evidence (`S`), not a live hub experiment.

The entity map, interpretation, MCP gaps and next-step decision are in
[Plan Docs188](https://plan.nuanu.ai/project/SPRUT/docs/188), linked to
[SPRUT-89](https://plan.nuanu.ai/project/SPRUT/issue/89). This directory preserves
the public source evidence; it is not an active implementation specification.

## Source and procedure

1. Read the public HTML at `https://beta.spruthub.ru/` and fetched its three
   referenced JavaScript assets without authentication. `manifest.json` pins
   their URLs, byte lengths and SHA256 hashes. The app hash also appears in the
   2026-09-09 observations; its presence does not establish a new release today.
2. The existing `research/extract-spruthub.mjs` stopped at `extractBuildInfo` with
   `Unable to locate Sprut.hub web-client build information`. No version was
   inferred from dependency versions or asset names. Runtime and extractor code
   were not changed to finish this inventory.
3. Reused `extractProtoModules` on the downloaded app. Preserved all 31 returned
   module bodies verbatim under `proto/<moduleId>-<reportedFilename>`, verifying
   every body against its recorded SHA256. No bundle of the web application,
   credentials, home data or authenticated traffic is included.
4. Inspected `EndpointRequest` in `API.proto`, then the request message for each
   declared root. Cross-checked the existing `parseDomainContracts` results by
   endpoint, request type and field number. `operations.json` retains only these
   rooted operations, their source module and explicit deprecation flags.
5. Compared the declarations with the public MCP entry points and their
   implementation at commit `52bf784bc6bbf8dcdb3d3ae876e3237abd4dc183`.
   Wiki references and the interpretation are in Docs188.

## Findings and limits

- There are 28 declared root domains and 206 declared operations in this source,
  including 26 with a deprecated root or operation. These are not supported RPC
  counts, live coverage metrics or a requirement to implement every declaration.
- Modules `69921` and `37730` both report `ExtensionChild.proto`. The former
  defines ExtensionChild messages; the latter defines Window messages. Both
  bodies are preserved. Neither filename collision nor type-name inference
  justifies dropping a module or silently rewriting the upstream source.
- `DashboardWidgetCreateRequest` and `DashboardWidgetUpdateRequest` contain eight
  payload variants each. They are not two additional transport domains. The
  existing parser's 30-domain/222-operation result includes these false entries.
- `bundle` is deprecated at the root. Its source comments explicitly state that
  the server API was removed and the application store moved to plugin windows.
  Keeping an old protobuf declaration is not compatibility evidence.
- The existing parser's heuristic risk labels were not copied. A method name
  does not prove read-only behavior, authorization or repeatability.
- Missing build metadata, schema-name collisions and false root operations are
  tracked together in [SPRUT-90](https://plan.nuanu.ai/project/SPRUT/issue/90).
  They did not require a product change to preserve this evidence.

Firmware version, runtime effects, error semantics, event retention and support
for individual windows/actions were not measured in this pass. No live hub
connection or home write was performed; nothing in the house needs restoration.

The original modules include obsolete fields and comments. Treat them as dated
observations rather than instructions to an agent or the source of current
product guarantees. Machine-readable field details belong to these artifacts;
design decisions remain in Plan.
