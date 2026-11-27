// Native SprutHub 3.0 catalog template write operations (0 new MCP tools):
// catalog_template_create, catalog_template_update, catalog_template_delete.
// Protocol verified live on SprutHub 3.0.0 rev 20131 (2026-11-27):
// - catalog.create writes INTERNAL /N.json; invalid templates do NOT throw a
//   JSON-RPC error — SprutHub creates an active=false file with error text.
// - catalog.update modifies INTERNAL /N.json in place; invalid templates set
//   active=false with error text.
// - catalog.delete removes an INTERNAL template and returns {}.
import { createHash } from "node:crypto";
import {
  catalogRef,
  configuredHomeRef,
  isRecord,
  isUncertainWriteError,
  isValidCatalogFile,
  parseCatalogRef,
  parseConfiguredHomeRef,
  refuseRedactionMark,
  stableJson,
} from "./change-refs.mjs";
import {
  failedVerification,
  freshVerification,
  nativeIntentDirection,
} from "./native-values.mjs";
import {
  isSensitiveNativeNode,
  redactSensitiveText,
  SprutHubError,
  sanitizeNativeData,
} from "./spruthub-client.mjs";

export const CATALOG_TEMPLATE_CREATE = "catalog_template_create";
export const CATALOG_TEMPLATE_UPDATE = "catalog_template_update";
export const CATALOG_TEMPLATE_DELETE = "catalog_template_delete";

export const CATALOG_OPERATIONS = [
  CATALOG_TEMPLATE_CREATE,
  CATALOG_TEMPLATE_UPDATE,
  CATALOG_TEMPLATE_DELETE,
];

const CATALOG_OPERATION_SET = new Set(CATALOG_OPERATIONS);
export const MAX_CATALOG_TEMPLATE_BYTES = 262_144;

const COMMON_UNEXPECTED_FIELDS = [
  "option_key",
  "name",
  "room_ref",
  "member_service_refs",
  "characteristic_types",
  "description",
  "active",
  "on_start",
  "sync",
  "data",
  "action_pointer",
  "duration_seconds",
  "column_names",
  "widget",
  "column_ref",
  "position",
];

export function isCatalogChangeKind(kind) {
  return CATALOG_OPERATION_SET.has(kind);
}

function isPendingRestoreIntent(change) {
  return (
    ["restoring", "uncertain"].includes(change?.status) &&
    nativeIntentDirection(change) === "restore"
  );
}

export function catalogHubStepsSent(change, direction) {
  if (!isCatalogChangeKind(change?.kind)) return false;
  if (direction === "apply" && change.status === "applied") return false;
  const createdBy =
    direction === "apply" ? change.created_file : change.restored_file;
  return (
    createdBy !== undefined ||
    (["applying", "restoring", "uncertain"].includes(change.status) &&
      nativeIntentDirection(change) === direction)
  );
}

// Compact contracts (well under 4096 B) so prepare_native_change can inline
// them on caller field errors.
export function catalogContract(operation) {
  switch (operation) {
    case CATALOG_TEMPLATE_CREATE:
      return {
        write: "catalog.create({controller,template})",
        fields: {
          target_ref: "home_ref",
          value:
            'controller name from catalog.types (e.g. "zigbee", "xiaomi", "sonoff")',
          source:
            'complete JSON object template string (<= 262144 bytes); any base paths in "template" must start with "/" and exist in INTERNAL or MAIN',
          reason: "required",
        },
        store:
          "INTERNAL (SprutHub always creates custom templates in INTERNAL with auto-assigned /N.json file)",
        hub_validation:
          "if SprutHub returns active=false or error, apply cleans up the created file and marks the change rejected instead of leaving a broken template on the hub",
        restore:
          "deletes the created INTERNAL template while its live content matches the applied snapshot",
        restore_supported: true,
      };
    case CATALOG_TEMPLATE_UPDATE:
      return {
        write: 'catalog.update({store:"INTERNAL",controller,file,template})',
        fields: {
          target_ref:
            "INTERNAL catalog template ref (MAIN and read-only templates are refused)",
          source:
            "complete replacement JSON object template string (<= 262144 bytes)",
          reason: "required",
        },
        hub_validation:
          "if SprutHub returns active=false or error, apply rolls back to the saved baseline template and verifies readback",
        restore:
          "writes back the saved baseline template while live content matches the applied snapshot",
        restore_supported: true,
      };
    case CATALOG_TEMPLATE_DELETE:
      return {
        write: 'catalog.delete({store:"INTERNAL",controller,file})',
        fields: {
          target_ref:
            "INTERNAL catalog template ref (MAIN and read-only templates are refused)",
          reason: "required",
        },
        confirmation:
          "if linked devices or accessories are present (device_count > 0), prepare returns tell_owner with no next call until owner confirms",
        restore:
          "recreates the template in INTERNAL via catalog.create under a new /N.json file (reported in restored_catalog_ref)",
        restore_supported: true,
      };
    default:
      return null;
  }
}

// ---- Snapshots, comparison & validation ------------------------------------

function templateFingerprint(text) {
  return createHash("sha256")
    .update(typeof text === "string" ? text : "")
    .digest("hex");
}

function normalizedTemplateJson(text) {
  if (typeof text !== "string") return null;
  try {
    return stableJson(JSON.parse(text));
  } catch {
    return null;
  }
}

function sameCatalogTemplate(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left === right) return true;
  const leftNorm = normalizedTemplateJson(left);
  const rightNorm = normalizedTemplateJson(right);
  return leftNorm !== null && rightNorm !== null && leftNorm === rightNorm;
}

function catalogSnapshot(entry) {
  const template = typeof entry.template === "string" ? entry.template : "";
  return {
    store: entry.store,
    controller: entry.controller,
    file: entry.file,
    active: entry.active === true,
    write: entry.write === true,
    ...(typeof entry.manufacturer === "string"
      ? { manufacturer: entry.manufacturer }
      : {}),
    ...(typeof entry.model === "string" ? { model: entry.model } : {}),
    manufacturer_ids: Array.isArray(entry.manufacturerIds)
      ? entry.manufacturerIds.filter((item) => typeof item === "string")
      : [],
    model_ids: Array.isArray(entry.modelIds)
      ? entry.modelIds.filter((item) => typeof item === "string")
      : [],
    ...(typeof entry.error === "string" && entry.error.trim().length > 0
      ? { error: redactSensitiveText(entry.error) }
      : {}),
    template,
    sha256: templateFingerprint(template),
  };
}

function extractTemplateMetadata(parsed) {
  return {
    manufacturer:
      typeof parsed.manufacturer === "string" ? parsed.manufacturer : null,
    model: typeof parsed.model === "string" ? parsed.model : null,
    manufacturer_ids: Array.isArray(parsed.manufacturerIds)
      ? parsed.manufacturerIds.filter((item) => typeof item === "string")
      : [],
    model_ids: Array.isArray(parsed.modelIds)
      ? parsed.modelIds.filter((item) => typeof item === "string")
      : [],
  };
}

function hubTemplateError(entry) {
  if (typeof entry?.error === "string" && entry.error.trim().length > 0) {
    return redactSensitiveText(entry.error.trim());
  }
  if (entry?.active === false) {
    return "SprutHub marked the catalog template inactive (active=false).";
  }
  return null;
}

const METADATA_PROPERTY_KEYS = new Set([
  "key",
  "name",
  "label",
  "type",
  "id",
  "title",
  "description",
]);

function containsSecretInTemplate(node, key = "") {
  if (typeof node === "string") {
    if (
      key.length > 0 &&
      !METADATA_PROPERTY_KEYS.has(key) &&
      node.trim().length > 0 &&
      isSensitiveNativeNode({ [key]: node })
    ) {
      return true;
    }
    return sanitizeNativeData(node) !== node;
  }
  if (Array.isArray(node)) {
    return node.some((item) => containsSecretInTemplate(item));
  }
  if (isRecord(node)) {
    return Object.entries(node).some(([childKey, childValue]) =>
      containsSecretInTemplate(childValue, childKey),
    );
  }
  return false;
}

