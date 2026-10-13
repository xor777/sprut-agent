import { blockPathToPointer } from "./block-pause.mjs";
import { isRecord } from "./change-refs.mjs";
import { isHubReadFailure, SprutHubError } from "./spruthub-client.mjs";

// The recipients of one notify node: null for every notification service,
// or its entries {index, clients}. The services and their recipients are
// checked against the home after the walk.
export function notifyRecipients(node, path, report) {
  const to = node.to ?? null;
  if (to === null) return null;
  if (node.mode !== "PUSH") {
    report(path, "a MESSAGE notification has no recipients; to must be null");
    return null;
  }
  if (!Array.isArray(to) || to.length === 0) {
    report(
      path,
      "to must be null for every notification service, or a non-empty list of {index, clients}",
    );
    return null;
  }
  const indexes = new Set();
  let valid = true;
  to.forEach((entry, position) => {
    const at = `${path}[${position}]`;
    const fail = (where, message) => {
      valid = false;
      report(where, message);
    };
    if (!isRecord(entry)) {
      fail(at, "a recipient entry must be {index, clients}");
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!["index", "clients"].includes(key)) {
        fail(`${at}.${key}`, "unsupported field");
      }
    }
    if (typeof entry.index !== "string" || entry.index === "") {
      fail(
        `${at}.index`,
        "index must be the index of a notification service of this home",
      );
    } else if (indexes.has(entry.index)) {
      fail(
        `${at}.index`,
        `notification service ${entry.index} is listed twice`,
      );
    } else {
      indexes.add(entry.index);
    }
    const clients = entry.clients ?? null;
    if (
      clients !== null &&
      (!Array.isArray(clients) ||
        clients.length === 0 ||
        clients.some((id) => typeof id !== "string" || id === "") ||
        new Set(clients).size !== clients.length)
    ) {
      fail(
        `${at}.clients`,
        "clients must be null for all recipients of the service, or a non-empty list of distinct recipient ids",
      );
    }
  });
  return valid
    ? to.map(({ index, clients }) => ({ index, clients: clients ?? null }))
    : null;
}

// Notification services of the home (extensions with bundle type
// NOTIFICATION), read when a BLOCK has a PUSH notification.
export async function readNotificationServices(client) {
  const { extensions } = await client.nativeExtensions(
    client.selectedSerial(),
    Date.now() + client.timeoutMs,
  );
  return extensions
    .filter(({ bundle_type: bundleType }) => bundleType === "NOTIFICATION")
    .map(({ ref, name, index, enabled, state }) => ({
      ref,
      name,
      index,
      enabled,
      state,
    }));
}

// The recipients of one notification service, read once per validation;
// null when get_entity could not read them or the service.
export async function notificationServiceRecipients(client, service) {
  if (service.recipients === undefined) {
    let children;
    try {
      children = (await client.getEntity(service.ref, ["children"])).entity
        ?.children;
    } catch (error) {
      if (!isHubReadFailure(error)) throw error;
    }
    service.recipients = Array.isArray(children)
      ? children.map(({ ref, id, name }) => ({ ref, id, name }))
      : null;
  }
  return service.recipients;
}

// Checks the services and recipients of each PUSH notification the change
// adds or changes against the home, and reads the recipients of every
// service one goes through, so that the preview can say when a service
// reaches no one. A notification to all recipients of a service needs them
// only for that: where they cannot be read, the preview says so. Named
// recipients cannot be checked without them. A notification an edit keeps
// is written as stored and is not read again.
export async function checkNotificationRecipients(context, client, report) {
  const written = context.notifications.filter(({ kept }) => !kept);
  if (!written.some(({ mode }) => mode === "PUSH")) return;
  context.notificationServices = await readNotificationServices(client);
  const known = context.notificationServices
    .map(({ index }) => index)
    .join(", ");
  for (const notification of written) {
    if (notification.mode !== "PUSH") continue;
    if (notification.to === null) {
      for (const service of context.notificationServices) {
        await notificationServiceRecipients(client, service);
      }
      continue;
    }
    for (const [position, entry] of notification.to.entries()) {
      const at = `${notification.path}.to[${position}]`;
      const service = context.notificationServices.find(
        ({ index }) => index === entry.index,
      );
      if (!service) {
        report(
          `${at}.index`,
          `no notification service with index ${entry.index} in this home; notification services: ${known || "none"}`,
        );
        continue;
      }
      const recipients = await notificationServiceRecipients(client, service);
      if (entry.clients === null) continue;
      if (recipients === null) {
        throw new SprutHubError(
          "notification_recipients_unread",
          `The recipients of notification service ${service.index} could not be read; nothing was prepared. Read them with get_entity and prepare again.`,
          "get_entity",
          {
            next: {
              tool: "get_entity",
              arguments: { entity_ref: service.ref, include: ["children"] },
            },
          },
        );
      }
      entry.clients.forEach((id, slot) => {
        if (recipients.some((item) => item.id === id)) return;
        report(
          `${at}.clients[${slot}]`,
          `notification service ${entry.index} has no recipient with id ${id}; recipients: ${recipients.map((item) => item.id).join(", ") || "none"}`,
        );
      });
    }
  }
}

