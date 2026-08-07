/**
 * The intel. brand mark.
 *
 * Geometry is the canonical 256-unit viewBox from logo-brand.svg so this
 * component, icon.ico, tray.png and the toast's inline SVG all describe
 * the exact same shape.
 *
 * NOTE: there is deliberately NO background <rect> here. Every copy of
 * this mark previously baked in `fill="#0a0b10"` as a solid backing
 * plate, which is what produced the visible black box behind the logo in
 * the topbar, the taskbar and the tray. The mark must sit on whatever
 * surface it's placed on. If you need a plate, add it in the parent, not
 * inside the mark.
 *
 * `tone` lets the caller render it monochrome (e.g. inside a colored
 * button) instead of the two-tone brand green.
 */
export function Logo({ size = 22, tone = null }) {
  const outer = tone || '#9FE8C3';
  const inner = tone || '#4FE3A8';
  const stem = tone || '#E8F2EC';
  return (
    <svg
      viewBox="0 0 256 256"
      fill="none"
      style={{ width: size, height: size, display: 'block' }}
      aria-hidden="true"
    >
      <path d="M70 100 Q128 40 186 100" stroke={outer} strokeWidth="22" strokeLinecap="round" fill="none" />
      <path d="M92 120 Q128 82 164 120" stroke={inner} strokeWidth="22" strokeLinecap="round" fill="none" />
      <rect x="114" y="128" width="28" height="80" rx="14" fill={stem} />
    </svg>
  );
}
