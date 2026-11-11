import type { ProviderPreset } from "@mrog/shared";

/** What decides which fields the Add provider form shows. */
type PresetFields = Pick<ProviderPreset, "preset" | "group" | "needsKey" | "needsBaseUrl">;

/** Whether the form asks for an API key: required by the service, or optional for one the user sets up by hand. */
export function showsApiKey(preset: Pick<PresetFields, "needsKey" | "group">): boolean {
  return preset.needsKey || preset.group === "custom";
}

/** Whether the form asks for a server address. */
export function showsBaseUrl(preset: Pick<PresetFields, "needsBaseUrl" | "group">): boolean {
  return preset.needsBaseUrl || preset.group === "local";
}

/**
 * The request for a new provider. Only what the form is showing is sent: a key typed for one service and then left
 * behind by switching to another (that field is gone, and with it any sign the key is still there) must not be
 * stored for it and sent to whatever address it uses.
 */
export function addProviderBody(
  preset: PresetFields,
  fields: { label: string; baseUrl: string; apiKey: string },
) {
  const label = fields.label.trim();
  const baseUrl = fields.baseUrl.trim();
  const apiKey = fields.apiKey.trim();
  return {
    preset: preset.preset,
    ...(label ? { label } : {}),
    ...(baseUrl && showsBaseUrl(preset) ? { baseUrl } : {}),
    ...(apiKey && showsApiKey(preset) ? { apiKey } : {}),
  };
}
