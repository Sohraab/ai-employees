/** Sends each outbound message through the adapter for its channel. */
import type { Channel } from "../db/schema.js";
import type { Notifier } from "../engine/types.js";
import type { OutboundMessage } from "./types.js";

export class ChannelNotifier implements Notifier {
  constructor(
    private senders: Partial<Record<Channel, { send(m: OutboundMessage): Promise<void> }>>,
    private log: (msg: string) => void = console.warn,
  ) {}

  async send(message: OutboundMessage): Promise<void> {
    const sender = this.senders[message.channel];
    if (!sender) {
      // Email and WhatsApp adapters come in later phases; don't fail the task over it.
      this.log(`No ${message.channel} adapter configured; dropped message to ${message.target}`);
      return;
    }
    await sender.send(message);
  }
}