// What a notification of the preview goes through, as read at preparation,
// with a warning for each service that may deliver nothing: one that is not
// enabled and LOADED (such as the owner's FAILED Telegram), one without
// recipients, and a PUSH to all services of a home that has none.
export function notificationPreview(notification, services = []) {
  const base = {
    configuration_pointer: blockPathToPointer(notification.path),
    mode: notification.mode,
    text: notification.text,
  };
  if (notification.mode !== "PUSH") return { ...base, delivery: "system" };
  const toAll = notification.to === null;
  const { through, warnings } = notificationServicesShown(
    services,
    notification.to,
  );
  if (toAll && services.length === 0) {
    warnings.push({
      code: "no_notification_services",
      message:
        "The home has no notification service: a PUSH to all of them goes nowhere. Tell the owner.",
    });
  }
  return {
    ...base,
    delivery: toAll ? "all_notification_services" : "listed_services",
    services: through,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// The services a notification to (null for all of them) goes through, each
// with its state and recipients as read, and a warning for each one that
// may deliver nothing.
export function notificationServicesShown(services, to) {
  const warnings = [];
  const through = (
    to === null
      ? services.map((service) => ({ service, clients: null }))
      : to.map(({ index, clients }) => ({
          index,
          service: services.find((item) => item.index === index),
          clients,
        }))
  ).map(({ index, service, clients }) => {
    if (!service) return { index, binding: "not_found" };
    const { ref, name, enabled, state, recipients } = service;
    if (enabled !== true || state !== "LOADED") {
      warnings.push({
        code: "service_not_ready",
        service_ref: ref,
        message: `This notification service is ${enabled === true ? "enabled" : "not enabled"} and in state ${state}, not LOADED: it may deliver nothing. Tell the owner before promising the notification.`,
      });
    }
    const count = Array.isArray(recipients) ? recipients.length : null;
    if (clients === null && count === 0) {
      warnings.push({
        code: "no_recipients",
        service_ref: ref,
        message:
          "This notification service has no recipients: nothing is delivered through it. Tell the owner; recipients are added to the service in SprutHub.",
      });
    }
    if (clients === null && count === null) {
      warnings.push({
        code: "recipients_unread",
        service_ref: ref,
        message:
          "The recipients of this notification service could not be read at preparation: whether it reaches anyone is not known. Tell the owner before promising the notification through it.",
      });
    }
    return {
      ref,
      name,
      enabled,
      state,
      ...(clients === null
        ? { recipients: "all", recipient_count: count }
        : {
            recipients: clients.map((id) => {
              const recipient = recipients?.find((item) => item.id === id);
              return recipient
                ? { ref: recipient.ref, name: recipient.name }
                : { id, binding: "not_found" };
            }),
          }),
    };
  });
  return { through, warnings };
}

// The home's notification services as read now, for a characteristic's own
// notification. Through which of them, and to whom, SprutHub sends it was
// not observed, so each is shown with its state and recipient count and
// the warnings a BLOCK notification to all of them would get. They do not
// change the setting: when the hub does not give them, they are unknown.
export async function characteristicNotificationServices(client) {
  let services;
  try {
    services = await readNotificationServices(client);
  } catch (error) {
    if (!isHubReadFailure(error)) throw error;
    return {
      services: null,
      warnings: [
        {
          code: "notification_services_unread",
          message:
            "The home's notification services could not be read: whether this notification reaches anyone is not known. Tell the owner before promising it; home_overview list=extensions reads them.",
        },
      ],
    };
  }
  for (const service of services) {
    await notificationServiceRecipients(client, service);
  }
  const { through, warnings } = notificationServicesShown(services, null);
  return {
    services: through.map(({ recipients: _all, ...service }) => service),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
