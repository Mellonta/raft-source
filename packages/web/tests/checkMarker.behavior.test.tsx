import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render } from "@testing-library/react";

import CheckMarker from "../src/components/ui/CheckMarker";

afterEach(cleanup);

test("CheckMarker renders square, circle, black-fill, and yellow-fill states", () => {
  const view = render(
    <div>
      <CheckMarker data-testid="form" checked size="md" tone="black-fill" />
      <CheckMarker data-testid="list" checked size="lg" tone="yellow-fill" />
      <CheckMarker data-testid="message" checked shape="circle" size="lg" tone="yellow-fill" />
    </div>,
  );

  assert.match(view.getByTestId("form").className, /size-4/);
  assert.match(view.getByTestId("form").className, /bg-foreground-strong text-foreground-inverse/);
  assert.match(view.getByTestId("list").className, /size-5/);
  assert.match(view.getByTestId("list").className, /bg-primary-soft text-primary-strong/);
  assert.match(view.getByTestId("message").className, /rounded-full/);
  assert.match(view.getByTestId("message").className, /bg-primary-soft text-primary-strong/);
});