function extractAndValidateReferencedPaths(parsed) {
  if (parsed.template === undefined) return [];
  let candidates;
  if (typeof parsed.template === "string") {
    candidates = [parsed.template];
  } else if (
    Array.isArray(parsed.template) &&
    parsed.template.every((entry) => typeof entry === "string")
  ) {
    candidates = parsed.template;
  } else {
    throw new SprutHubError(
      "invalid_native_value",
      'Catalog template "template" property must be a path string or an array of path strings starting with "/".',
      "prepare_native_change",
    );
  }
  const seen = new Set();
  const paths = [];
  for (const rawPath of candidates) {
    if (!isValidCatalogFile(rawPath)) {
      throw new SprutHubError(
        "invalid_native_value",
        `Referenced base template path "${redactSensitiveText(rawPath)}" must start with "/" and contain no ".." segments or control characters.`,
        "prepare_native_change",
      );
    }
    if (!seen.has(rawPath)) {
      seen.add(rawPath);
      paths.push(rawPath);
    }
  }
  return paths;
}

function validateCatalogTemplateSource(source) {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new SprutHubError(
      "invalid_native_value",
      "source must be a non-empty JSON catalog template string.",
      "prepare_native_change",
    );
  }
  refuseRedactionMark(source, "source");
  if (Buffer.byteLength(source, "utf8") > MAX_CATALOG_TEMPLATE_BYTES) {
    throw new SprutHubError(
      "invalid_native_value",
      `Catalog template source must be at most ${MAX_CATALOG_TEMPLATE_BYTES} bytes.`,
      "prepare_native_change",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new SprutHubError(
      "invalid_native_value",
      `Catalog template source is not valid JSON: ${error.message}`,
      "prepare_native_change",
    );
  }
  if (!isRecord(parsed)) {
    throw new SprutHubError(
      "invalid_native_value",
      "Catalog template source must be a JSON object (not null, array, or primitive).",
      "prepare_native_change",
    );
  }
  if (containsSecretInTemplate(parsed)) {
    throw new SprutHubError(
      "invalid_native_value",
      "Catalog template source must not contain credentials, tokens, or secret-shaped text.",
      "prepare_native_change",
    );
  }
  const referencedPaths = extractAndValidateReferencedPaths(parsed);
  return {
    source,
    parsed,
    referencedPaths,
    metadata: extractTemplateMetadata(parsed),
  };
}

async function verifyReferencedTemplatesExist(
  client,
  controller,
  referencedPaths,
  serial,
) {
  for (const file of referencedPaths) {
    const internal = await client.getCatalogTemplate({
      store: "INTERNAL",
      controller,
      file,
    });
    if (internal !== null) continue;
    const main = await client.getCatalogTemplate({
      store: "MAIN",
      controller,
      file,
    });
    if (main !== null) continue;
    throw new SprutHubError(
      "referenced_template_not_found",
      `Referenced base template "${file}" was not found in INTERNAL or MAIN for controller "${controller}". Inspect available templates with home_overview (list="catalog", type="${controller}").`,
      "home_overview",
      {
        missing_template: file,
        controller,
        next: {
          tool: "home_overview",
          arguments: {
            home_ref: configuredHomeRef(serial),
            list: "catalog",
            type: controller,
          },
        },
      },
    );
  }
}

function forbidUnexpectedFields(input, fields, operation) {
  for (const field of fields) {
    if (input[field] !== undefined) {
      throw new SprutHubError(
        "invalid_native_change",
        `${field} is not accepted by ${operation}.`,
        "prepare_native_change",
      );
    }
  }
}

function catalogTemplateReadOnlyError(store, operation) {
  return new SprutHubError(
    "catalog_template_read_only",
    store !== "INTERNAL"
      ? `Catalog template in store "${store}" is read-only and cannot be modified by ${operation}. Only INTERNAL templates are writable; create an INTERNAL override with catalog_template_create instead.`
      : `The selected INTERNAL catalog template is read-only on SprutHub (write=false) and cannot be modified by ${operation}.`,
    store !== "INTERNAL" ? "get_native_change_contract" : "get_entity",
    store !== "INTERNAL"
      ? {
          store,
          next: {
            tool: "get_native_change_contract",
            arguments: { operation: CATALOG_TEMPLATE_CREATE },
          },
        }
      : {},
  );
}

function catalogTemplateNotFoundError() {
  return new SprutHubError(
    "entity_not_found",
    "The selected SprutHub catalog template was not found.",
    "home_overview",
    { next: { tool: "home_overview", arguments: { list: "catalog" } } },
  );
}

function hasLinkedDevices(entry) {
  return (
    (typeof entry.deviceCount === "number" && entry.deviceCount > 0) ||
    (Array.isArray(entry.devices) && entry.devices.length > 0) ||
    (Array.isArray(entry.accessories) && entry.accessories.length > 0)
  );
}

function linkedDeviceCount(entry) {
  return Math.max(
    typeof entry.deviceCount === "number" ? entry.deviceCount : 0,
    Array.isArray(entry.devices) ? entry.devices.length : 0,
  );
}

function findOverlappingInternalTemplates(serial, existingInternal, metadata) {
  if (
    metadata.manufacturer_ids.length === 0 ||
    metadata.model_ids.length === 0
  ) {
    return [];
  }
  const mfgSet = new Set(metadata.manufacturer_ids);
  const modelSet = new Set(metadata.model_ids);
  return existingInternal
    .filter((item) => {
      const mfgMatch = (item.manufacturerIds ?? []).some((id) =>
        mfgSet.has(id),
      );
      const modelMatch = (item.modelIds ?? []).some((id) => modelSet.has(id));
      return mfgMatch && modelMatch;
    })
    .map((item) => ({
      ref: catalogRef(serial, item.store, item.controller, item.file),
      file: item.file,
      active: item.active === true,
      ...(typeof item.model === "string"
        ? { model: redactSensitiveText(item.model) }
        : {}),
    }));
}

// ---- Prepare ---------------------------------------------------------------

export async function prepareCatalogChange(ctx, input) {
  switch (input.operation) {
    case CATALOG_TEMPLATE_CREATE:
      return prepareCatalogTemplateCreate(ctx, input);
    case CATALOG_TEMPLATE_UPDATE:
      return prepareCatalogTemplateUpdate(ctx, input);
    case CATALOG_TEMPLATE_DELETE:
      return prepareCatalogTemplateDelete(ctx, input);
    default:
      throw new SprutHubError(
        "unsupported_native_operation",
        "This native operation is not supported.",
      );
  }
}

