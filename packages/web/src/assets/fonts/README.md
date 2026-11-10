The portal chooses its font stylesheet after reading the server privacy setting. Normal mode uses Raft UI’s public font definitions and the original quote glyph; private mode uses the bundled fonts in this directory.

Space Grotesk (400/500/600/700) and Space Mono (400/700) preserve the CSS subsets from https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap fetched 2026-09-10. Hanken Grotesk preserves the existing U+0022 quote fallback file. All are under the accompanying SIL Open Font Licenses from https://github.com/google/fonts/tree/main/ofl.

Keep the unicode ranges and font-display policy when updating; local delivery removes external requests but does not eliminate every possible font swap.
