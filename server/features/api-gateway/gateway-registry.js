import { JINGYIN_ONLINE_GATEWAY } from "./gateways/jingyin-online.js";

export const API_GATEWAY_MODULES = Object.freeze([
  JINGYIN_ONLINE_GATEWAY
]);

export function gatewayEnvBaseUrl(gateway, env = process.env) {
  const names = Array.isArray(gateway?.baseUrlEnvNames) ? gateway.baseUrlEnvNames : [];
  for (const name of names) {
    const value = String(env?.[name] || "").trim();
    if (value) return value;
  }
  return gateway?.defaultBaseUrl || "";
}

export function gatewayPriority(gateway, index = 0) {
  const priority = Number(gateway?.priority);
  return Number.isFinite(priority) ? priority : index + 1;
}
