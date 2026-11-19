/**
 * Entry point for every inbound message, from any channel:
 * route to agent → identify sender → authorize → record → queue a task
 * (or answer as a receptionist).
 */
import { and, eq } from "drizzle-orm";
import type { InboundEnvelope } from "../channels/types.js";
import { authorizeRequest } from "../core/access.js";
import { resolveCaller } from "../core/identity.js";
import { agentChannels, conversations, messages, tasks } from "../db/schema.js";
import { audit } from "./audit.js";
import { contactFor, loadAgent } from "./lookup.js";
import { runTask } from "./runner.js";
import type { EngineDeps } from "./types.js";

export type InboundResult =
  | { kind: "ignored"; reason: "unknown_agent_address" }
  | { kind: "rejected"; reason: "agent_inactive" }
  | { kind: "receptionist"; reason: "unknown_sender" | "no_access" }
  | { kind: "task"; taskId: string };

export async function handleInbound(deps: EngineDeps, env: InboundEnvelope): Promise<InboundResult> {
  const { db } = deps;

  // 1. Which agent was addressed?
  const [channelRow] = await db
    .select()
    .from(agentChannels)
    .where(
      and(
        eq(agentChannels.channel, env.channel),
        eq(agentChannels.address, env.agentAddress),
        eq(agentChannels.enabled, true),
      ),
    )
    .limit(1);
  if (!channelRow) return { kind: "ignored", reason: "unknown_agent_address" };

  const agent = await loadAgent(db, channelRow.agentId);
  if (agent.orgId !== env.orgId) return { kind: "ignored", reason: "unknown_agent_address" };

  // 2. Who is asking, and 3. may they?
  const caller = await resolveCaller(db, {
    orgId: env.orgId,
    channel: env.channel,
    handle: env.senderHandle,
    proof: env.proof,
  });
  const decision = authorizeRequest(agent, agent.grants, caller, deps.now?.());

  // 4. Record the conversation and message whatever the decision.
  await db
    .insert(conversations)
    .values({ agentId: agent.id, channel: env.channel, threadRef: env.threadRef, startedById: caller?.id ?? null })
    .onConflictDoNothing();
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.agentId, agent.id),
        eq(conversations.channel, env.channel),
        eq(conversations.threadRef, env.threadRef),
      ),
    );
  await db.insert(messages).values({
    conversationId: conversation!.id,
    direction: "inbound",
    senderPersonId: caller?.id ?? null,
    senderHandle: env.senderHandle,
    body: env.text,
    raw: env.raw as object,
  });

  await audit(db, {
    orgId: agent.orgId,
    agentId: agent.id,
    actorType: caller ? "person" : "system",
    actorId: caller?.id ?? env.senderHandle,
    action: "request.received",
    detail: { channel: env.channel, decision: decision.kind, trust: caller?.trust ?? null },
  });

  const reply = async (text: string) => {
    await deps.notify.send({ channel: env.channel, target: env.replyTarget, threadRef: env.threadRef, text });
    await db.insert(messages).values({ conversationId: conversation!.id, direction: "outbound", body: text });
  };

  if (decision.kind === "reject") {
    await reply(`${agent.name} is not taking requests right now.`);
    return { kind: "rejected", reason: decision.reason };
  }

  if (decision.kind === "receptionist") {
    const managerName = agent.manager?.name ?? "an admin";
    if (decision.reason === "unknown_sender") {
      await reply(
        `Hi, I'm ${agent.name} (${agent.role}). I can't help with requests from senders I don't recognize, ` +
          `so I've passed your message to ${managerName}.`,
      );
      if (agent.managerId) {
        const contact = await contactFor(db, agent.managerId);
        if (contact) {
          await deps.notify.send({
            ...contact,
            text: `${agent.name} got a message from an unknown sender (${env.channel}: ${env.senderHandle}):\n\n${env.text}`,
          });
        }
      }
    } else {
      await reply(`You don't have access to work with ${agent.name} yet. ${managerName} can give you access.`);
    }
    return { kind: "receptionist", reason: decision.reason };
  }

  // 5. Create the task and queue it.
  const [task] = await db
    .insert(tasks)
    .values({
      agentId: agent.id,
      requestedById: caller!.id,
      source: "channel",
      conversationId: conversation!.id,
      input: env.text,
      callerTrust: caller!.trust,
      replyChannel: env.channel,
      replyTarget: env.replyTarget,
    })
    .returning();

  const enqueue = deps.enqueue ?? ((id: string) => runTask(deps, id).then(() => undefined));
  await enqueue(task!.id);
  return { kind: "task", taskId: task!.id };
}