async function prepareCatalogTemplateCreate(ctx, input) {
  parseConfiguredHomeRef(input.target_ref, ctx.hubSerial);
  forbidUnexpectedFields(
    input,
    COMMON_UNEXPECTED_FIELDS,
    CATALOG_TEMPLATE_CREATE,
  );
  if (typeof input.value !== "string" || input.value.trim().length === 0) {
    throw new SprutHubError(
      "invalid_native_value",
      "value must be a controller name from catalog.types for catalog_template_create.",
      "prepare_native_change",
    );
  }
  const { controllers } = await ctx.client.catalogTypes();
  const requestedCtrl = input.value.trim();
  const controller =
    controllers.find((entry) => entry === requestedCtrl) ??
    controllers.find(
      (entry) =>
        entry.toLocaleLowerCase("en") === requestedCtrl.toLocaleLowerCase("en"),
    );
  if (!controller) {
    throw new SprutHubError(
      "invalid_native_value",
      `Unknown catalog controller "${requestedCtrl}". Supported controllers: ${controllers.join(", ")}.`,
      "prepare_native_change",
      { supported_controllers: controllers },
    );
  }
  const validated = validateCatalogTemplateSource(input.source);
  await verifyReferencedTemplatesExist(
    ctx.client,
    controller,
    validated.referencedPaths,
    ctx.hubSerial,
  );
  const existingInternal = await ctx.client.listCatalogTemplates({
    filter: { stores: ["INTERNAL"], controllers: [controller] },
  });
  const overlapping = findOverlappingInternalTemplates(
    ctx.hubSerial,
    existingInternal,
    validated.metadata,
  );
  const now = new Date().toISOString();
  const change = {
    id: ctx.store.newId(),
    kind: CATALOG_TEMPLATE_CREATE,
    status: "prepared",
    home_ref: configuredHomeRef(ctx.hubSerial),
    reason: input.reason,
    target_ref: input.target_ref,
    controller,
    requested_template: validated.source,
    requested_sha256: templateFingerprint(validated.source),
    requested_metadata: validated.metadata,
    referenced_templates: validated.referencedPaths,
    baseline_files: existingInternal.map(({ file }) => file),
    ...(overlapping.length > 0
      ? {
          overlapping_templates: overlapping,
          warning: `Another INTERNAL ${controller} template already overlaps manufacturerIds and modelIds (${overlapping.map(({ ref }) => ref).join(", ")}). Consider updating the existing template instead of creating a duplicate.`,
        }
      : {}),
    creation_owned: false,
    native_write_sent: false,
    native_acknowledged: false,
    last_verification: freshVerification("catalog_template_validated"),
    created_at: now,
    updated_at: now,
    history: [{ status: "prepared", at: now }],
  };
  await ctx.store.save(change);
  return publicCatalogChange(change);
}

async function prepareCatalogTemplateUpdate(ctx, input) {
  const target = parseCatalogRef(input.target_ref, ctx.hubSerial);
  forbidUnexpectedFields(
    input,
    [...COMMON_UNEXPECTED_FIELDS, "value"],
    CATALOG_TEMPLATE_UPDATE,
  );
  if (target.store !== "INTERNAL") {
    throw catalogTemplateReadOnlyError(target.store, CATALOG_TEMPLATE_UPDATE);
  }
  const validated = validateCatalogTemplateSource(input.source);
  const live = await ctx.client.getCatalogTemplate(target);
  if (live === null) throw catalogTemplateNotFoundError();
  if (live.store !== "INTERNAL" || live.write === false) {
    throw catalogTemplateReadOnlyError(live.store, CATALOG_TEMPLATE_UPDATE);
  }
  await verifyReferencedTemplatesExist(
    ctx.client,
    target.controller,
    validated.referencedPaths,
    ctx.hubSerial,
  );
  if (
    typeof live.template === "string" &&
    sameCatalogTemplate(validated.source, live.template)
  ) {
    return {
      status: "already_desired",
      operation: CATALOG_TEMPLATE_UPDATE,
      target_ref: input.target_ref,
      native_write_sent: false,
      verification: freshVerification("catalog_template_already_desired"),
    };
  }
  const now = new Date().toISOString();
  const change = {
    id: ctx.store.newId(),
    kind: CATALOG_TEMPLATE_UPDATE,
    status: "prepared",
    home_ref: configuredHomeRef(ctx.hubSerial),
    reason: input.reason,
    target_ref: input.target_ref,
    target,
    controller: target.controller,
    baseline_snapshot: catalogSnapshot(live),
    requested_template: validated.source,
    requested_sha256: templateFingerprint(validated.source),
    requested_metadata: validated.metadata,
    referenced_templates: validated.referencedPaths,
    native_write_sent: false,
    native_acknowledged: false,
    last_verification: freshVerification("catalog_template_validated"),
    created_at: now,
    updated_at: now,
    history: [{ status: "prepared", at: now }],
  };
  await ctx.store.save(change);
  return publicCatalogChange(change);
}

async function prepareCatalogTemplateDelete(ctx, input) {
  const target = parseCatalogRef(input.target_ref, ctx.hubSerial);
  forbidUnexpectedFields(
    input,
    [...COMMON_UNEXPECTED_FIELDS, "value", "source"],
    CATALOG_TEMPLATE_DELETE,
  );
  if (target.store !== "INTERNAL") {
    throw catalogTemplateReadOnlyError(target.store, CATALOG_TEMPLATE_DELETE);
  }
  const live = await ctx.client.getCatalogTemplate(target);
  if (live === null) throw catalogTemplateNotFoundError();
  if (live.store !== "INTERNAL" || live.write === false) {
    throw catalogTemplateReadOnlyError(live.store, CATALOG_TEMPLATE_DELETE);
  }
  const linked = hasLinkedDevices(live);
  const devCount = linkedDeviceCount(live);
  const accCount = Array.isArray(live.accessories)
    ? live.accessories.length
    : 0;
  const now = new Date().toISOString();
  const change = {
    id: ctx.store.newId(),
    kind: CATALOG_TEMPLATE_DELETE,
    status: "prepared",
    home_ref: configuredHomeRef(ctx.hubSerial),
    reason: input.reason,
    target_ref: input.target_ref,
    target,
    controller: target.controller,
    baseline_snapshot: catalogSnapshot(live),
    device_count: devCount,
    linked_accessory_count: accCount,
    requires_confirmation: linked,
    native_write_sent: false,
    native_acknowledged: false,
    last_verification: freshVerification("catalog_template_validated"),
    created_at: now,
    updated_at: now,
    history: [{ status: "prepared", at: now }],
  };
  await ctx.store.save(change);
  const presented = publicCatalogChange(change);
  if (!linked) return presented;
  const affectedCount = Math.max(devCount, accCount);
  return {
    ...presented,
    tell_owner: `This INTERNAL ${target.controller} catalog template (${target.file}) is currently linked to ${affectedCount} device(s)/accessory(ies). Deleting it may affect how those devices work on re-pairing or reload. Confirm with the owner before calling apply_native_change.`,
  };
}

// ---- Apply -----------------------------------------------------------------

export async function applyCatalogChange(ctx, change) {
  switch (change.kind) {
    case CATALOG_TEMPLATE_CREATE:
      return applyCatalogTemplateCreate(ctx, change);
    case CATALOG_TEMPLATE_UPDATE:
      return applyCatalogTemplateUpdate(ctx, change);
    case CATALOG_TEMPLATE_DELETE:
      return applyCatalogTemplateDelete(ctx, change);
    default:
      throw new SprutHubError(
        "unsupported_native_operation",
        "This native operation is not supported.",
      );
  }
}

async function listCandidateInternalTemplates(
  ctx,
  controller,
  baselineFiles = [],
) {
  const listed = await ctx.client.listCatalogTemplates({
    filter: { stores: ["INTERNAL"], controllers: [controller] },
  });
  const known = new Set(baselineFiles);
  return listed
    .filter((entry) => !known.has(entry.file))
    .map((entry) => ({
      ref: catalogRef(ctx.hubSerial, entry.store, entry.controller, entry.file),
      file: entry.file,
      active: entry.active === true,
      ...(typeof entry.model === "string"
        ? { model: redactSensitiveText(entry.model) }
        : {}),
      ...(typeof entry.error === "string" && entry.error.trim().length > 0
        ? { error: redactSensitiveText(entry.error) }
        : {}),
    }));
}

async function recordUnknownCatalogCreate(
  ctx,
  change,
  baselineFiles,
  conflictReason,
) {
  let candidates;
  try {
    candidates = await listCandidateInternalTemplates(
      ctx,
      change.controller,
      baselineFiles,
    );
  } catch (error) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: failedVerification(error),
    });
  }
  return ctx.finishNative(change, "uncertain", undefined, {
    candidate_templates: candidates,
    conflict_reason: conflictReason,
    last_verification: freshVerification(
      candidates.length > 0
        ? "unowned_candidate_template_observed"
        : "candidate_template_missing",
    ),
  });
}

