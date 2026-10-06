import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { CORS_PREFLIGHT_MAX_AGE_SECONDS } from "../app";
import { getWebCorsOrigins } from "../config/appUrl";

const test = createApiTest();

// task #17: the web app is cross-origin to the API and sends Authorization, so
// every call is preflighted. Without Access-Control-Max-Age the browser keeps a
// preflight for 5s, and most API calls paid an extra OPTIONS round trip.
test("API preflights tell the browser to cache them for 2 hours", async ({ app }) => {
  const origin = getWebCorsOrigins()[0];
  assert.ok(origin, "a web origin is configured for the test app");
  const res = await fetch(`${app.baseUrl}/api/servers`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization,x-server-id",
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), origin);
  assert.equal(res.headers.get("access-control-max-age"), String(CORS_PREFLIGHT_MAX_AGE_SECONDS));
  assert.equal(CORS_PREFLIGHT_MAX_AGE_SECONDS, 7200, "Chrome caps preflight caching at 7200s");
});
