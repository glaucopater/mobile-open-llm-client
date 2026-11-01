/**
 * Dialect adapters.
 *
 * Each descriptor is turned into an AI SDK language model. `expo/fetch` is
 * injected explicitly: React Native's bundled fetch buffers the whole response,
 * so streaming needs Expo's streaming-capable fetch.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { getFetchImplementation } from './http';
import { resolvedBaseUrl, type ModelDescriptor } from './model';
import { CLIENT_USER_AGENT, conversationSessionId, needsSessionHeader, SESSION_HEADER } from './session';

/**
 * Extra request headers: the profile's own, plus what a gateway demands.
 *
 * The vendor packages merge these into every request, and the credential header
 * is added by them on top, so nothing here has to know about auth.
 */
export function requestHeaders(model: ModelDescriptor): Record<string, string> {
  const headers: Record<string, string> = { ...model.headers };

  if (needsSessionHeader(resolvedBaseUrl(model))) {
    headers[SESSION_HEADER] ??= conversationSessionId();
    headers['User-Agent'] ??= CLIENT_USER_AGENT;
  }

  return headers;
}

/**
 * Resolves a descriptor into a model instance.
 *
 * Anthropic and Gemini need their own provider packages because their request
 * shapes (message roles, tool blocks, system placement) differ from OpenAI's.
 * The return type is inferred so `wrapLanguageModel` sees a concrete spec
 * version rather than the `LanguageModel` alias (which also allows model-id strings).
 */
export function createLanguageModel(model: ModelDescriptor, apiKey?: string) {
  const baseURL = resolvedBaseUrl(model);
  const fetch = getFetchImplementation();
  const headers = requestHeaders(model);

  switch (model.dialect) {
    case 'openai-chat':
      return createOpenAI({
        baseURL,
        apiKey,
        headers,
        fetch,
      }).chat(model.modelId);

    case 'openai-responses':
      return createOpenAI({
        baseURL,
        apiKey,
        headers,
        fetch,
      }).responses(model.modelId);

    case 'anthropic-messages':
      return createAnthropic({
        baseURL,
        apiKey,
        headers,
        fetch,
      }).messages(model.modelId);

    case 'gemini-generate-content':
      return createGoogleGenerativeAI({
        baseURL,
        apiKey,
        headers,
        fetch,
      })(model.modelId);

    case 'openai-compatible':
      // Ollama, llama.cpp server, LM Studio, vLLM, and any other server that
      // speaks OpenAI Chat Completions.
      return createOpenAICompatible({
        name: model.id.split(':')[0] ?? 'local',
        baseURL,
        apiKey,
        headers,
        fetch,
      }).chatModel(model.modelId);
  }
}