async function cleanupRejectedCreatedTemplate(ctx, change, created, hubError) {
  const file = created.file;
  const createdRef = catalogRef(
    ctx.hubSerial,
    "INTERNAL",
    change.controller,
    file,
  );
  // Persist created file before attempting cleanup so a crash mid-cleanup
  // never loses track of the broken file left on the hub.
  change.created_store = "INTERNAL";
  change.created_file = file;
  change.created_catalog_ref = createdRef;
  change.creation_owned = true;
  change.hub_template_error = hubError;
  change.applied_snapshot = catalogSnapshot(created);
  await ctx.store.save(change);

  let cleanupError = null;
  try {
    await ctx.client.deleteCatalogTemplate({
      store: "INTERNAL",
      controller: change.controller,
      file,
    });
  } catch (error) {
    cleanupError =
      error instanceof SprutHubError
        ? { code: error.code, message: redactSensitiveText(error.message) }
        : { code: "cleanup_failed", message: "Cleanup delete failed." };
  }

  let afterDelete;
  try {
    afterDelete = await ctx.client.getCatalogTemplate({
      store: "INTERNAL",
      controller: change.controller,
      file,
    });
  } catch (readError) {
    return ctx.finishNative(change, "uncertain", undefined, {
      hub_template_error: hubError,
      cleanup_failed: true,
      ...(cleanupError ? { cleanup_error: cleanupError } : {}),
      last_verification: failedVerification(readError),
    });
  }

  if (afterDelete === null) {
    return ctx.finishNative(change, "rejected", undefined, {
      hub_template_error: hubError,
      cleanup_confirmed: true,
      cleaned_up_file: file,
      creation_owned: false,
      created_store: undefined,
      created_file: undefined,
      created_catalog_ref: undefined,
      applied_snapshot: undefined,
      last_verification: freshVerification(
        "hub_template_rejected_and_cleaned_up",
      ),
    });
  }

  // Broken file is confirmed still on the hub -> keep ownership so
  // restore_native_change can delete it cleanly!
  return ctx.finishNative(change, "applied", undefined, {
    hub_template_error: hubError,
    cleanup_failed: true,
    ...(cleanupError ? { cleanup_error: cleanupError } : {}),
    creation_owned: true,
    created_store: "INTERNAL",
    created_file: afterDelete.file,
    created_catalog_ref: createdRef,
    applied_snapshot: catalogSnapshot(afterDelete),
    last_verification: freshVerification("hub_template_cleanup_failed"),
  });
}

async function applyCatalogTemplateCreate(ctx, change) {
  if (change.native_write_sent === true && change.status !== "not_applied") {
    return getCatalogTemplateCreate(ctx, change);
  }
  await ctx.persistNativeIntent(change, "applying", "apply");
  let created;
  try {
    created = await ctx.client.createCatalogTemplate({
      controller: change.controller,
      template: change.requested_template,
    });
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "not_applied", error);
    }
    return recordUnknownCatalogCreate(
      ctx,
      change,
      change.baseline_files,
      "catalog_create_outcome_unknown",
    );
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;

  const hubError = hubTemplateError(created);
  if (hubError !== null) {
    return cleanupRejectedCreatedTemplate(ctx, change, created, hubError);
  }

  const createdRef = catalogRef(
    ctx.hubSerial,
    "INTERNAL",
    change.controller,
    created.file,
  );
  change.created_store = "INTERNAL";
  change.created_file = created.file;
  change.created_catalog_ref = createdRef;
  change.creation_owned = true;
  await ctx.store.save(change);

  let live;
  try {
    live = await ctx.client.getCatalogTemplate({
      store: "INTERNAL",
      controller: change.controller,
      file: created.file,
    });
  } catch (error) {
    return ctx.finishNative(change, "uncertain", undefined, {
      applied_snapshot: catalogSnapshot(created),
      last_verification: failedVerification(error),
    });
  }
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "created_catalog_template_missing",
      last_verification: freshVerification("created_catalog_template_missing"),
    });
  }
  const readbackError = hubTemplateError(live);
  if (readbackError !== null) {
    return cleanupRejectedCreatedTemplate(ctx, change, live, readbackError);
  }
  return ctx.finishNative(change, "applied", undefined, {
    created_store: "INTERNAL",
    created_file: live.file,
    created_catalog_ref: createdRef,
    creation_owned: true,
    applied_snapshot: catalogSnapshot(live),
    last_verification: freshVerification("created_catalog_template_observed"),
  });
}

async function rollbackRejectedUpdatedTemplate(ctx, change, updated, hubError) {
  let rollbackError = null;
  try {
    await ctx.client.updateCatalogTemplate({
      store: "INTERNAL",
      controller: change.target.controller,
      file: change.target.file,
      template: change.baseline_snapshot.template,
    });
  } catch (error) {
    rollbackError =
      error instanceof SprutHubError
        ? { code: error.code, message: redactSensitiveText(error.message) }
        : { code: "rollback_failed", message: "Rollback update failed." };
  }

  let afterRollback;
  try {
    afterRollback = await ctx.client.getCatalogTemplate(change.target);
  } catch (readError) {
    return ctx.finishNative(change, "uncertain", undefined, {
      hub_template_error: hubError,
      rollback_failed: true,
      ...(rollbackError ? { rollback_error: rollbackError } : {}),
      applied_snapshot: catalogSnapshot(updated),
      last_verification: failedVerification(readError),
    });
  }

  if (
    afterRollback !== null &&
    sameCatalogTemplate(
      afterRollback.template,
      change.baseline_snapshot.template,
    ) &&
    (change.baseline_snapshot.active !== true ||
      (afterRollback.active === true && !afterRollback.error))
  ) {
    return ctx.finishNative(change, "rejected", undefined, {
      hub_template_error: hubError,
      rollback_confirmed: true,
      observed_sha256: templateFingerprint(afterRollback.template),
      last_verification: freshVerification(
        "hub_template_rejected_and_rolled_back",
      ),
    });
  }

  if (afterRollback !== null) {
    return ctx.finishNative(change, "applied", undefined, {
      hub_template_error: hubError,
      rollback_failed: true,
      ...(rollbackError ? { rollback_error: rollbackError } : {}),
      applied_snapshot: catalogSnapshot(afterRollback),
      observed_sha256: templateFingerprint(afterRollback.template),
      last_verification: freshVerification("hub_template_rollback_failed"),
    });
  }

  return ctx.finishNative(change, "uncertain", undefined, {
    hub_template_error: hubError,
    rollback_failed: true,
    ...(rollbackError ? { rollback_error: rollbackError } : {}),
    applied_snapshot: catalogSnapshot(updated),
    last_verification: freshVerification("catalog_template_missing"),
  });
}

async function applyCatalogTemplateUpdate(ctx, change) {
  if (change.native_write_sent === true && change.status !== "not_applied") {
    return getCatalogTemplateUpdate(ctx, change);
  }
  const live = await ctx.client.getCatalogTemplate(change.target);
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "catalog_template_missing",
      last_verification: freshVerification("catalog_template_missing"),
    });
  }
  if (live.store !== "INTERNAL" || live.write === false) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "catalog_template_read_only",
      last_verification: freshVerification("catalog_template_read_only"),
    });
  }
  if (!sameCatalogTemplate(live.template, change.baseline_snapshot.template)) {
    return ctx.finishNative(change, "conflict", undefined, {
      observed_sha256: templateFingerprint(live.template),
      conflict_reason: "catalog_template_changed_since",
      last_verification: freshVerification("catalog_template_changed_since"),
    });
  }

  await ctx.persistNativeIntent(change, "applying", "apply");
  let updated;
  try {
    updated = await ctx.client.updateCatalogTemplate({
      store: "INTERNAL",
      controller: change.target.controller,
      file: change.target.file,
      template: change.requested_template,
    });
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "not_applied", error);
    }
    return reconcileCatalogTemplateUpdate(ctx, change, "apply", true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;

  const hubError = hubTemplateError(updated);
  if (hubError !== null) {
    return rollbackRejectedUpdatedTemplate(ctx, change, updated, hubError);
  }
  return reconcileCatalogTemplateUpdate(ctx, change, "apply", false);
}

