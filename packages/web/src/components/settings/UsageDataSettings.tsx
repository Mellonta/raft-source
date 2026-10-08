import { DISTRIBUTION_POLICY } from "@botiverse/raft-shared/src/distributionPolicy";
// RFC-067 product analytics controls: the personal "Share usage data" switch
// (Settings → Account) and the workspace switch (Settings → Administration).
// Both stay hidden behind PRODUCT_ANALYTICS_SETTINGS_FLAG_KEY until the default
// and the privacy-policy section are confirmed.
// Both save on toggle; the server gate (productAnalyticsGate) is what enforces
// them, and the tracker asks /product-events/config before sending anything.

import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Card, Switch } from "raft-ui";
import { BarChart3 } from "lucide-react";
import { PRIVACY_URL, SHARE_USAGE_DATA_DEFAULT } from "@botiverse/raft-shared";
import api from "../../api/client";
import { useAuthStore } from "../../store/authStore";
import { PRODUCT_ANALYTICS_SETTINGS_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useServerStore } from "../../store/serverStore";
import Banner from "../ui/Banner";
import SectionHeader from "../ui/SectionHeader";

const CARD_CLASS =
  "border-line-muted bg-layer-panel p-4 shadow-raft-sm theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal-sm";

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
  return (
    <Card className={CARD_CLASS}>
      <div className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span id={`${idPrefix}-label`} className="block text-sm font-bold text-foreground-strong">{title}</span>
          <span id={`${idPrefix}-description`} className="mt-0.5 block text-xs leading-5 text-foreground-muted">
            {description}
          </span>
        </span>
        <Switch
          size="md"
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
          aria-labelledby={`${idPrefix}-label`}
          aria-describedby={`${idPrefix}-description`}
          className="mt-0.5 shrink-0"
        />
      </div>
      {footer}
    </Card>
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

  const handleChange = async (checked: boolean) => {
    setSaving(true);
    setFailed(false);
    try {
      await updateProfile({ shareUsageData: checked });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6">
      <SwitchRow
        idPrefix={idPrefix}
        title={formatMessage({ id: "settings.usageData.title" })}
        description={(
          <>
            {formatMessage({ id: "settings.usageData.description" })}{" "}
            <a href={PRIVACY_URL} target="_blank" rel="noreferrer" className="font-bold underline underline-offset-2">
              {formatMessage({ id: "settings.usageData.learnMore" })}
            </a>
          </>
        )}
        checked={DISTRIBUTION_POLICY.productAnalytics && (shareUsageData ?? SHARE_USAGE_DATA_DEFAULT)}
        disabled={!DISTRIBUTION_POLICY.productAnalytics || saving}
        onCheckedChange={(checked) => void handleChange(checked)}
        footer={failed && (
          <Banner intent="warning" density="sm" className="mt-3 font-bold">
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

  if (!serverId) return null;

  const handleChange = async (checked: boolean) => {
    setSaving(true);
    setFailed(false);
    try {
      const { data } = await api.patch<WorkspaceProductAnalyticsSettings>(
        `/servers/${serverId}/product-analytics-settings`,
        { productAnalyticsEnabled: checked },
      );
      setSettings(data);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

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
        checked={DISTRIBUTION_POLICY.productAnalytics && (settings?.productAnalyticsEnabled ?? true)}
        disabled={!DISTRIBUTION_POLICY.productAnalytics || saving || settings === null || !settings.canManageProductAnalytics}
        onCheckedChange={(checked) => void handleChange(checked)}
        footer={failed && (
          <Banner intent="warning" density="sm" className="mt-3 font-bold">
            {formatMessage({ id: "settings.workspaceProductAnalytics.saveFailed" })}
          </Banner>
        )}
      />
    </div>
  );
}
