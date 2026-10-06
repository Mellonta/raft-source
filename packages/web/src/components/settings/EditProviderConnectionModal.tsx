import { Button, Checkbox, Input, Spinner } from "raft-ui";
import { Pencil } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import type {
  ProviderConnectionProviderOption,
  ProviderConnectionSummary,
} from "@botiverse/raft-shared";
import api from "../../api/client";
import DialogCard from "../ui/DialogCard";
import FormField from "../ui/FormField";

export default function EditProviderConnectionModal({
  connection,
  providerOptions,
  onClose,
  onCompleted,
}: {
  connection: ProviderConnectionSummary;
  providerOptions: ProviderConnectionProviderOption[];
  onClose: () => void;
  onCompleted: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the keyed modal snapshots the selected row when it opens; catalog refreshes must not overwrite in-progress input.
  const [name, setName] = useState(connection.name);
  const [apiKey, setApiKey] = useState("");
  // oxlint-disable-next-line react-doctor/no-derived-useState -- same keyed modal snapshot contract as the name field above.
  const [endpointUrl, setEndpointUrl] = useState(connection.endpointUrl ?? "");
  // oxlint-disable-next-line react-doctor/no-derived-useState -- same keyed modal snapshot contract as the name field above.
  const [supportsImageInput, setSupportsImageInput] = useState(connection.supportsImageInput);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const gateway = providerOptions.find((entry) => entry.id === connection.providerId)?.providerKind === "gateway";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const payload: {
        name: string;
        endpointUrl?: string;
        supportsImageInput?: boolean;
        apiKey?: string;
      } = {
        name: name.trim(),
        ...(gateway ? { endpointUrl: endpointUrl.trim(), supportsImageInput } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      };
      await api.patch(`/provider-connections/${connection.id}`, payload);
      await onCompleted();
    } catch {
      setError(formatMessage({ id: "settings.providers.actionError" }));
    } finally {
      setSubmitting(false);
    }
  };

  const nameInputId = `provider-connection-${connection.id}-edit-name`;
  const endpointInputId = `provider-connection-${connection.id}-edit-endpoint`;
  const apiKeyInputId = `provider-connection-${connection.id}-edit-key`;
  const imageInputId = `provider-connection-${connection.id}-edit-image`;

  return (
    <DialogCard
      onClose={onClose}
      title={formatMessage({ id: "settings.providers.editTitle" }, { name: connection.name })}
      testId="provider-connection-edit-dialog"
      // Opens from inside the agent detail runtime editor (Modal layer=1) and
      // the onboarding create dialog (layer=1): without an explicit tier it
      // renders at z-50, behind its own parent.
      layer={2}
    >
      <form onSubmit={submit} className="space-y-4" data-testid="provider-connection-edit-form">
        <FormField label={formatMessage({ id: "settings.providers.name" })} htmlFor={nameInputId}>
          <Input
            id={nameInputId}
            className="w-full"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            required
            autoFocus
          />
        </FormField>
        {gateway && (
          <FormField label={formatMessage({ id: "settings.providers.endpoint" })} htmlFor={endpointInputId}>
            <Input
              id={endpointInputId}
              className="w-full"
              type="url"
              value={endpointUrl}
              onChange={(event) => setEndpointUrl(event.target.value)}
              required
            />
          </FormField>
        )}
        <FormField
          label={formatMessage({ id: "settings.providers.apiKey" })}
          htmlFor={apiKeyInputId}
          hint={formatMessage({ id: "settings.providers.editApiKeyHint" })}
        >
          <Input
            id={apiKeyInputId}
            className="w-full"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </FormField>
        {gateway && (
          <label htmlFor={imageInputId} className="flex items-center gap-2 text-sm font-medium">
            <Checkbox
              id={imageInputId}
              checked={supportsImageInput}
              onCheckedChange={(checked) => setSupportsImageInput(checked === true)}
            />
            {formatMessage({ id: "settings.providers.imageInput" })}
          </label>
        )}
        {error && <div className="text-sm font-medium text-red-700">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            {formatMessage({ id: "settings.common.cancel" })}
          </Button>
          <Button
            type="submit"
            disabled={submitting || !name.trim() || (gateway && !endpointUrl.trim())}
          >
            {submitting ? <Spinner size="sm" aria-hidden="true" /> : <Pencil size={16} />}
            {formatMessage({ id: "settings.providers.saveChanges" })}
          </Button>
        </div>
      </form>
    </DialogCard>
  );
}
