import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in OpenAI-compatible provider for tests and offline end-to-end runs
 * of the sentence race: it plays a fixed list of tool calls, one per request,
 * picking the step from how many tool results the conversation already holds.
 * It streams like Cerebras and OpenRouter do (reasoning, then the tool call,
 * then usage), after an optional delay that stands in for thinking time.
 */
export interface FakeStep {
  name: string;
  arguments: Record<string, unknown>;
}

export const SENTENCE_SCRIPT: FakeStep[] = [
  { name: 'start_design', arguments: { target_ghz: 5.8, board_w_mm: 24, board_l_mm: 24, substrate: 'FR-4' } },
  { name: 'optimise', arguments: { enable: ['inset'], free: ['patch_l', 'inset_d'], max_solves: 4 } },
  { name: 'confirm', arguments: {} },
  { name: 'finish', arguments: { summary: 'scripted fake provider: one search and a confirm' } },
];

/**
 * The talk-to-it rehearsal: a first request, a long search the person interrupts (run it with --say during that
 * search), a restart on the new request, then the usual close. The script does not read the message; the
 * restart is only accepted because the server handed one over.
 */
export const REPLAN_SCRIPT: FakeStep[] = [
  { name: 'start_design', arguments: { target_ghz: 2.4, board_w_mm: 50, board_l_mm: 50, substrate: 'FR-4' } },
  { name: 'optimise', arguments: { enable: ['inset'], free: ['patch_l', 'inset_d'], max_solves: 12 } },
  ...SENTENCE_SCRIPT,
];

export async function startFakeProvider(options: { script?: FakeStep[]; thinkMs?: number; completionTokens?: number } = {}) {
  const script = options.script ?? SENTENCE_SCRIPT;
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(text);
    requests.push(body);
    const done = (body.messages as Array<{ role: string }>).filter((m) => m.role === 'tool').length;
    await new Promise((r) => setTimeout(r, options.thinkMs ?? 0));
    const usage = { prompt_tokens: 1000, completion_tokens: options.completionTokens ?? 200, completion_tokens_details: { reasoning_tokens: 150 } };
    if (done >= script.length) {
      // The script is played: answer in text, which ends the harness's turn, as a real model does after finish.
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }], usage }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    const step = script[done];
    // Harnesses prefix MCP tools with the server name (OpenClaw: noburf__start_design): call the tool as offered.
    const offered = ((body.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);
    const name = offered.find((n) => n === step.name || n.endsWith(`__${step.name}`)) ?? step.name;
    const toolCall = { id: `call_${done}`, type: 'function', function: { name, arguments: JSON.stringify(step.arguments) } };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }], usage }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Thinking about the antenna.' } }] });
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall, function: { name, arguments: '' } }] } }] });
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: toolCall.function.arguments } }] } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    send({ choices: [], usage });
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
