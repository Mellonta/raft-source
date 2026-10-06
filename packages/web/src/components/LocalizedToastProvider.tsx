import type { PropsWithChildren } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import {
  ToastAction,
  ToastActions,
  ToastBody,
  ToastClose,
  ToastContent,
  ToastPortal,
  ToastProvider,
  ToastRoot,
  ToastIcon,
  ToastDescription,
  ToastTitle,
  ToastViewport,
  useToastManager,
} from "raft-ui";
import { useEffect } from "react";
import { useIntl } from "react-intl";
import { setToastManager } from "./toastBridge";


/**
 * The default raft-ui toast close control intentionally uses English fallback
 * copy. The app owns the active locale, so keep the same provider/manager
 * contract while supplying localized visible and accessible dismissal text.
 */
function LocalizedToastList() {
  const { formatMessage } = useIntl();
  const { toasts } = useToastManager();
  const dismissLabel = formatMessage({ id: "common.toast.close" });

  return toasts.map((toastObject) => {
    const showAction = Boolean(toastObject.actionProps?.children);
    const showClose = toastObject.data?.hasClose !== false;
    const showIcon = toastObject.data?.hasIcon !== false;
    const intent = toastObject.data?.intent ?? toastObject.type;
    return (
      <ToastRoot key={toastObject.id} toast={toastObject} layout="inline" data-testid="localized-toast-row">
        <ToastContent
          className={[
            "!grid-cols-[auto_minmax(0,1fr)_auto] !items-center !gap-x-3 !gap-y-0",
            toastObject.data?.contentClassName,
          ].filter(Boolean).join(" ")}
          data-testid="localized-toast-content-row"
        >
          {showIcon ? (
            <ToastIcon className="size-5 border-0 bg-transparent p-0 shadow-none" data-testid="localized-toast-icon">
              {intent === "success" ? <CheckCircle2 aria-hidden="true" /> : intent === "warning" || intent === "error" ? <AlertTriangle aria-hidden="true" /> : <Info aria-hidden="true" />}
            </ToastIcon>
          ) : null}
          <ToastBody className="min-w-0 text-left" data-testid="localized-toast-content">
            <ToastTitle className="whitespace-normal break-words font-normal" />
            {toastObject.description ? <ToastDescription /> : null}
          </ToastBody>
          {showAction || showClose ? (
            <ToastActions
              className="!col-span-1 !col-start-3 !row-start-1 !w-auto shrink-0 justify-self-end"
              data-testid="localized-toast-actions"
            >
              {showClose ? (
                <ToastClose
                  className="size-8 p-1"
                  aria-label={dismissLabel}
                  aria-hidden={false}
                  data-testid="localized-toast-close"
                >
                  <X size={16} aria-hidden="true" />
                </ToastClose>
              ) : null}
              {showAction ? <ToastAction /> : null}
            </ToastActions>
          ) : null}
        </ToastContent>
      </ToastRoot>
    );
  });
}

/** Publishes the live manager to `toastBridge` for surfaces that may render without a provider. */
function ToastManagerBridge() {
  const manager = useToastManager();
  useEffect(() => {
    setToastManager(manager);
    return () => setToastManager(null);
  }, [manager]);
  return null;
}

export default function LocalizedToastProvider({ children }: PropsWithChildren) {
  return (
    <ToastProvider renderViewport={false}>
      <ToastManagerBridge />
      {children}
      <ToastPortal>
        <ToastViewport placement="bottom-center">
          <LocalizedToastList />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  );
}
