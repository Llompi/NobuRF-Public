import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * What the person says to a running design session, mid-run: a JSON-lines file in the session folder. The race
 * runner (or anything else on the machine) appends; the MCP server reads it, hands new messages to the model with
 * its next tool result, and ends a running search early so the model hears them without waiting for it.
 * A file rather than a socket: OpenClaw starts the MCP server, so the runner has no other line to it.
 */
export interface InboxMessage {
  /** When it was written, ms since the epoch. */
  t: number;
  text: string;
}

export const MAX_MESSAGE_CHARS = 500;

/** At most MAX_MESSAGE_CHARS characters, never cutting an emoji or other surrogate pair in half. */
const clip = (text: string) => Array.from(text).slice(0, MAX_MESSAGE_CHARS).join('');

export function appendToInbox(file: string, text: string): InboxMessage {
  const message = { t: Date.now(), text: clip(text.trim()) };
  if (!message.text) throw new Error('an empty message says nothing');
  writeFileSync(file, JSON.stringify(message) + '\n', { flag: 'a' });
  return message;
}

/** Reads the messages not yet handed over, in order. */
export class InboxReader {
  private handedOver = 0;

  constructor(readonly file: string) {}

  /** The messages written since the last take(), without taking them. */
  peek(): InboxMessage[] {
    return this.read().messages;
  }

  take(): InboxMessage[] {
    const { messages, lines } = this.read();
    this.handedOver = lines;
    return messages;
  }

  private read(): { messages: InboxMessage[]; lines: number } {
    if (!existsSync(this.file)) return { messages: [], lines: this.handedOver };
    // Only whole lines: a writer may be partway through the last one.
    const text = readFileSync(this.file, 'utf8');
    const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
    const messages = lines.slice(this.handedOver).flatMap((line) => {
      try {
        const m = JSON.parse(line);
        return typeof m?.text === 'string' && typeof m?.t === 'number' ? [{ t: m.t, text: clip(m.text) }] : [];
      } catch {
        return []; // not ours: skipped
      }
    });
    return { messages, lines: lines.length };
  }
}
