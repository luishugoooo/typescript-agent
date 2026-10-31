import { HTTPClient } from '@openrouter/sdk/lib/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { createInitialState } from '../../src/lib/conversation-state.js';
import { stepCountIs } from '../../src/lib/stop-conditions.js';
import { tool } from '../../src/lib/tool.js';
import type { ConversationState } from '../../src/lib/tool-types.js';
import { OpenRouter } from '../../src/openrouter.js';

afterEach(() => vi.useRealTimers());

let sequence = 0;
function response(output: unknown[], status = 'completed', error: unknown = null) {
  return {
    id: `gen-${++sequence}`,
    object: 'response',
    created_at: 0,
    completed_at: 0,
    status,
    error,
    incomplete_details: null,
    model: 'test/model',
    output,
    instructions: null,
    max_output_tokens: null,
    metadata: null,
    parallel_tool_calls: true,
    presence_penalty: null,
    frequency_penalty: null,
    temperature: null,
    top_p: null,
    tool_choice: 'auto',
    tools: [],
    usage: {
      input_tokens: 10,
      input_tokens_details: {
        cached_tokens: 0,
      },
      output_tokens: 2,
      output_tokens_details: {
        reasoning_tokens: 0,
      },
      total_tokens: 12,
    },
  };
}
function answer(text = 'Done') {
  return response([
    {
      id: `msg-${++sequence}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text,
          annotations: [],
        },
      ],
    },
  ]);
}
function call() {
  return response([
    {
      id: `fc-${++sequence}`,
      type: 'function_call',
      call_id: `call-${sequence}`,
      name: 'probe',
      arguments: '{}',
      status: 'completed',
    },
  ]);
}
function failed(code = 'server_error') {
  return response([], 'failed', {
    code,
    message: 'Provider unavailable',
  });
}
function clientFor(bodies: Array<Response | Record<string, unknown>>, transportRetry = false) {
  const requests: Array<Record<string, unknown>> = [];
  const client = new OpenRouter({
    apiKey: 'test-only',
    retryConfig: transportRetry
      ? {
          strategy: 'backoff',
          backoff: {
            initialInterval: 1,
            maxInterval: 1,
            exponent: 1.5,
            maxElapsedTime: 100,
          },
        }
      : {
          strategy: 'none',
        },
    httpClient: new HTTPClient({
      fetcher: async (input, init) => {
        requests.push(JSON.parse(await new Request(input, init).text()));
        const next = bodies.shift();
        if (!next) {
          throw new Error('Unexpected request');
        }
        return next instanceof Response ? next : Response.json(next);
      },
    }),
  });
  return {
    client,
    requests,
  };
}

describe('non-streaming model-step recovery', () => {
  it('delivers complete messages and tool progress without replaying tools or duplicating fresh input', async () => {
    const { client, requests } = clientFor([
      call(),
      failed(),
      answer(),
    ]);
    const execute = vi.fn(() => 'saved tool result');
    let state = createInitialState('test-session');
    const result = client.callModel({
      model: 'test/model',
      stream: false,
      input: 'current question',
      tools: [
        tool({
          name: 'probe',
          inputSchema: z.object({}),
          execute,
        }),
      ],
      state: {
        load: async () => state,
        save: async (next) => {
          state = next;
        },
      },
    });
    const items = await Array.fromAsync(result.getItemsStream());
    expect(items.map((i) => i.type)).toEqual([
      'function_call',
      'function_call_output',
      'message',
    ]);
    expect(items.every((i) => !('status' in i) || i.status === 'completed')).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.stream === false && !('responseRetries' in r))).toBe(true);
    expect(requests[2]?.input).toEqual(requests[1]?.input);
    expect(JSON.stringify(requests[2]?.input).match(/current question/g)).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain('Provider unavailable');
    expect((await result.getUsage()).modelCalls).toBe(2);
    expect(await result.getText()).toBe('Done');
  });

  it('resets the response retry allowance after each successful model step', async () => {
    const { client, requests } = clientFor([
      failed(),
      call(),
      failed(),
      answer(),
    ]);
    const retries = vi.fn();
    const result = client.callModel({
      model: 'test/model',
      stream: false,
      responseRetries: 1,
      input: 'question',
      onModelRetry: retries,
      tools: [
        tool({
          name: 'probe',
          inputSchema: z.object({}),
          execute: () => 'result',
        }),
      ],
    });
    expect(await result.getText()).toBe('Done');
    expect(requests).toHaveLength(4);
    expect(retries.mock.calls.map(([event]) => event.attempt)).toEqual([
      1,
      1,
    ]);
  });

  it('normalizes and retries error-only JSON returned with HTTP 200', async () => {
    const { client, requests } = clientFor([
      {
        id: 'gen-error-only',
        error: {
          code: 503,
          message: 'Provider unavailable',
        },
      },
      answer(),
    ]);
    const retries = vi.fn();
    const result = client.callModel({
      model: 'test/model',
      stream: false,
      input: 'question',
      onModelRetry: retries,
    });
    expect(await result.getText()).toBe('Done');
    expect(requests).toHaveLength(2);
    expect(retries.mock.calls[0]?.[0].error).toMatchObject({
      responseId: 'gen-error-only',
      code: '503',
      recoverable: true,
    });
  });

  it('bounds retries and retains the final provider error and generation ID', async () => {
    const last = failed();
    const { client, requests } = clientFor([
      failed(),
      failed(),
      last,
    ]);
    const result = client.callModel({
      model: 'test/model',
      stream: false,
      input: 'question',
    });
    await expect(result.getResponse()).rejects.toMatchObject({
      name: 'ModelRequestError',
      message: 'Provider unavailable',
      code: 'server_error',
      responseId: last.id,
      recoverable: true,
    });
    expect(requests).toHaveLength(3);
  });

  it.each([
    'invalid_prompt',
    'image_content_policy_violation',
  ])('does not retry permanent response errors: %s', async (code) => {
    const { client, requests } = clientFor([
      failed(code),
    ]);
    await expect(
      client
        .callModel({
          model: 'test/model',
          stream: false,
          input: 'question',
        })
        .getText(),
    ).rejects.toMatchObject({
      code,
      recoverable: false,
    });
    expect(requests).toHaveLength(1);
  });

  it('does not restart HTTP retries after the transport client gives up', async () => {
    const { client, requests } = clientFor([
      Response.json(
        {
          error: {
            code: 503,
            message: 'HTTP unavailable',
          },
        },
        {
          status: 503,
        },
      ),
    ]);
    await expect(
      client
        .callModel({
          model: 'test/model',
          stream: false,
          input: 'question',
        })
        .getText(),
    ).rejects.toMatchObject({
      details: {
        source: 'http',
      },
      status: 503,
      recoverable: true,
    });
    expect(requests).toHaveLength(1);
  });

  it('leaves HTTP throttling recovery to the client SDK', async () => {
    const { client, requests } = clientFor(
      [
        Response.json(
          {
            error: {
              code: 429,
              message: 'Rate limited',
            },
          },
          {
            status: 429,
          },
        ),
        answer(),
      ],
      true,
    );
    const onModelRetry = vi.fn();
    expect(
      await client
        .callModel({
          model: 'test/model',
          stream: false,
          input: 'question',
          onModelRetry,
        })
        .getText(),
    ).toBe('Done');
    expect(requests).toHaveLength(2);
    expect(onModelRetry).not.toHaveBeenCalled();
  });

  it('does not retry malformed successful JSON as an HTTP or provider failure', async () => {
    const { client, requests } = clientFor([
      new Response('{broken', {
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    ]);
    await expect(
      client
        .callModel({
          model: 'test/model',
          stream: false,
          input: 'question',
        })
        .getText(),
    ).rejects.toMatchObject({
      name: 'ModelRequestError',
      recoverable: false,
    });
    expect(requests).toHaveLength(1);
  });

  it('keeps malformed HTTP error bodies in the transport retry layer', async () => {
    const { client, requests } = clientFor([
      Response.json(
        {
          error: {
            code: 'server_error',
            message: 'Malformed HTTP error',
          },
        },
        {
          status: 503,
        },
      ),
    ]);
    await expect(
      client
        .callModel({
          model: 'test/model',
          stream: false,
          input: 'question',
        })
        .getText(),
    ).rejects.toMatchObject({
      details: {
        source: 'http',
      },
      status: 503,
    });
    expect(requests).toHaveLength(1);
  });

  it('never executes output from a failed response', async () => {
    const apparentCall = call();
    const { client } = clientFor([
      {
        ...apparentCall,
        status: 'failed',
        error: {
          code: 'server_error',
          message: 'Failed',
        },
      },
      answer(),
    ]);
    const execute = vi.fn(() => 'must not run');
    const result = client.callModel({
      model: 'test/model',
      stream: false,
      input: 'question',
      tools: [
        tool({
          name: 'probe',
          inputSchema: z.object({}),
          execute,
        }),
      ],
    });
    const items = await Array.fromAsync(result.getItemsStream());
    expect(items.map((i) => i.type)).toEqual([
      'message',
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops backoff on cancellation without another request', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled by caller');
    const { client, requests } = clientFor([
      failed(),
    ]);
    const result = client.callModel({
      model: 'test/model',
      stream: false,
      input: 'question',
      signal: controller.signal,
      onModelRetry: () => controller.abort(reason),
    });
    await expect(result.getText()).rejects.toBe(reason);
    expect(requests).toHaveLength(1);
  });

  it('uses one model-request deadline across response retries, including backoff', async () => {
    const { client, requests } = clientFor([
      failed(),
    ]);
    const result = client.callModel(
      {
        model: 'test/model',
        stream: false,
        input: 'question',
      },
      {
        timeoutMs: 30,
      },
    );
    await expect(result.getText()).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(requests).toHaveLength(1);
  });

  it('preserves non-streaming transport and completed items through approval resume', async () => {
    const { client, requests } = clientFor([
      call(),
      answer(),
    ]);
    const execute = vi.fn(() => 'approved result');
    const probe = tool({
      name: 'probe',
      inputSchema: z.object({}),
      requireApproval: true,
      execute,
    });
    let state: ConversationState = createInitialState('approval-session');
    const accessor = {
      load: async () => state,
      save: async (next: ConversationState) => {
        state = next;
      },
    };
    const paused = client.callModel({
      model: 'test/model',
      stream: false,
      input: 'question',
      tools: [
        probe,
      ],
      state: accessor,
    });
    await Array.fromAsync(paused.getItemsStream());
    expect(state.status).toBe('awaiting_approval');
    expect(execute).not.toHaveBeenCalled();
    const ids = state.pendingToolCalls!.map((c) => c.id);
    const resumed = client.callModel({
      model: 'test/model',
      stream: false,
      input: [],
      tools: [
        probe,
      ],
      state: accessor,
      approveToolCalls: ids,
    });
    const items = await Array.fromAsync(resumed.getItemsStream());
    expect(items.some((i) => i.type === 'message')).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests.every((r) => r.stream === false)).toBe(true);
    expect(await resumed.getText()).toBe('Done');
  });

  it.each([
    'forced',
    'empty-final',
  ])('preserves complete-response transport for %s final answers', async (mode) => {
    const { client, requests } = clientFor([
      call(),
      mode === 'forced' ? failed() : response([]),
      answer(),
    ]);
    const execute = vi.fn(() => 'completed once');
    const result = client.callModel({
      model: 'test/model',
      stream: false,
      input: 'question',
      tools: [
        tool({
          name: 'probe',
          inputSchema: z.object({}),
          execute,
        }),
      ],
      ...(mode === 'forced'
        ? {
            stopWhen: stepCountIs(0),
          }
        : {}),
    });
    const items = await Array.fromAsync(result.getItemsStream());
    expect(items.some((i) => i.type === 'message')).toBe(true);
    expect(await result.getText()).toBe('Done');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.stream === false)).toBe(true);
    expect(requests.at(-1)?.tool_choice).toBe('none');
  });

  it('delivers complete output for no-tool runs and concurrent or late consumers', async () => {
    const { client } = clientFor([
      answer('complete answer'),
    ]);
    const result = client.callModel({
      model: 'test/model',
      stream: false,
      input: 'question',
    });
    const [items, text] = await Promise.all([
      Array.fromAsync(result.getItemsStream()),
      result.getText(),
    ]);
    expect(items).toHaveLength(1);
    expect(text).toBe('complete answer');
    expect(await Array.fromAsync(result.getItemsStream())).toEqual(items);
  });
});
