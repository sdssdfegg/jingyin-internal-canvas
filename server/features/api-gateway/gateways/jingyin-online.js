export const JINGYIN_ONLINE_GATEWAY = Object.freeze({
  id: "jingyin-gateway",
  label: "静音中转站",
  role: "primary",
  priority: 1,
  baseUrlEnvNames: [
    "JINGYIN_GATEWAY_BASE_URL",
    "JINGYIN_PRIMARY_CHANNEL_BASE_URL"
  ],
  defaultBaseUrl: "https://api.jingyin.online/v1",
  public: false,
  billingMode: "gateway",
  billingChannelId: "jingyin-gateway",
  upstreamApiKey: "",
  modelAliases: {}
});
