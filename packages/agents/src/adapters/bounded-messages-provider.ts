import { z } from 'zod';

export type BoundedMessagesProvider = 'anthropic' | 'deepseek';
const count = z.number().int().nonnegative().safe();
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const anthropicMessage = z.object({ id: identifier, type: z.literal('message'), role: z.literal('assistant'), model: z.string(),
  stop_reason: z.enum(['end_turn', 'max_tokens', 'stop_sequence', 'refusal']),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() }).passthrough()).min(1),
  usage: z.object({ input_tokens: count, output_tokens: count, cache_creation_input_tokens: count.optional(), cache_read_input_tokens: count.optional() }).passthrough(),
}).passthrough();
const deepseekMessage = z.object({ id: identifier, object: z.literal('chat.completion'), model: z.string(),
  choices: z.array(z.object({ index: z.literal(0), finish_reason: z.enum(['stop', 'length', 'content_filter', 'insufficient_system_resource', 'aborted']),
    message: z.object({ role: z.literal('assistant'), content: z.string().nullable(), reasoning_content: z.string().nullable().optional(),
      tool_calls: z.array(z.unknown()).max(0).nullable().optional(), function_call: z.null().optional() }).passthrough() }).passthrough()).length(1),
  usage: z.object({ prompt_tokens: count, completion_tokens: count }).passthrough(),
}).passthrough();
const errorBody = z.object({ error: z.object({ type: z.string().min(1), message: z.string() }).passthrough() }).passthrough();

export interface BoundedProviderResponse {
  id: string; text: string | null; complete: boolean; tokensIn: number; tokensOut: number;
}
export interface BoundedProviderProfile {
  provider: BoundedMessagesProvider;
  endpoint: string;
  credentialName: string;
  headers: (apiKey: string) => Record<string, string>;
  request: (input: { model: string; system: string; user: string; maxTokens: number }) => string;
  response: (raw: string, model: string) => BoundedProviderResponse;
  rejected: (status: number, raw: string) => boolean;
}

/** Owner-selected endpoint, never a task/RPC parameter. Credentials must not be
 * forwarded by redirects. A custom endpoint must obey the same no-tools API
 * contract; a generic agent gateway is outside this profile's stop guarantee. */
export function createBoundedProvider(provider: BoundedMessagesProvider = 'anthropic', baseUrl?: string): Readonly<BoundedProviderProfile> {
  if (provider !== 'anthropic' && provider !== 'deepseek') throw Error('BOUNDED_PROVIDER_INVALID');
  if (provider === 'anthropic' && baseUrl !== undefined) throw Error('BOUNDED_BASE_URL_UNSUPPORTED');
  let endpoint = 'https://api.anthropic.com/v1/messages';
  if (provider === 'deepseek') {
    try {
      const base = new URL(baseUrl ?? 'https://api.deepseek.com');
      const local = base.hostname === 'localhost' || base.hostname === '127.0.0.1' || base.hostname === '[::1]';
      if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) || base.username || base.password || base.search || base.hash
        || (baseUrl !== undefined && (baseUrl.length > 2048 || /[?#\s\x00-\x1f\x7f]/.test(baseUrl)))) throw Error();
      endpoint = `${base.href.replace(/\/+$/, '')}/chat/completions`;
    } catch { throw Error('BOUNDED_BASE_URL_INVALID'); }
  }
  return Object.freeze({ provider, endpoint, credentialName: provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'ANTHROPIC_API_KEY',
    headers: (apiKey: string) => provider === 'deepseek'
      ? { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }
      : { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    request: ({ model, system, user, maxTokens }: { model: string; system: string; user: string; maxTokens: number }) => JSON.stringify(provider === 'deepseek'
      ? { model, max_tokens: maxTokens, stream: false, thinking: { type: 'disabled' }, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }
      : { model, max_tokens: maxTokens, stream: false, system, messages: [{ role: 'user', content: user }] }),
    response: (raw: string, model: string): BoundedProviderResponse => {
      if (provider === 'deepseek') {
        const value = deepseekMessage.parse(JSON.parse(raw));
        if (value.model !== model) throw Error('BOUNDED_MODEL_MISMATCH');
        const choice = value.choices[0]!;
        return { id: value.id, text: choice.message.content, complete: choice.finish_reason === 'stop',
          // prompt_tokens already includes cache hits; reasoning tokens are part
          // of completion_tokens. Do not add either again.
          tokensIn: value.usage.prompt_tokens, tokensOut: value.usage.completion_tokens };
      }
      const value = anthropicMessage.parse(JSON.parse(raw));
      if (value.model !== model) throw Error('BOUNDED_MODEL_MISMATCH');
      const tokensIn = value.usage.input_tokens + (value.usage.cache_creation_input_tokens ?? 0) + (value.usage.cache_read_input_tokens ?? 0);
      if (!Number.isSafeInteger(tokensIn)) throw Error('BOUNDED_USAGE_INVALID');
      return { id: value.id, text: value.content.map(block => block.text).join(''), complete: value.stop_reason === 'end_turn',
        tokensIn, tokensOut: value.usage.output_tokens };
    },
    rejected: (status: number, raw: string): boolean => {
      const value: unknown = JSON.parse(raw);
      const parsed = errorBody.safeParse(value);
      if (!parsed.success) return false;
      // DeepSeek documents these statuses as request format/auth/balance/rate
      // rejection, but does not promise a closed list of error.type strings.
      if (provider === 'deepseek') return [400, 401, 402, 422, 429].includes(status);
      const types: Record<number, string> = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error',
        404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error' };
      return (value as { type?: unknown }).type === 'error' && types[status] === parsed.data.error.type;
    },
  });
}