async function applyCatalogTemplateDelete(ctx, change) {
  if (change.native_write_sent === true && change.status !== "not_applied") {
    return getCatalogTemplateDelete(ctx, change);
  }
  const live = await ctx.client.getCatalogTemplate(change.target);
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "catalog_template_missing",
      last_verification: freshVerification("catalog_template_missing"),
    });
  }
  if (live.store !== "INTERNAL" || live.write === false) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "catalog_template_read_only",
      last_verification: freshVerification("catalog_template_read_only"),
    });
  }
  if (!sameCatalogTemplate(live.template, change.baseline_snapshot.template)) {
    return ctx.finishNative(change, "conflict", undefined, {
      observed_sha256: templateFingerprint(live.template),
      conflict_reason: "catalog_template_changed_since",
      last_verification: freshVerification("catalog_template_changed_since"),
    });
  }
  if (change.requires_confirmation !== true && hasLinkedDevices(live)) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "catalog_template_linked_devices_changed",
      last_verification: freshVerification(
        "catalog_template_linked_devices_changed",
      ),
    });
  }

  await ctx.persistNativeIntent(change, "applying", "apply");
  try {
    await ctx.client.deleteCatalogTemplate(change.target);
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "not_applied", error);
    }
    return reconcileCatalogTemplateDeleteApply(ctx, change, true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  return reconcileCatalogTemplateDeleteApply(ctx, change, false);
}

// ---- Reconciliation & get_native_change ------------------------------------

async function reconcileCatalogTemplateUpdate(
  ctx,
  change,
  direction,
  uncertainWrite,
) {
  let live;
  try {
    live = await ctx.client.getCatalogTemplate(change.target);
  } catch (error) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: failedVerification(error),
    });
  }
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "catalog_template_missing",
      last_verification: freshVerification("catalog_template_missing"),
    });
  }
  const targetTemplate =
    direction === "apply"
      ? change.requested_template
      : change.baseline_snapshot.template;
  const previousTemplate =
    direction === "apply"
      ? change.baseline_snapshot.template
      : change.applied_snapshot?.template;

  if (sameCatalogTemplate(live.template, targetTemplate)) {
    const hubError = hubTemplateError(live);
    if (direction === "apply" && hubError !== null) {
      return rollbackRejectedUpdatedTemplate(ctx, change, live, hubError);
    }
    if (
      direction === "restore" &&
      hubError !== null &&
      change.baseline_snapshot.active === true
    ) {
      return ctx.finishNative(change, "uncertain", undefined, {
        hub_template_error: hubError,
        observed_sha256: templateFingerprint(live.template),
        last_verification: freshVerification("restore_template_inactive"),
      });
    }
    return ctx.finishNative(
      change,
      direction === "apply" ? "applied" : "restored",
      undefined,
      {
        ...(direction === "apply"
          ? { applied_snapshot: catalogSnapshot(live) }
          : {}),
        observed_sha256: templateFingerprint(live.template),
        ...(uncertainWrite ? { recovered_after_uncertain_write: true } : {}),
        last_verification: freshVerification(
          direction === "apply"
            ? "requested_catalog_template_observed"
            : "baseline_catalog_template_observed",
        ),
      },
    );
  }
  if (sameCatalogTemplate(live.template, previousTemplate)) {
    if (
      direction === "apply" &&
      change.rollback_failed === true &&
      change.hub_template_error &&
      (change.baseline_snapshot.active !== true ||
        (live.active === true && !live.error))
    ) {
      return ctx.finishNative(change, "rejected", undefined, {
        rollback_confirmed: true,
        rollback_failed: undefined,
        observed_sha256: templateFingerprint(live.template),
        last_verification: freshVerification(
          "hub_template_rejected_and_rolled_back",
        ),
      });
    }
    return ctx.finishNative(change, "uncertain", undefined, {
      observed_sha256: templateFingerprint(live.template),
      last_verification: freshVerification("previous_template_still_present"),
    });
  }
  return ctx.finishNative(change, "conflict", undefined, {
    observed_sha256: templateFingerprint(live.template),
    conflict_reason: "catalog_template_changed_since",
    last_verification: freshVerification("catalog_template_changed_since"),
  });
}

async function reconcileCatalogTemplateDeleteApply(
  ctx,
  change,
  uncertainWrite,
) {
  let live;
  try {
    live = await ctx.client.getCatalogTemplate(change.target);
  } catch (error) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: failedVerification(error),
    });
  }
  if (live === null) {
    return ctx.finishNative(change, "applied", undefined, {
      delete_confirmed: true,
      ...(uncertainWrite ? { recovered_after_uncertain_write: true } : {}),
      last_verification: freshVerification("deleted_catalog_template_absent"),
    });
  }
  return ctx.finishNative(change, "uncertain", undefined, {
    observed_sha256: templateFingerprint(live.template),
    last_verification: freshVerification("catalog_template_still_present"),
  });
}

export async function getCatalogChange(ctx, change) {
  switch (change.kind) {
    case CATALOG_TEMPLATE_CREATE:
      return getCatalogTemplateCreate(ctx, change);
    case CATALOG_TEMPLATE_UPDATE:
      return getCatalogTemplateUpdate(ctx, change);
    case CATALOG_TEMPLATE_DELETE:
      return getCatalogTemplateDelete(ctx, change);
    default:
      throw new SprutHubError(
        "unsupported_native_operation",
        "This native operation is not supported.",
      );
  }
}

async function getCatalogTemplateCreate(ctx, change) {
  if (
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "not_owned" ||
    change.status === "rejected" ||
    change.status === "restored"
  ) {
    return ctx.publicStored(change);
  }
  if (change.created_file === undefined) {
    if (change.native_write_sent === true) {
      return recordUnknownCatalogCreate(
        ctx,
        change,
        change.baseline_files,
        "catalog_create_outcome_unknown",
      );
    }
    return ctx.publicStored(change);
  }
  let live;
  try {
    live = await ctx.client.getCatalogTemplate({
      store: "INTERNAL",
      controller: change.controller,
      file: change.created_file,
    });
  } catch (error) {
    return publicCatalogChange(change, {
      verification: failedVerification(error),
    });
  }
  if (live === null) {
    if (
      change.status === "uncertain" &&
      change.cleanup_failed === true &&
      change.hub_template_error
    ) {
      return ctx.finishNative(change, "rejected", undefined, {
        cleanup_confirmed: true,
        cleanup_failed: undefined,
        creation_owned: false,
        created_store: undefined,
        created_file: undefined,
        created_catalog_ref: undefined,
        applied_snapshot: undefined,
        last_verification: freshVerification(
          "hub_template_rejected_and_cleaned_up",
        ),
      });
    }
    if (isPendingRestoreIntent(change)) {
      return ctx.finishNative(change, "restored", undefined, {
        ...(change.write_intent?.acknowledged === false
          ? { recovered_after_uncertain_write: true }
          : {}),
        last_verification: freshVerification("created_catalog_template_absent"),
      });
    }
    if (change.status === "conflict") {
      return publicCatalogChange(change, {
        verification: freshVerification("created_catalog_template_missing"),
      });
    }
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "created_catalog_template_missing",
      last_verification: freshVerification("created_catalog_template_missing"),
    });
  }
  if (isPendingRestoreIntent(change)) {
    if (change.status === "restoring") {
      return ctx.finishNative(change, "uncertain", undefined, {
        observed_sha256: templateFingerprint(live.template),
        last_verification: freshVerification(
          "created_catalog_template_still_present",
        ),
      });
    }
    return publicCatalogChange(change, {
      observedSha256: templateFingerprint(live.template),
      verification: freshVerification("created_catalog_template_still_present"),
    });
  }
  if (change.status === "conflict") {
    return publicCatalogChange(change, {
      observedSha256: templateFingerprint(live.template),
      verification: freshVerification(change.conflict_reason ?? "conflict"),
    });
  }
  if (change.status === "applying") {
    return ctx.finishNative(change, "applied", undefined, {
      applied_snapshot: catalogSnapshot(live),
      last_verification: freshVerification("created_catalog_template_observed"),
    });
  }
  return publicCatalogChange(change, {
    observedSha256: templateFingerprint(live.template),
    verification: freshVerification(
      change.applied_snapshot &&
        sameCatalogTemplate(live.template, change.applied_snapshot.template)
        ? "created_catalog_template_observed"
        : "catalog_template_changed_since",
    ),
  });
}

