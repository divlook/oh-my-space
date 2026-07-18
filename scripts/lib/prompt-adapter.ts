import {
  confirm as clackConfirm,
  isCancel as clackIsCancel,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { isTestMode } from "./env.js";

/**
 * Guarded seam for interactive prompts. Under `OMS_TEST_MODE=1` a JSON queue in
 * `OMS_TEST_PROMPT_RESPONSES` drives prompts deterministically without a PTY; otherwise the real
 * clack prompts run unchanged. The queue is parsed once per process and consumed in prompt order.
 */

const ENV_NAME = "OMS_TEST_PROMPT_RESPONSES";

/** Sentinel returned by guarded prompts when an injected `{"type":"cancel"}` entry is consumed. */
export const PROMPT_CANCEL: unique symbol = Symbol("oms:prompt-cancel");

/** True for both clack's native cancel symbol and OMS's injected cancel sentinel. */
export function isCancel(value: unknown): value is symbol {
  return clackIsCancel(value) || value === PROMPT_CANCEL;
}

/** A misconfigured test queue; thrown to force a fail-closed exit 1 without opening a real prompt. */
export class PromptQueueError extends Error {}

type PromptType = "select" | "confirm" | "text";

type ResponseEntry =
  | { type: "select"; value: string }
  | { type: "confirm"; value: boolean }
  | { type: "text"; value: string }
  | { type: "cancel" };

let initialized = false;
/** Whether a response queue is present (even when malformed, so we fail closed instead of prompting). */
let active = false;
let entries: ResponseEntry[] = [];
let cursor = 0;
let initError: PromptQueueError | null = null;

function validateEntry(entry: unknown, index: number): ResponseEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new PromptQueueError(`${ENV_NAME}[${index}] must be an object.`);
  }
  const e = entry as Record<string, unknown>;
  if (e.type === "cancel") return { type: "cancel" };
  if (e.type === "select") {
    if (typeof e.value !== "string") {
      throw new PromptQueueError(`${ENV_NAME}[${index}] select "value" must be a string.`);
    }
    return { type: "select", value: e.value };
  }
  if (e.type === "confirm") {
    if (typeof e.value !== "boolean") {
      throw new PromptQueueError(`${ENV_NAME}[${index}] confirm "value" must be a boolean.`);
    }
    return { type: "confirm", value: e.value };
  }
  if (e.type === "text") {
    if (typeof e.value !== "string") {
      throw new PromptQueueError(`${ENV_NAME}[${index}] text "value" must be a string.`);
    }
    return { type: "text", value: e.value };
  }
  throw new PromptQueueError(`${ENV_NAME}[${index}] has unknown type ${JSON.stringify(e.type)}.`);
}

/** Parse the queue once. A present-but-malformed queue stays active with a stored error (fail closed). */
function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  const raw = isTestMode() ? process.env[ENV_NAME] : undefined;
  if (raw === undefined) return;
  active = true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    initError = new PromptQueueError(`${ENV_NAME} is not valid JSON.`);
    return;
  }
  if (!Array.isArray(parsed)) {
    initError = new PromptQueueError(`${ENV_NAME} must be a JSON array.`);
    return;
  }
  try {
    entries = parsed.map((entry, index) => validateEntry(entry, index));
  } catch (error) {
    initError = error instanceof PromptQueueError ? error : new PromptQueueError(String(error));
  }
}

/** True when a response queue is configured; interactive flows use it in place of TTY detection. */
export function promptQueueActive(): boolean {
  ensureInit();
  return active;
}

type Consumed =
  | { injected: false }
  | { injected: true; cancelled: true }
  | { injected: true; cancelled: false; value: string | boolean };

/** Consume the next queued response for a prompt of the given kind, or defer to a real prompt. */
function consume(kind: PromptType): Consumed {
  ensureInit();
  if (!active) return { injected: false };
  if (initError) throw initError;
  if (cursor >= entries.length) {
    throw new PromptQueueError(`${ENV_NAME} is exhausted: a "${kind}" prompt was requested but no response remains.`);
  }
  const entry = entries[cursor++];
  if (entry.type === "cancel") return { injected: true, cancelled: true };
  if (entry.type !== kind) {
    throw new PromptQueueError(
      `${ENV_NAME}[${cursor - 1}] is a "${entry.type}" response but a "${kind}" prompt was requested.`,
    );
  }
  return { injected: true, cancelled: false, value: entry.value };
}

/** Fail closed if any queued responses are left unconsumed when a command completes. */
export function assertPromptQueueDrained(): void {
  ensureInit();
  if (!active) return;
  if (initError) throw initError;
  const remaining = entries.length - cursor;
  if (remaining > 0) {
    throw new PromptQueueError(`${ENV_NAME} has ${remaining} unconsumed response(s) at command completion.`);
  }
}

/** A select prompt guarded by the response queue; returns the value or a cancel symbol. */
export async function guardedSelect<Value>(
  options: Parameters<typeof clackSelect<Value>>[0],
): Promise<Value | symbol> {
  const injected = consume("select");
  if (injected.injected) {
    return injected.cancelled ? PROMPT_CANCEL : (injected.value as Value);
  }
  return clackSelect<Value>(options);
}

/** A confirm prompt guarded by the response queue; returns the boolean or a cancel symbol. */
export async function guardedConfirm(
  options: Parameters<typeof clackConfirm>[0],
): Promise<boolean | symbol> {
  const injected = consume("confirm");
  if (injected.injected) {
    return injected.cancelled ? PROMPT_CANCEL : (injected.value as boolean);
  }
  return clackConfirm(options);
}

/** A text prompt guarded by the response queue; returns the value or a cancel symbol. */
export async function guardedText(
  options: Parameters<typeof clackText>[0],
): Promise<string | symbol> {
  const injected = consume("text");
  if (injected.injected) {
    return injected.cancelled ? PROMPT_CANCEL : (injected.value as string);
  }
  return clackText(options);
}

/** Reset queue state; test-only hook for in-process reuse (the CLI parses env once per process). */
export function __resetPromptQueueForTests(): void {
  initialized = false;
  active = false;
  entries = [];
  cursor = 0;
  initError = null;
}
