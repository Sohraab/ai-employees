/**
 * Who is this sender? Maps a channel handle (Slack user id, email address,
 * phone number) to a person, and decides how far to trust that mapping.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { people, personIdentities, type Channel } from "../db/schema.js";
import type { Caller, IdentityTrust } from "./access.js";

export function normalizeHandle(channel: Channel, handle: string): string {
  const h = handle.trim();
  switch (channel) {
    case "email":
      return h.toLowerCase();
    case "whatsapp":
    case "phone": {
      // Keep a leading "+" and digits only, e.g. "+49 151 234-5678" -> "+491512345678".
      const digits = h.replace(/[^\d]/g, "");
      return `+${digits}`;
    }
    default:
      return h;
  }
}

/** Channel-level proof that the message really came from that handle. */
export interface SenderProof {
  /** Email: did SPF/DKIM/DMARC pass for the From domain? */
  emailAuthPassed?: boolean;
  /** Slack/WhatsApp/phone: was the inbound webhook signature valid? */
  signatureValid?: boolean;
}

/**
 * Trust needs two things: the identity was verified once (e.g. OTP for a
 * phone number), and this particular message carries channel-level proof.
 */
export function trustFor(channel: Channel, verifiedAt: Date | null, proof: SenderProof): IdentityTrust {
  if (!verifiedAt) return "unverified";
  switch (channel) {
    case "email":
      return proof.emailAuthPassed ? "verified" : "unverified";
    case "slack":
    case "whatsapp":
    case "phone":
    case "web":
      return proof.signatureValid ? "verified" : "unverified";
  }
}

export async function resolveCaller(
  db: Db,
  params: { orgId: string; channel: Channel; handle: string; proof: SenderProof },
): Promise<Caller | null> {
  const handle = normalizeHandle(params.channel, params.handle);
  const rows = await db
    .select({
      id: people.id,
      teamId: people.teamId,
      role: people.role,
      isOrgAdmin: people.isOrgAdmin,
      active: people.active,
      verifiedAt: personIdentities.verifiedAt,
    })
    .from(personIdentities)
    .innerJoin(people, eq(people.id, personIdentities.personId))
    .where(
      and(
        eq(personIdentities.orgId, params.orgId),
        eq(personIdentities.channel, params.channel),
        eq(personIdentities.handle, handle),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || !row.active) return null;
  return {
    id: row.id,
    teamId: row.teamId,
    role: row.role,
    isOrgAdmin: row.isOrgAdmin,
    trust: trustFor(params.channel, row.verifiedAt, params.proof),
  };
}
