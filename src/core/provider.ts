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

  switch (model.dialect) {
    case 'openai-chat':
      return createOpenAI({
        baseURL,
        apiKey,
        fetch,
      }).chat(model.modelId);

    case 'openai-responses':
      return createOpenAI({
        baseURL,
        apiKey,
        fetch,
      }).responses(model.modelId);

    case 'anthropic-messages':
      return createAnthropic({
        baseURL,
        apiKey,
        fetch,
      }).messages(model.modelId);

    case 'gemini-generate-content':
      return createGoogleGenerativeAI({
        baseURL,
        apiKey,
        fetch,
      })(model.modelId);

    case 'openai-compatible':
      // Ollama, llama.cpp server, LM Studio, vLLM, and any other server that
      // speaks OpenAI Chat Completions.
      return createOpenAICompatible({
        name: model.id.split(':')[0] ?? 'local',
        baseURL,
        apiKey,
        fetch,
      }).chatModel(model.modelId);
  }
}