async function getCatalogTemplateUpdate(ctx, change) {
  if (
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "not_owned" ||
    change.status === "rejected" ||
    change.status === "restored"
  ) {
    return ctx.publicStored(change);
  }
  if (["applying", "restoring", "uncertain"].includes(change.status)) {
    const direction = nativeIntentDirection(change) ?? "apply";
    return reconcileCatalogTemplateUpdate(
      ctx,
      change,
      direction,
      change.write_intent?.acknowledged !== true,
    );
  }
  let live;
  try {
    live = await ctx.client.getCatalogTemplate(change.target);
  } catch (error) {
    return publicCatalogChange(change, {
      verification: failedVerification(error),
    });
  }
  if (change.status === "conflict") {
    return publicCatalogChange(change, {
      ...(live ? { observedSha256: templateFingerprint(live.template) } : {}),
      verification: freshVerification(
        live === null
          ? "catalog_template_missing"
          : (change.conflict_reason ?? "conflict"),
      ),
    });
  }
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "catalog_template_missing",
      last_verification: freshVerification("catalog_template_missing"),
    });
  }
  return publicCatalogChange(change, {
    observedSha256: templateFingerprint(live.template),
    verification: freshVerification(
      change.applied_snapshot &&
        sameCatalogTemplate(live.template, change.applied_snapshot.template)
        ? "applied_catalog_template_observed"
        : "catalog_template_changed_since",
    ),
  });
}

async function getCatalogTemplateDelete(ctx, change) {
  if (
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "not_owned" ||
    change.status === "rejected"
  ) {
    return ctx.publicStored(change);
  }
  if (
    ["applying", "uncertain"].includes(change.status) &&
    nativeIntentDirection(change) === "apply"
  ) {
    return reconcileCatalogTemplateDeleteApply(
      ctx,
      change,
      change.write_intent?.acknowledged !== true,
    );
  }
  if (change.restored_file !== undefined) {
    let live;
    try {
      live = await ctx.client.getCatalogTemplate({
        store: "INTERNAL",
        controller: change.target.controller,
        file: change.restored_file,
      });
    } catch (error) {
      return publicCatalogChange(change, {
        verification: failedVerification(error),
      });
    }
    if (isPendingRestoreIntent(change)) {
      if (
        live !== null &&
        sameCatalogTemplate(live.template, change.baseline_snapshot.template) &&
        hubTemplateError(live) === null
      ) {
        return ctx.finishNative(change, "restored", undefined, {
          restored_snapshot: catalogSnapshot(live),
          recovered_after_uncertain_write:
            change.write_intent?.acknowledged === false ? true : undefined,
          last_verification: freshVerification(
            "deleted_catalog_template_recreated",
          ),
        });
      }
      return ctx.finishNative(change, "uncertain", undefined, {
        last_verification: freshVerification("recreated_template_unverified"),
      });
    }
    return publicCatalogChange(change, {
      verification: freshVerification(
        live !== null
          ? "recreated_catalog_template_observed"
          : "recreated_catalog_template_missing",
      ),
    });
  }
  if (isPendingRestoreIntent(change)) {
    return recordUnknownCatalogCreate(
      ctx,
      change,
      change.restore_baseline_files,
      "catalog_restore_outcome_unknown",
    );
  }
  let live;
  try {
    live = await ctx.client.getCatalogTemplate(change.target);
  } catch (error) {
    return publicCatalogChange(change, {
      verification: failedVerification(error),
    });
  }
  return publicCatalogChange(change, {
    verification: freshVerification(
      live === null
        ? "deleted_catalog_template_absent"
        : "catalog_template_still_present",
    ),
  });
}

// ---- Later-owned-change guard ----------------------------------------------

function changeApplicationTime(change) {
  return (
    change.history?.find(({ status }) => status === "applying")?.at ??
    change.created_at
  );
}

function isAppliedAfter(other, base) {
  const otherTime = changeApplicationTime(other);
  const baseTime = changeApplicationTime(base);
  if (otherTime !== baseTime) return otherTime > baseTime;
  if (other.created_at !== base.created_at) {
    return other.created_at > base.created_at;
  }
  return other.id > base.id;
}

async function findLaterAppliedCatalogChange(ctx, change, targetRef, kinds) {
  const stored = await ctx.store.list();
  const kindSet = new Set(kinds);
  const later = stored
    .filter(
      (other) =>
        other.id !== change.id &&
        other.home_ref === change.home_ref &&
        other.target_ref === targetRef &&
        kindSet.has(other.kind) &&
        other.status === "applied" &&
        isAppliedAfter(other, change),
    )
    .sort((left, right) =>
      changeApplicationTime(right).localeCompare(changeApplicationTime(left)),
    );
  return later[0] ?? null;
}

// ---- Restore ---------------------------------------------------------------

export async function restoreCatalogChange(ctx, change) {
  if (change.status === "restored") return ctx.publicStored(change);
  if (
    change.native_write_sent !== true ||
    change.status === "not_applied" ||
    change.status === "rejected"
  ) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "change_was_not_applied",
      last_verification: freshVerification("change_was_not_applied"),
    });
  }
  switch (change.kind) {
    case CATALOG_TEMPLATE_CREATE:
      return restoreCatalogTemplateCreate(ctx, change);
    case CATALOG_TEMPLATE_UPDATE:
      return restoreCatalogTemplateUpdate(ctx, change);
    case CATALOG_TEMPLATE_DELETE:
      return restoreCatalogTemplateDelete(ctx, change);
    default:
      throw new SprutHubError(
        "unsupported_native_operation",
        "This native operation is not supported.",
      );
  }
}

