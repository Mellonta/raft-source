// Social auth provider logos, loaded from standalone SVG assets.
//
// Single source with mobile (task #436): these files are byte-identical to
// compose/shared/src/commonMain/resources/MR/assets/icons/provider_*.svg in
// botiverse/mobile — change them in BOTH repos together. The SVGs carry
// fixed brand fills (github = #000000), so an <img> renders the same as the
// previously inlined fill-current paths on these light surfaces.
//
// Elegant Dark is NOT a light surface: the single-colour marks (GitHub, Apple)
// render black-on-black there (GitHub measured 1.63:1, task #663). They are
// inverted at the render site with `dark:invert` -- which matches under
// [data-theme="elegant"].dark (plus rui's pre-hydration system-dark-mode
// fallback for an Elegant page with no explicit mode yet, so a dark-OS first
// paint does not flash) -- so the shared asset files stay byte-identical
// with mobile. Google is multicolour and is deliberately left alone.
// new URL(..., import.meta.url) instead of an svg module import: Vite
// resolves it to the bundled asset URL, and the node-based behavioral test
// runner (tsx has no .svg loader) can evaluate it without exploding.
const providerGoogleUrl = new URL("../../assets/icons/provider_google.svg", import.meta.url).href;
const providerGithubUrl = new URL("../../assets/icons/provider_github.svg", import.meta.url).href;
const providerAppleUrl = new URL("../../assets/icons/provider_apple.svg", import.meta.url).href;

export function GoogleLogo({ className = "size-5" }: { className?: string }) {
  return <img src={providerGoogleUrl} alt="" aria-hidden="true" className={`${className} shrink-0`} />;
}

export function GitHubLogo({ className = "size-5" }: { className?: string }) {
  return <img src={providerGithubUrl} alt="" aria-hidden="true" className={`${className} shrink-0 dark:invert`} />;
}

export function AppleLogo({ className = "size-5" }: { className?: string }) {
  return <img src={providerAppleUrl} alt="" aria-hidden="true" className={`${className} shrink-0 dark:invert`} />;
}
