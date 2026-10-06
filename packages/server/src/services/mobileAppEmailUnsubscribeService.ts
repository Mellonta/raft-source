import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { newsletterAudienceContacts, users } from "../db/schema";
import { suppressScheduledComputerMobileAppEmailJourneys } from "./computerMobileAppEmailJourneyService";
import { normalizeEmail } from "./emailNormalization";

export const MOBILE_APP_EMAIL_AUDIENCE_ID = "mobile-app-lifecycle";

export async function unsubscribeUserFromMobileAppEmail(userId: string): Promise<{
  recorded: boolean;
  canceled: number;
}> {
  const db = getDb();
  const [user] = await db.select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.email?.trim()) return { recorded: false, canceled: 0 };

  const email = normalizeEmail(user.email);
  const now = new Date();
  await db.insert(newsletterAudienceContacts).values({
    userId,
    email,
    audienceId: MOBILE_APP_EMAIL_AUDIENCE_ID,
    status: "unsubscribed",
    optedOutAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [newsletterAudienceContacts.audienceId, newsletterAudienceContacts.email],
    set: {
      userId,
      status: "unsubscribed",
      optedOutAt: now,
      lastSyncError: null,
      updatedAt: now,
    },
  });

  const { canceled } = await suppressScheduledComputerMobileAppEmailJourneys({
    userId,
    email,
    status: "unsubscribed",
  });
  return { recorded: true, canceled };
}
