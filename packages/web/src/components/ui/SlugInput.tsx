import { InputGroup, InputGroupAddon, InputGroupInput } from "raft-ui";
import type { InputHTMLAttributes } from "react";

type SlugInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
  className?: string;
  inputClassName?: string;
};

type PrefixedInputProps = SlugInputProps & {
  prefix: string;
};

export function PrefixedInput({
  prefix,
  className = "",
  inputClassName = "",
  ...props
}: PrefixedInputProps) {
  return (
    <InputGroup className={`w-full ${className}`.trim()}>
      <InputGroupAddon.Text aria-hidden="true" variant="container">
        {prefix}
      </InputGroupAddon.Text>
      <InputGroupInput {...props} data-invalid={props["aria-invalid"] === true || props["aria-invalid"] === "true"} className={inputClassName} />
    </InputGroup>
  );
}

export default function SlugInput(props: SlugInputProps) {
  return <PrefixedInput prefix="/" {...props} />;
}