async function restoreCatalogTemplateCreate(ctx, change) {
  if (change.creation_owned !== true || change.created_file === undefined) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "catalog_template_creation_not_confirmed",
      last_verification: freshVerification(
        "catalog_template_creation_not_confirmed",
      ),
    });
  }
  const target = {
    store: "INTERNAL",
    controller: change.controller,
    file: change.created_file,
  };
  const live = await ctx.client.getCatalogTemplate(target);
  if (live === null) {
    if (
      change.status === "uncertain" &&
      change.cleanup_failed === true &&
      change.hub_template_error
    ) {
      return ctx.finishNative(change, "rejected", undefined, {
        cleanup_confirmed: true,
        cleanup_failed: undefined,
        creation_owned: false,
        created_store: undefined,
        created_file: undefined,
        created_catalog_ref: undefined,
        applied_snapshot: undefined,
        last_verification: freshVerification(
          "hub_template_rejected_and_cleaned_up",
        ),
      });
    }
    if (isPendingRestoreIntent(change)) {
      return ctx.finishNative(change, "restored", undefined, {
        recovered_after_uncertain_write: true,
        last_verification: freshVerification("created_catalog_template_absent"),
      });
    }
    const later = await findLaterAppliedCatalogChange(
      ctx,
      change,
      change.created_catalog_ref,
      [CATALOG_TEMPLATE_DELETE],
    );
    return ctx.finishNative(change, "conflict", undefined, {
      ...(later
        ? {
            conflict_reason: "later_owned_change",
            restore_first_change_id: later.id,
          }
        : { conflict_reason: "created_catalog_template_missing" }),
      last_verification: freshVerification(
        later ? "later_owned_change" : "created_catalog_template_missing",
      ),
    });
  }
  const expectedTemplate =
    change.applied_snapshot?.template ?? change.requested_template;
  if (!sameCatalogTemplate(live.template, expectedTemplate)) {
    const later = await findLaterAppliedCatalogChange(
      ctx,
      change,
      change.created_catalog_ref,
      [CATALOG_TEMPLATE_UPDATE, CATALOG_TEMPLATE_DELETE],
    );
    return ctx.finishNative(change, "conflict", undefined, {
      observed_sha256: templateFingerprint(live.template),
      ...(later
        ? {
            conflict_reason: "later_owned_change",
            restore_first_change_id: later.id,
          }
        : { conflict_reason: "catalog_template_changed_since" }),
      last_verification: freshVerification(
        later ? "later_owned_change" : "catalog_template_changed_since",
      ),
    });
  }
  const priorStatus = change.status === "applied" ? "applied" : change.status;
  await ctx.persistNativeIntent(change, "restoring", "restore");
  try {
    await ctx.client.deleteCatalogTemplate(target);
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, priorStatus, error);
    }
    const after = await ctx.client
      .getCatalogTemplate(target)
      .catch(() => undefined);
    if (after === null) {
      return ctx.finishNative(change, "restored", undefined, {
        recovered_after_uncertain_write: true,
        last_verification: freshVerification("created_catalog_template_absent"),
      });
    }
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification:
        after === undefined
          ? failedVerification(error)
          : freshVerification("created_catalog_template_still_present"),
    });
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  const after = await ctx.client.getCatalogTemplate(target);
  if (after === null) {
    return ctx.finishNative(change, "restored", undefined, {
      last_verification: freshVerification("created_catalog_template_absent"),
    });
  }
  return ctx.finishNative(change, "uncertain", undefined, {
    last_verification: freshVerification(
      "created_catalog_template_still_present",
    ),
  });
}

async function restoreCatalogTemplateUpdate(ctx, change) {
  if (
    ["applying", "uncertain"].includes(change.status) &&
    nativeIntentDirection(change) === "apply"
  ) {
    return reconcileCatalogTemplateUpdate(ctx, change, "apply", true);
  }
  if (!change.applied_snapshot) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "change_was_not_applied",
      last_verification: freshVerification("change_was_not_applied"),
    });
  }
  const live = await ctx.client.getCatalogTemplate(change.target);
  if (live === null) {
    const later = await findLaterAppliedCatalogChange(
      ctx,
      change,
      change.target_ref,
      [CATALOG_TEMPLATE_DELETE],
    );
    return ctx.finishNative(change, "conflict", undefined, {
      ...(later
        ? {
            conflict_reason: "later_owned_change",
            restore_first_change_id: later.id,
          }
        : { conflict_reason: "catalog_template_missing" }),
      last_verification: freshVerification(
        later ? "later_owned_change" : "catalog_template_missing",
      ),
    });
  }
  const pendingRestore = isPendingRestoreIntent(change);
  if (sameCatalogTemplate(live.template, change.baseline_snapshot.template)) {
    return ctx.finishNative(change, "restored", undefined, {
      observed_sha256: templateFingerprint(live.template),
      ...(pendingRestore ? { recovered_after_uncertain_write: true } : {}),
      last_verification: freshVerification(
        "baseline_catalog_template_observed",
      ),
    });
  }
  if (!sameCatalogTemplate(live.template, change.applied_snapshot.template)) {
    const later = await findLaterAppliedCatalogChange(
      ctx,
      change,
      change.target_ref,
      [CATALOG_TEMPLATE_UPDATE, CATALOG_TEMPLATE_DELETE],
    );
    return ctx.finishNative(change, "conflict", undefined, {
      observed_sha256: templateFingerprint(live.template),
      ...(later
        ? {
            conflict_reason: "later_owned_change",
            restore_first_change_id: later.id,
          }
        : { conflict_reason: "catalog_template_changed_since" }),
      last_verification: freshVerification(
        later ? "later_owned_change" : "catalog_template_changed_since",
      ),
    });
  }
  await ctx.persistNativeIntent(change, "restoring", "restore");
  let updated;
  try {
    updated = await ctx.client.updateCatalogTemplate({
      store: "INTERNAL",
      controller: change.target.controller,
      file: change.target.file,
      template: change.baseline_snapshot.template,
    });
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "applied", error);
    }
    return reconcileCatalogTemplateUpdate(ctx, change, "restore", true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  const hubError = hubTemplateError(updated);
  if (hubError !== null && change.baseline_snapshot.active === true) {
    return ctx.finishNative(change, "uncertain", undefined, {
      hub_template_error: hubError,
      observed_sha256: templateFingerprint(updated.template),
      last_verification: freshVerification("restore_template_inactive"),
    });
  }
  return reconcileCatalogTemplateUpdate(ctx, change, "restore", false);
}

async function restoreCatalogTemplateDelete(ctx, change) {
  if (
    ["applying", "uncertain"].includes(change.status) &&
    nativeIntentDirection(change) === "apply"
  ) {
    return reconcileCatalogTemplateDeleteApply(ctx, change, true);
  }
  if (isPendingRestoreIntent(change)) {
    // NEVER send a duplicate catalog.create after a lost reply or crash!
    if (change.restored_file !== undefined) {
      return getCatalogTemplateDelete(ctx, change);
    }
    return recordUnknownCatalogCreate(
      ctx,
      change,
      change.restore_baseline_files,
      "catalog_restore_outcome_unknown",
    );
  }
  if (change.delete_confirmed !== true) {
    const live = await ctx.client.getCatalogTemplate(change.target);
    if (live !== null) {
      return ctx.finishNative(change, "conflict", undefined, {
        conflict_reason: "catalog_template_still_present",
        last_verification: freshVerification("catalog_template_still_present"),
      });
    }
  }
  const existingInternal = await ctx.client.listCatalogTemplates({
    filter: { stores: ["INTERNAL"], controllers: [change.target.controller] },
  });
  change.restore_baseline_files = existingInternal.map(({ file }) => file);
  await ctx.persistNativeIntent(change, "restoring", "restore");

  let created;
  try {
    created = await ctx.client.createCatalogTemplate({
      controller: change.target.controller,
      template: change.baseline_snapshot.template,
    });
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "applied", error);
    }
    return recordUnknownCatalogCreate(
      ctx,
      change,
      change.restore_baseline_files,
      "catalog_restore_outcome_unknown",
    );
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;

  const hubError = hubTemplateError(created);
  if (hubError !== null) {
    // Clean up broken recreated file if possible so we don't leave a ghost file.
    let cleaned = false;
    if (typeof created.file === "string" && created.file.length > 0) {
      try {
        await ctx.client.deleteCatalogTemplate({
          store: "INTERNAL",
          controller: change.target.controller,
          file: created.file,
        });
        const check = await ctx.client.getCatalogTemplate({
          store: "INTERNAL",
          controller: change.target.controller,
          file: created.file,
        });
        cleaned = check === null;
      } catch {
        cleaned = false;
      }
    }
    return ctx.finishNative(
      change,
      cleaned ? "conflict" : "uncertain",
      undefined,
      {
        hub_template_error: hubError,
        conflict_reason: "catalog_restore_rejected_by_hub",
        ...(cleaned ? { cleanup_confirmed: true } : {}),
        last_verification: freshVerification("catalog_restore_rejected_by_hub"),
      },
    );
  }

  const restoredRef = catalogRef(
    ctx.hubSerial,
    "INTERNAL",
    change.target.controller,
    created.file,
  );
  change.restored_file = created.file;
  change.restored_catalog_ref = restoredRef;
  await ctx.store.save(change);

  const live = await ctx.client.getCatalogTemplate({
    store: "INTERNAL",
    controller: change.target.controller,
    file: created.file,
  });
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "recreated_catalog_template_missing",
      last_verification: freshVerification(
        "recreated_catalog_template_missing",
      ),
    });
  }
  const liveError = hubTemplateError(live);
  if (liveError !== null) {
    return ctx.finishNative(change, "uncertain", undefined, {
      hub_template_error: liveError,
      last_verification: freshVerification("catalog_restore_rejected_by_hub"),
    });
  }
  return ctx.finishNative(change, "restored", undefined, {
    restored_file: live.file,
    restored_catalog_ref: restoredRef,
    restored_snapshot: catalogSnapshot(live),
    last_verification: freshVerification("deleted_catalog_template_recreated"),
  });
}

