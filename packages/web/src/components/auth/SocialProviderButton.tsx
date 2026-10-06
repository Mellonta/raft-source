import { useIntl } from "react-intl";
import { Button } from "raft-ui";
import type { SocialAuthProviderId } from "../../hooks/useAuthProviders";
import { AppleLogo, GitHubLogo, GoogleLogo } from "../icons/ProviderLogos";

const SOCIAL_BUTTON_BASE = "w-full gap-3";

export default function SocialProviderButton({
  providerId,
  label,
  onClick,
}: {
  providerId: SocialAuthProviderId;
  label: string;
  onClick: (providerId: SocialAuthProviderId) => void;
}) {
  const { formatMessage } = useIntl();
  const logo = providerId === "google"
    ? <GoogleLogo />
    : providerId === "github"
      ? <GitHubLogo />
      : <AppleLogo />;

  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      className={SOCIAL_BUTTON_BASE}
      onClick={() => onClick(providerId)}
    >
      {logo}
      <span>{formatMessage({ id: "auth.social.continueWith" }, { provider: label })}</span>
    </Button>
  );
}
