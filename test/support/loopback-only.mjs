// Loaded into test processes and every server they launch: a test reaches
// only fake hubs on this machine, never the owner's hub or the SprutHub cloud
// a login without SPRUTHUB_URL would go to. Every TCP and TLS connection,
// including the WebSocket to a hub, passes through Socket#connect.
import net from "node:net";

const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function (...args) {
  const host = targetHost(args);
  if (host !== null && !isLoopback(host)) {
    // Also on stderr: a server reports only that the hub is unreachable.
    const message = `test isolation: refused a connection to ${host}; tests reach only hubs on 127.0.0.1`;
    console.error(message);
    throw new Error(message);
  }
  return connect.apply(this, args);
};

// net.connect passes its arguments already normalized as [options, callback].
function targetHost(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === "object") {
    if (first.path) return null;
    return first.host ?? "localhost";
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return null;
  return typeof args[1] === "string" ? args[1] : "localhost";
}

function isLoopback(host) {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}
