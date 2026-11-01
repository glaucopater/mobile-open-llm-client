/**
 * Model discovery for a server that speaks the OpenAI surface.
 *
 * A LAN server's model list is whatever is loaded on that machine, so it cannot
 * come from the generated catalog. `GET {base}/models` is the OpenAI-compatible
 * listing (Ollama, llama.cpp server, LM Studio, vLLM all answer it); Ollama's
 * native `/api/tags` shape is accepted too. Requests go through the same
 * `expo/fetch` seam the agent uses, so cleartext HTTP and streaming behave the
 * same as a chat request.
 */
import { getFetchImplementation } from './http';
import { DEFAULT_CAPABILITIES, normalizeBaseUrl, type ProviderModel } from './model';

/** A model listing is small; it must not hang the settings screen. */
export const MODEL_LIST_TIMEOUT_MS = 15_000;

interface ListedModel {
  id?: string;
  name?: string;
  object?: string;
}

interface ListResponse {
  data?: ListedModel[];
  models?: ListedModel[];
}

/** Turns either response shape into provider models, dropping empty ids. */
export function parseModelList(body: ListResponse): ProviderModel[] {
  const rows = body.data ?? body.models ?? [];
  const seen = new Set<string>();
  const models: ProviderModel[] = [];

  for (const row of rows) {
    const modelId = (row?.id ?? row?.name ?? '').trim();

    if (modelId.length === 0 || seen.has(modelId)) {
      continue;
    }

    seen.add(modelId);
    models.push({
      modelId,
      label: modelId,
      // The listing carries no limits, so the guard budgets against its default.
      capabilities: { ...DEFAULT_CAPABILITIES },
      added: true,
    });
  }

  return models;
}

export interface ListModelsOptions {
  /** Credential for servers that need one; sent as `Authorization: Bearer`. */
  apiKey?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

/**
 * Reads a server's model list. The caller decides what to do with a failure —
 * Settings shows the message rather than silently leaving the list empty.
 */
export async function listServerModels(
  baseUrl: string,
  options: ListModelsOptions = {},
): Promise<ProviderModel[]> {
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MODEL_LIST_TIMEOUT_MS);

  if (options.abortSignal !== undefined) {
    if (options.abortSignal.aborted) {
      controller.abort();
    } else {
      options.abortSignal.addEventListener('abort', () => controller.abort());
    }
  }

  try {
    const response = await getFetchImplementation()(url, {
      method: 'GET',
      headers: options.apiKey !== undefined && options.apiKey.length > 0
        ? { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json' }
        : { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${url} answered HTTP ${response.status}`);
    }

    return parseModelList((await response.json()) as ListResponse);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${url} did not answer within ${options.timeoutMs ?? MODEL_LIST_TIMEOUT_MS}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}
