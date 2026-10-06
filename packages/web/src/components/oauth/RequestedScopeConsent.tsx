import { useIntl } from "react-intl";

import {
  IDENTITY_SCOPE_GROUP_SUMMARY_ID,
  OAUTH_SCOPE_PRESENTATION,
  hasAgentInboundOAuthScope,
  normalizeVisibleOAuthScopes,
  scopeGroupLabelId,
} from "../../lib/oauthScopePresentation";
import type {
  OAuthScopeTier,
} from "../../lib/oauthScopePresentation";

export default function RequestedScopeConsent({
  scopes,
  className = "mt-5",
}: {
  scopes: readonly string[];
  className?: string;
}) {
  const { formatMessage } = useIntl();
  const visibleScopes = normalizeVisibleOAuthScopes(scopes);
  const visibleScopeSet = new Set<string>(visibleScopes);
  const unpresentedScopes = Array<string>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (trimmed && !visibleScopeSet.has(trimmed) && !unpresentedScopes.includes(trimmed)) {
      unpresentedScopes.push(trimmed);
    }
  }
  const grouped: Record<OAuthScopeTier, typeof visibleScopes> = {
    identity: visibleScopes.filter((scope) => OAUTH_SCOPE_PRESENTATION[scope].tier === "identity"),
    agent_directory: visibleScopes.filter((scope) => OAUTH_SCOPE_PRESENTATION[scope].tier === "agent_directory"),
    agent_messaging: visibleScopes.filter((scope) => OAUTH_SCOPE_PRESENTATION[scope].tier === "agent_messaging"),
  };
  const hasAgentInboundRequest = hasAgentInboundOAuthScope(visibleScopes);
  // Use complete messages; clause order differs between languages.
  const requestedAccessCopy = formatMessage({
    id: unpresentedScopes.length > 0
      ? "oauth.consent.introUnrecognized"
      : visibleScopes.includes("agent:read")
        ? "oauth.consent.introAgentDirectory"
        : hasAgentInboundRequest
          ? "oauth.consent.introAgentMessaging"
          : "oauth.consent.introIdentityOnly",
  });

  function renderEmptyRecognizedScopes() {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: covered by DOM tests; generated mutants hang tsx.
    if (visibleScopes.length !== 0) return null;
    return (
      <div className="rounded-md border border-line-hairline bg-layer-panel p-2 text-xs font-bold text-foreground-muted theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black/15 theme-brutal:bg-white theme-brutal:text-black/55">
        {formatMessage({ id: "oauth.consent.noRecognizedScopes" })}
      </div>
    );
  }

  function renderTierScopes(tier: OAuthScopeTier) {
    const tierScopes = grouped[tier];
    // Stryker disable next-line ConditionalExpression: covered by DOM tests; generated mutants hang tsx.
    if (tierScopes.length === 0) return null;
    return (
      <details key={tier} open={tier !== "identity"} className="rounded-md border border-line-hairline bg-layer-inset p-2 theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black/15 theme-brutal:bg-brutal-cream">
        <summary className="text-xs font-black text-foreground-strong">
          <span>{formatMessage({ id: scopeGroupLabelId(tier) })}</span>
          {tier === "identity" ? (
            <span className="font-medium text-foreground-muted">
              {formatMessage({ id: IDENTITY_SCOPE_GROUP_SUMMARY_ID })}
            </span>
          ) : null}
        </summary>
        <div className="mt-2 divide-y divide-line-hairline border-t border-line-hairline">
          {tierScopes.map((scope) => {
            const detail = OAUTH_SCOPE_PRESENTATION[scope];
            return (
              <div key={scope} data-oauth-scope-row={scope} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all text-[11px] font-bold text-foreground-muted">{scope}</code>
                </div>
                <div className="mt-1 text-xs leading-relaxed text-foreground-muted">{formatMessage({ id: detail.copyId })}</div>
              </div>
            );
          })}
        </div>
      </details>
    );
  }

  function renderAgentInboundNotice() {
    // Stryker disable next-line BooleanLiteral,ConditionalExpression: covered by DOM tests; generated mutants hang tsx.
    if (!hasAgentInboundRequest) return null;
    return (
      <div className="text-xs font-bold leading-relaxed text-foreground-muted">
        {/* ONE message. This was two English sentences concatenated in JSX, so a
            translation could not reorder them or merge them into the single
            sentence Chinese wants. */}
        {formatMessage({ id: "oauth.consent.agentLoginRequiredNotice" })}
      </div>
    );
  }

  function renderUnpresentedScopes() {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: covered by DOM tests; generated mutants hang tsx.
    if (unpresentedScopes.length === 0) return null;
    return (
      <div className="text-xs font-bold leading-relaxed text-foreground-muted">
        <span>{formatMessage({ id: "oauth.consent.unrecognizedScopes" })} </span>
        <span className="inline-flex flex-wrap gap-1.5">
          {unpresentedScopes.map((scope) => (
            <code key={scope} className="break-all rounded-sm border border-line-muted bg-layer-panel px-1.5 py-0.5 text-[11px] text-foreground-muted theme-brutal:rounded-none theme-brutal:border-black/20 theme-brutal:bg-white">
              {scope}
            </code>
          ))}
        </span>
      </div>
    );
  }

  return (
    <div className={className} data-testid="login-with-raft-requested-scopes">
      <div className="text-xs font-black uppercase tracking-widest">
        {formatMessage({ id: "oauth.consent.requestedAccess" })}
      </div>
      <div className="mt-1 text-xs leading-5 text-foreground-muted">
        {requestedAccessCopy}
      </div>
      <div className="mt-3 space-y-3 rounded-md border border-line-muted bg-layer-panel p-3 shadow-raft-sm theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal-sm">
        {renderEmptyRecognizedScopes()}
        {(["identity", "agent_directory", "agent_messaging"] as OAuthScopeTier[]).map(renderTierScopes)}
        {renderAgentInboundNotice()}
        {renderUnpresentedScopes()}
      </div>
    </div>
  );
}
