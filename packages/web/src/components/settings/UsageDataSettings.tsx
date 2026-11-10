import { browserPrivacyMode } from "@botiverse/raft-shared/src/browserPrivacy";
// RFC-067 product analytics controls: the personal "Share usage data" switch
// (Settings → Account) and the workspace switch (Settings → Administration).
// Both stay hidden behind PRODUCT_ANALYTICS_SETTINGS_FLAG_KEY until the default
// and the privacy-policy section are confirmed.
// Both save on toggle; the server gate (productAnalyticsGate) is what enforces
// them, and the tracker asks /product-events/config before sending anything.

import { useCallback, useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle, Switch } from "@botiverse/raft-ui";
import { BarChart3 } from "lucide-react";
import { PRIVACY_URL, SHARE_USAGE_DATA_DEFAULT } from "@botiverse/raft-shared";
import api from "../../api/client";
import { useAuthStore } from "../../store/authStore";
import { PRODUCT_ANALYTICS_SETTINGS_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useServerStore } from "../../store/serverStore";
import Banner from "../ui/Banner";
import SectionHeader from "../ui/SectionHeader";

function SwitchRow({
  idPrefix,
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
  footer,
}: {
  idPrefix: string;
  title: string;
  description: ReactNode;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  footer?: ReactNode;
}) {
  // DS ListRow › a setting row: raft-ui's `plain` display-only ListRow (the
  // Switch is the target) in an inset group; a save failure shows under it.
  return (
    <ListRowGroup>
      <ListRow variant="plain" interactive={false}>
        <ListRowBody>
          <ListRowTitle id={`${idPrefix}-label`}>{title}</ListRowTitle>
          <ListRowDescription id={`${idPrefix}-description`} wrap>
            {description}
          </ListRowDescription>
        </ListRowBody>
        <Switch
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
          aria-labelledby={`${idPrefix}-label`}
          aria-describedby={`${idPrefix}-description`}
        />
      </ListRow>
      {footer ? <div className="px-4 pb-3">{footer}</div> : null}
    </ListRowGroup>
  );
}

/** Settings → Account. */
export function UsageDataSettingsCard() {
  const { enabled } = useServerFeatureFlag(PRODUCT_ANALYTICS_SETTINGS_FLAG_KEY);
  return enabled ? <UsageDataSettingsCardContent /> : null;
}

function UsageDataSettingsCardContent() {
  const { formatMessage } = useIntl();
  const idPrefix = useId();
  const shareUsageData = useAuthStore((s) => s.user?.shareUsageData ?? null);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleChange = useCallback((checked: boolean) => {
    setSaving(true);
    setFailed(false);
    void updateProfile({ shareUsageData: checked })
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  }, [updateProfile]);

  return (
    <div className="mt-6">
      <SwitchRow
        idPrefix={idPrefix}
        title={formatMessage({ id: "settings.usageData.title" })}
        description={(
          <>
            {formatMessage({ id: "settings.usageData.description" })}{" "}
            <a href={PRIVACY_URL} target="_blank" rel="noreferrer" className="font-semibold text-foreground underline decoration-[1.5px] underline-offset-[3px]">
              {formatMessage({ id: "settings.usageData.learnMore" })}
            </a>
          </>
        )}
        checked={!browserPrivacyMode() && (shareUsageData ?? SHARE_USAGE_DATA_DEFAULT)}
        disabled={browserPrivacyMode() || saving}
        onCheckedChange={handleChange}
        footer={failed && (
          <Banner intent="warning" density="sm">
            {formatMessage({ id: "settings.usageData.saveFailed" })}
          </Banner>
        )}
      />
    </div>
  );
}

interface WorkspaceProductAnalyticsSettings {
  productAnalyticsEnabled: boolean;
  canManageProductAnalytics: boolean;
}

/** Settings → Administration (owners and admins). */
export function WorkspaceProductAnalyticsSection() {
  const { enabled } = useServerFeatureFlag(PRODUCT_ANALYTICS_SETTINGS_FLAG_KEY);
  return enabled ? <WorkspaceProductAnalyticsSectionContent /> : null;
}

function WorkspaceProductAnalyticsSectionContent() {
  const { formatMessage } = useIntl();
  const idPrefix = useId();
  const serverId = useServerStore((s) => s.current?.id);
  const [settings, setSettings] = useState<WorkspaceProductAnalyticsSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    api.get<WorkspaceProductAnalyticsSettings>(`/servers/${serverId}/product-analytics-settings`)
      .then(({ data }) => {
        if (!cancelled) setSettings(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  // Declared before the early return below: hooks must run on every render.
  const handleChange = useCallback((checked: boolean) => {
    if (!serverId) return;
    setSaving(true);
    setFailed(false);
    void api.patch<WorkspaceProductAnalyticsSettings>(
      `/servers/${serverId}/product-analytics-settings`,
      { productAnalyticsEnabled: checked },
    )
      .then(({ data }) => setSettings(data))
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  }, [serverId]);

  if (!serverId) return null;

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<BarChart3 size={16} />}
        label={formatMessage({ id: "settings.workspaceProductAnalytics.sectionLabel" })}
      />
      <SwitchRow
        idPrefix={idPrefix}
        title={formatMessage({ id: "settings.workspaceProductAnalytics.title" })}
        description={formatMessage({ id: "settings.workspaceProductAnalytics.description" })}
        checked={!browserPrivacyMode() && (settings?.productAnalyticsEnabled ?? true)}
        disabled={browserPrivacyMode() || saving || settings === null || !settings.canManageProductAnalytics}
        onCheckedChange={handleChange}
        footer={failed && (
          <Banner intent="warning" density="sm">
            {formatMessage({ id: "settings.workspaceProductAnalytics.saveFailed" })}
          </Banner>
        )}
      />
    </div>
  );
}
