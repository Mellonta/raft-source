import { useEffect } from "react";
import { useIntl } from "react-intl";
import { Kbd, PopoverPopup } from "raft-ui";
import MessageSearchPage from "./MessageSearchPage";
import { searchOverlayCardStyle } from "./searchOverlayAnchor";
import Modal from "../Modal";

/**
 * Desktop ⌘K search overlay. The topbar Search button / ⌘K navigates to the real
 * `/search` route with `location.state.backgroundLocation` set; MainLayout keeps
 * the underlying channel rendered (frozen) via `<Routes location={backgroundLocation}>`
 * and floats this overlay on top. So the URL genuinely IS `/search` — MessageSearchPage's
 * URL-as-source-of-truth for the query works unchanged, and this is the SAME search,
 * just presented as a floating panel over the current channel (Slack ⌘K behaviour).
 *
 * The backdrop is transparent (no dim, no blur): like Slack's search panel the
 * app stays fully visible behind the palette; the card's own border/shadow does
 * the layering (WAWQAQ 2026-09-24, #kabi-desktop 7b0b9ca1). Click-outside still
 * dismisses.
 *
 * The card's surface is raft-ui's popover surface (`PopoverPopup`, the same
 * element ServerSwitcherMenu floats): the theme family decides corners, border,
 * shadow and background in one place — Elegant rounded + soft shadow on
 * `bg-layer-popover`, Brutal 2px black + hard shadow. The legacy `card-brutal`
 * utility it replaced had no radius in any theme and forced `bg-white`, which is
 * why the palette was square (and white in Elegant Dark) — WAWQAQ 2026-09-24.
 * Header and footer stay transparent so the surface reads as one piece.
 *
 * Result activation runs in `activateResultsInChat` mode: a single click / Enter jumps
 * to the hit in chat, which navigates away (clearing backgroundLocation) and so
 * dismisses the overlay on its own. Backdrop click dismisses (Modal, closeOnBackdrop).
 *
 * Escape is owned here rather than by Modal (closeOnEscape={false}) so it can respect a
 * prior handler: the search's own filter-menu Escape preventDefaults (leave the overlay
 * open, just close the menu), and IME composition must never dismiss.
 */
const ARROW_UP_GLYPH = "↑";
const ARROW_DOWN_GLYPH = "↓";
const RETURN_KEY_GLYPH = "↵";

export default function SearchOverlay({ onClose }: { onClose: () => void }) {
  const { formatMessage } = useIntl();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      onClose();
    };
    // keydown-global-exempt: modal Escape-to-dismiss for the search overlay,
    // guarded by defaultPrevented (the search's filter-menu Escape wins) + IME.
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <Modal onClose={onClose} closeOnBackdrop closeOnEscape={false} layer={1} backdrop="transparent">
      {/*
        Fixed size + position (Slack command-palette pattern): a constant height
        so the frame never grows/shrinks or re-centers as the query and result
        count change — MessageSearchPage fills it (flex-1) and its result list
        scrolls internally. Placement is ANCHORED to the desktop top-bar search
        field via CSS variables (see searchOverlayAnchor.ts): top edge on the
        field, centred on it, so the panel reads as the field expanding — with a
        centred 8vh fallback wherever the shell publishes no anchor.
      */}
      <PopoverPopup
        role="dialog"
        aria-modal="true"
        data-testid="desktop-search-overlay"
        className="flex min-h-0 min-w-0 flex-col"
        style={searchOverlayCardStyle()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <MessageSearchPage activateResultsInChat overlayChrome />
        {/* Palette footer (task #113, Slack's "↑↓ Select"): the keyboard contract
            in one quiet line; Esc already sits in the field. */}
        <div
          data-testid="desktop-search-overlay-footer"
          className="flex shrink-0 items-center gap-4 border-t border-line-muted px-3 py-1.5 text-[11px] text-foreground-muted theme-brutal:border-t-2 theme-brutal:border-black theme-brutal:text-black/60"
        >
          <span className="flex items-center gap-1">
            <Kbd aria-hidden="true">{ARROW_UP_GLYPH}</Kbd>
            <Kbd aria-hidden="true">{ARROW_DOWN_GLYPH}</Kbd>
            <span>{formatMessage({ id: "search.overlay.footerSelect" })}</span>
          </span>
          <span className="flex items-center gap-1">
            <Kbd aria-hidden="true">{RETURN_KEY_GLYPH}</Kbd>
            <span>{formatMessage({ id: "search.overlay.footerOpen" })}</span>
          </span>
        </div>
      </PopoverPopup>
    </Modal>
  );
}
