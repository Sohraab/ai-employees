/**
 * Channel adapters turn Slack/email/WhatsApp/phone traffic into one standard
 * envelope and send replies back. The agent never knows which channel it is on
 * beyond `channel`, so adding a channel does not touch agent logic.
 */
import type { Channel } from "../db/schema.js";
import type { SenderProof } from "../core/identity.js";

export interface InboundEnvelope {
  orgId: string;
  channel: Channel;
  /** The agent's address on this channel: Slack bot user id, inbox, number. */
  agentAddress: string;
  /** Sender as the channel reports it, before normalization. */
  senderHandle: string;
  text: string;
  /** Channel-native thread id: Slack thread_ts, email root Message-ID, WhatsApp chat id. */
  threadRef: string;
  /** Where replies go: Slack channel id, sender's email address, phone number. */
  replyTarget: string;
  attachments: { name: string; url: string; mimeType?: string }[];
  proof: SenderProof;
  receivedAt: Date;
  raw: unknown;
}

export interface OutboundMessage {
  /** The AI employee sending it: picks which Slack app / inbox / number it comes from. */
  agentId: string;
  channel: Channel;
  /** Slack channel id, email address, phone number. */
  target: string;
  threadRef?: string;
  text: string;
  /** Optional Approve/Deny buttons (rendered as "reply YES/NO" on text channels). */
  approval?: { approvalId: string; summary: string };
}

export interface ChannelAdapter {
  channel: Channel;
  /** Verify and parse an incoming webhook. Return null for events to ignore. */
  parseInbound(request: { headers: Record<string, string>; body: string }): Promise<InboundEnvelope | null>;
  send(message: OutboundMessage): Promise<void>;
}
