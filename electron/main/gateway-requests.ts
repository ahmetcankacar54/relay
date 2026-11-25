import { app } from "electron";
import path from "node:path";
import { GatewayRequestLog } from "../core/proxy/proxy-request-log";
import { REQUEST_LOG_SIZE } from "../core/proxy/proxy-stats";
/** The gateway's requests across restarts: the feed, and which account served a request id. */
let gatewayRequestLog: GatewayRequestLog | undefined;
export function gatewayRequests(): GatewayRequestLog {
  if (!gatewayRequestLog) {
    gatewayRequestLog = new GatewayRequestLog(path.join(app.getPath("userData"), "gateway-requests.jsonl"), {
      feedSize: REQUEST_LOG_SIZE,
    });
    gatewayRequestLog.load();
  }
  return gatewayRequestLog;
}
