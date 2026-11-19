import { slackAdminApi, type ProvisioningContext } from "../channels/slack-provisioning.js";
import { secretBoxFromEnv } from "../core/secrets.js";
import { createDb } from "../db/client.js";

/** Provisioning context for command-line scripts. Needs DATABASE_URL, SECRETS_KEY and PUBLIC_URL. */
export function scriptProvisioning(): ProvisioningContext & { close: () => Promise<void> } {
  const baseUrl = process.env.PUBLIC_URL;
  if (!baseUrl) throw new Error("PUBLIC_URL is not set (the public HTTPS address of this server)");
  const { db, close } = createDb();
  return { db, api: slackAdminApi(), box: secretBoxFromEnv(), baseUrl, close };
}
