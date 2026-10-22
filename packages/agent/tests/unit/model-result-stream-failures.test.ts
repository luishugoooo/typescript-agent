import { OpenRouterCore } from '@openrouter/sdk/core';
import type * as models from '@openrouter/sdk/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { callModel } from '../../src/inner-loop/call-model.js';
import { tool } from '../../src/lib/tool.js';

const mockBetaResponsesSend = vi.hoisted(() => vi.fn());

vi.mock('@openrouter/sdk/funcs/betaResponsesSend', () => ({
  betaResponsesSend: mockBetaResponsesSend,
}));

function toolResponse(): models.OpenResponsesResult {
  return {
    id: 'tool-round',
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    completedAt: 0,
    output: [
      {
        id: 'tool-item',
        type: 'function_call',
        callId: 'tool-call',
        name: 'echo',
        arguments: '{}',
        status: 'completed',
      },
    ],
    error: null,
    incompleteDetails: null,
    temperature: null,
    topP: null,
    presencePenalty: null,
    frequencyPenalty: null,
    metadata: null,
    instructions: null,
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: false,
  } as models.OpenResponsesResult;
}

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    // Drain the public iterator, as an application would.
  }
}

function fixture(afterTool: boolean) {
  const controller = new AbortController();
  const error = new Error('stream interrupted');
  const execute = vi.fn(() => 'ok');
  let fail = () => {
    throw new Error('Stream not started');
  };
  let ready!: () => void;
  const streamReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let requests = 0;
  mockBetaResponsesSend.mockImplementation(async () => {
    if (afterTool && requests++ === 0) {
      return {
        ok: true,
        value: toolResponse(),
      };
    }
    return {
      ok: true,
      value: new ReadableStream<models.StreamEvents>({
        start(stream) {
          fail = () => stream.error(error);
          controller.signal.addEventListener(
            'abort',
            () => stream.error(controller.signal.reason),
            {
              once: true,
            },
          );
          ready();
        },
      }),
    };
  });
  const result = callModel(
    new OpenRouterCore({
      apiKey: 'fixture',
    }),
    {
      model: 'test-model',
      input: 'test',
      signal: controller.signal,
      tools: [
        tool({
          name: 'echo',
          inputSchema: z.object({}),
          execute,
        }),
      ],
    },
  );
  return {
    result,
    error,
    execute,
    streamReady,
    disconnect: () => fail(),
    cancel: () => controller.abort(error),
  };
}

const streamMethods = [
  'getFullResponsesStream',
  'getItemsStream',
  'getTextStream',
  'getReasoningStream',
  'getToolStream',
] as const;

describe('ModelResult streaming failures', () => {
  beforeEach(() => mockBetaResponsesSend.mockReset());

  for (const method of streamMethods) {
    for (const afterTool of [
      false,
      true,
    ]) {
      for (const failure of [
        'disconnect',
        'cancel',
      ] as const) {
        it(`${method} reports ${failure} ${afterTool ? 'after' : 'before'} a tool without an unhandled rejection`, async () => {
          const test = fixture(afterTool);
          const rejected = expect(consume(test.result[method]())).rejects.toBe(test.error);
          await test.streamReady;
          test[failure]();
          await rejected;
          await expect(test.result.getResponse()).rejects.toBe(test.error);
          expect(test.execute).toHaveBeenCalledTimes(afterTool ? 1 : 0);
          // Let detached tasks settle: Vitest also fails on unhandled rejections.
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    }
  }

  it('does not orphan a rejecting execution when a consumer stops early', async () => {
    const test = fixture(false);
    const stream = test.result.getFullResponsesStream();
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        type: 'turn.start',
      },
    });
    await stream.return(undefined);
    test.disconnect();
    await expect(test.result.getResponse()).rejects.toBe(test.error);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('delivers the same failure to concurrent and late consumers', async () => {
    const test = fixture(false);
    const first = expect(consume(test.result.getFullResponsesStream())).rejects.toBe(test.error);
    const second = expect(consume(test.result.getTextStream())).rejects.toBe(test.error);
    await test.streamReady;
    test.disconnect();
    await Promise.all([
      first,
      second,
    ]);
    await expect(consume(test.result.getItemsStream())).rejects.toBe(test.error);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