// ---- Presentation & history helpers ----------------------------------------

export function publicCatalogChange(change, options = {}) {
  const verification = Object.hasOwn(options, "verification")
    ? options.verification
    : change.last_verification;
  const observedSha256 =
    options.observedSha256 !== undefined
      ? options.observedSha256
      : change.observed_sha256;
  const common = {
    status: change.status,
    change_ref: `spruthub-change://native/${change.id}`,
    operation: change.kind,
    reason: change.reason,
    target_ref: change.target_ref,
    controller: change.controller,
    ...(change.warning ? { warning: change.warning } : {}),
    ...(change.overlapping_templates?.length > 0
      ? {
          overlapping_templates: structuredClone(change.overlapping_templates),
        }
      : {}),
  };
  const tail = {
    native_write_sent: change.native_write_sent,
    native_acknowledged: change.native_acknowledged,
    ...(change.write_intent
      ? { write_intent: structuredClone(change.write_intent) }
      : {}),
    ...(verification ? { verification } : {}),
    ...(change.recovered_after_uncertain_write
      ? { recovered_after_uncertain_write: true }
      : {}),
    ...(change.hub_template_error
      ? { hub_template_error: change.hub_template_error }
      : {}),
    ...(change.cleanup_confirmed ? { cleanup_confirmed: true } : {}),
    ...(change.cleanup_failed ? { cleanup_failed: true } : {}),
    ...(change.cleanup_error
      ? { cleanup_error: structuredClone(change.cleanup_error) }
      : {}),
    ...(change.rollback_confirmed ? { rollback_confirmed: true } : {}),
    ...(change.rollback_failed ? { rollback_failed: true } : {}),
    ...(change.rollback_error
      ? { rollback_error: structuredClone(change.rollback_error) }
      : {}),
    ...(observedSha256 ? { observed_sha256: observedSha256 } : {}),
    ...(change.conflict_reason
      ? { conflict_reason: change.conflict_reason }
      : {}),
    ...(change.conflict_reason === "later_owned_change" &&
    typeof change.restore_first_change_id === "string"
      ? {
          restore_first_change_ref: `spruthub-change://native/${change.restore_first_change_id}`,
        }
      : {}),
    ...((change.cleanup_failed || change.rollback_failed) &&
    change.status !== "restored" &&
    change.status !== "rejected"
      ? {
          next: {
            tool: "restore_native_change",
            arguments: { change_ref: `spruthub-change://native/${change.id}` },
          },
        }
      : {}),
  };

  if (change.kind === CATALOG_TEMPLATE_CREATE) {
    return {
      ...common,
      diff: {
        template: {
          from_sha256: null,
          to_sha256: change.requested_sha256,
          ...(change.requested_metadata
            ? { metadata: structuredClone(change.requested_metadata) }
            : {}),
        },
      },
      ...(change.created_catalog_ref
        ? {
            created_catalog_ref: change.created_catalog_ref,
            file: change.created_file,
          }
        : {}),
      ...(change.candidate_templates
        ? { candidate_templates: structuredClone(change.candidate_templates) }
        : {}),
      creation_owned: change.creation_owned === true,
      ...tail,
      restore_supported:
        change.creation_owned === true && change.status !== "rejected",
      limitations: [
        "SprutHub creates custom templates in INTERNAL with an auto-assigned /N.json path; existing devices use the updated template only after re-pairing (e.g. ZigBee Repair) or controller reload.",
        "If SprutHub marks a newly created template inactive with an error, apply attempts automatic cleanup via catalog.delete and marks the change rejected once deletion is confirmed.",
      ],
    };
  }

  if (change.kind === CATALOG_TEMPLATE_UPDATE) {
    const restoreSupported =
      change.status !== "rejected" &&
      change.status !== "not_applied" &&
      change.status !== "not_owned";
    return {
      ...common,
      file: change.target?.file,
      diff: {
        template: {
          from_sha256: change.baseline_snapshot?.sha256 ?? null,
          to_sha256: change.requested_sha256,
        },
      },
      ...tail,
      restore_supported: restoreSupported,
      limitations: [
        "Only INTERNAL writable catalog templates can be updated; MAIN templates are read-only.",
        "If SprutHub marks an updated template inactive with an error, apply attempts automatic rollback to the baseline template and verifies readback.",
      ],
    };
  }

  // CATALOG_TEMPLATE_DELETE
  return {
    ...common,
    file: change.target?.file,
    device_count: change.device_count ?? 0,
    linked_accessory_count: change.linked_accessory_count ?? 0,
    requires_confirmation: change.requires_confirmation === true,
    diff: {
      template: {
        from_sha256: change.baseline_snapshot?.sha256 ?? null,
        to_sha256: null,
      },
    },
    ...(change.restored_catalog_ref
      ? { restored_catalog_ref: change.restored_catalog_ref }
      : {}),
    ...(change.candidate_templates
      ? { candidate_templates: structuredClone(change.candidate_templates) }
      : {}),
    ...tail,
    restore_supported: [
      "prepared",
      "applying",
      "uncertain",
      "applied",
    ].includes(change.status),
    limitations: [
      "Only INTERNAL writable catalog templates can be deleted; MAIN templates are read-only.",
      "Undo recreates the deleted template in INTERNAL via catalog.create under a new /N.json file path (reported in restored_catalog_ref).",
    ],
  };
}

export function catalogChangeName(change) {
  const controller = change.controller ?? "catalog";
  const file =
    change.created_file ?? change.target?.file ?? change.restored_file;
  const model =
    change.applied_snapshot?.model ??
    change.requested_metadata?.model ??
    change.baseline_snapshot?.model;
  const base = file ? `${controller} ${file}` : controller;
  return model ? `${base} (${redactSensitiveText(model)})` : base;
}

export function catalogRestoreSupported(change, { activeStatus, isConflict }) {
  if (
    change.native_write_sent !== true ||
    change.status === "rejected" ||
    change.status === "not_applied"
  ) {
    return false;
  }
  if (change.kind === CATALOG_TEMPLATE_CREATE) {
    if (change.creation_owned !== true) return false;
    return isConflict
      ? change.conflict_reason === "later_owned_change"
      : activeStatus;
  }
  if (change.kind === CATALOG_TEMPLATE_UPDATE) {
    return isConflict
      ? change.applied_snapshot !== undefined &&
          change.conflict_reason === "later_owned_change"
      : activeStatus;
  }
  return activeStatus;
}

export function catalogAffectedRefs(change) {
  const refs = [change.target_ref];
  for (const ref of [change.created_catalog_ref, change.restored_catalog_ref]) {
    if (typeof ref === "string") refs.push(ref);
  }
  for (const item of change.candidate_templates ?? []) {
    if (typeof item?.ref === "string") refs.push(item.ref);
  }
  return refs;
}
