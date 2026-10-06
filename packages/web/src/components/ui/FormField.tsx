/**
 * Thin product adapter over RUI Field. It keeps the existing label/help/error
 * call shape while delegating field semantics and theme styling to RUI.
 */

import { useContext } from "react";
import type { LabelHTMLAttributes, ReactNode } from "react";
import { IntlContext } from "react-intl";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  LabelAsterisk,
  LabelOptional,
} from "raft-ui";
import { en } from "../../i18n/messages/en";

const LABEL_BASE_DEFAULT = "text-sm";
const LABEL_BASE_COMPACT = "text-xs";
const LABEL_UPPERCASE = "uppercase tracking-wide";

export type FormFieldProps = {
  /** Field label text. */
  label: ReactNode;
  /** Show a `*` required marker after the label. */
  required?: boolean;
  /** Show the localized optional marker in muted case after the label.
   *  Mutually exclusive with `required`. */
  optional?: boolean;
  /** Helper text rendered below the control. */
  hint?: ReactNode;
  /** Error text rendered below the control (takes precedence over `hint`). */
  error?: ReactNode;
  /** Small control or tooltip rendered beside the label. */
  labelAccessory?: ReactNode;
  /** `<label htmlFor>` — point at the inner control's `id`. */
  htmlFor?: LabelHTMLAttributes<HTMLLabelElement>["htmlFor"];
  /** Label case style. `"uppercase"` (default) matches the dialog/settings
   *  convention. `"plain"` matches the auth-page convention. */
  labelStyle?: "uppercase" | "plain";
  /** Label size. `"compact"` selects the denser settings form treatment. */
  size?: "default" | "compact";
  /** Additional classes appended to the outer `<div>`. */
  className?: string;
  /** The actual control — `<input>`, `<textarea>`, `<SegmentedControl>`,
   *  `<select>`, custom group, etc. */
  children: ReactNode;
};

export default function FormField({
  label,
  required,
  optional,
  hint,
  error,
  labelAccessory,
  htmlFor,
  labelStyle = "uppercase",
  size = "default",
  className,
  children,
}: FormFieldProps) {
  // Some legacy test and static-render seams mount this shared primitive
  // without an IntlProvider; keep that path human-readable instead of throwing.
  const intl = useContext(IntlContext);
  const optionalLabel = intl?.formatMessage({ id: "ui.formField.optional" }) ?? en["ui.formField.optional"];
  const base = size === "compact" ? LABEL_BASE_COMPACT : LABEL_BASE_DEFAULT;
  const labelTextCls = `${base} ${labelStyle === "uppercase" ? LABEL_UPPERCASE : ""}`.trim();
  const labelCls = `mb-1 block ${labelTextCls}`;
  const wrapperCls = className ? className : undefined;
  const labelElement = (
    <FieldLabel
      className={labelAccessory ? labelTextCls : labelCls}
      htmlFor={htmlFor}
    >
      {label}
      {required ? <LabelAsterisk className="ml-1" /> : null}
      {optional ? (
        <LabelOptional className="ml-1">{optionalLabel}</LabelOptional>
      ) : null}
    </FieldLabel>
  );
  return (
    <Field className={wrapperCls} invalid={Boolean(error)}>
      {labelAccessory ? (
        <div className="mb-1 flex items-center gap-1">
          {labelElement}
          {labelAccessory}
        </div>
      ) : labelElement}
      {children}
      {error ? (
        <FieldError className="mt-1" role="alert" match={Boolean(error)}>
          {error}
        </FieldError>
      ) : hint ? (
        <FieldDescription className="mt-1">{hint}</FieldDescription>
      ) : null}
    </Field>
  );
}
