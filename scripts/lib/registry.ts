import { REGISTRY_TIMEOUT_MS, REGISTRY_URL } from "./constants.js";
import { testEnv } from "./env.js";

export async function fetchRegistryJson(): Promise<unknown> {
  const mocked = testEnv("OMS_TEST_REGISTRY_RESPONSE");
  if (mocked !== undefined) return JSON.parse(mocked);
  const failure = testEnv("OMS_TEST_REGISTRY_FAILURE");
  if (failure) throw new Error(failure);
  let response: Response;
  try {
    response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Could not reach npm registry: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`npm registry request failed with HTTP ${response.status}`);
  return response.json();
}
