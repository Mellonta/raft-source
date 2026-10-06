import { Router, urlencoded, type Response } from "express";
import { mobileAppEmailCopy } from "../services/emailService";
import { unsubscribeUserFromMobileAppEmail } from "../services/mobileAppEmailUnsubscribeService";
import { verifyMobileAppEmailUnsubscribeToken } from "../services/mobileAppEmailUnsubscribeToken";

export const mobileAppEmailUnsubscribeRouter: Router = Router();

mobileAppEmailUnsubscribeRouter.use(urlencoded({ extended: false, limit: "1kb" }));

function setPrivateHtmlHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
}

function page(htmlLang: string, title: string, body: string): string {
  return `<!doctype html>
<html lang="${htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:40px 20px;background:#fffaf0;color:#141111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <main style="box-sizing:border-box;max-width:520px;margin:0 auto;padding:28px;background:#fff;border:2px solid #141111;border-radius:16px;box-shadow:4px 4px 0 #141111;">
    ${body}
  </main>
</body>
</html>`;
}

function invalidLink(res: Response): void {
  const copy = mobileAppEmailCopy().unsubscribePage;
  setPrivateHtmlHeaders(res);
  res.status(400).type("html").send(page(
    copy.htmlLang,
    copy.invalidTitle,
    `<h1 style="margin:0 0 12px;font-size:22px;">${copy.invalidHeading}</h1><p style="margin:0;line-height:1.5;">${copy.invalidBody}</p>`,
  ));
}

mobileAppEmailUnsubscribeRouter.get("/unsubscribe", (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : null;
  const identity = verifyMobileAppEmailUnsubscribeToken(token);
  if (!token || !identity) {
    invalidLink(res);
    return;
  }

  const copy = mobileAppEmailCopy(identity.locale).unsubscribePage;
  const action = `/api/email/mobile-app/unsubscribe?token=${encodeURIComponent(token)}&source=visible`;
  setPrivateHtmlHeaders(res);
  res.type("html").send(page(
    copy.htmlLang,
    copy.confirmationTitle,
    `<h1 style="margin:0 0 12px;font-size:22px;">${copy.confirmationHeading}</h1>
    <p style="margin:0 0 20px;line-height:1.5;">${copy.confirmationBody}</p>
    <form method="post" action="${action}">
      <input type="hidden" name="List-Unsubscribe" value="One-Click">
      <button type="submit" style="cursor:pointer;padding:10px 16px;border:2px solid #141111;border-radius:8px;background:#fe7da8;color:#141111;font:inherit;font-weight:700;box-shadow:2px 2px 0 #141111;">${copy.submit}</button>
    </form>`,
  ));
});

mobileAppEmailUnsubscribeRouter.post("/unsubscribe", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : null;
  const identity = verifyMobileAppEmailUnsubscribeToken(token);
  if (!identity || req.body?.["List-Unsubscribe"] !== "One-Click") {
    invalidLink(res);
    return;
  }

  const copy = mobileAppEmailCopy(identity.locale).unsubscribePage;
  try {
    await unsubscribeUserFromMobileAppEmail(identity.userId);
  } catch (error) {
    console.error("[MobileAppEmail] Unsubscribe failed", error instanceof Error ? error.message : error);
    setPrivateHtmlHeaders(res);
    res.status(503).type("html").send(page(
      copy.htmlLang,
      copy.failureTitle,
      `<h1 style="margin:0 0 12px;font-size:22px;">${copy.failureHeading}</h1><p style="margin:0;line-height:1.5;">${copy.failureBody}</p>`,
    ));
    return;
  }

  setPrivateHtmlHeaders(res);
  if (req.query.source === "visible") {
    res.type("html").send(page(
      copy.htmlLang,
      copy.successTitle,
      `<h1 style="margin:0 0 12px;font-size:22px;">${copy.successHeading}</h1><p style="margin:0;line-height:1.5;">${copy.successBody}</p>`,
    ));
    return;
  }
  // RFC 8058 one-click clients expect the same URL to accept the declared
  // form-encoded POST and return an empty successful response.
  res.status(200).type("text/plain").send("");
});
