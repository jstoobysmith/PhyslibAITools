// Minimal line icons (thin stroke, currentColor) for the setup dashboard -
// deliberately simple geometric marks rather than brand logos, in keeping
// with the thin-line diagram style of the Physlib mark itself.

import type { SVGProps } from "react";

function base(props: SVGProps<SVGSVGElement>) {
  return {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...props,
  };
}

/** A four-point spark - a small, non-branded stand-in for "AI assistance". */
export function SparkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6-5.6-1.9 5.6-1.9L12 2.5z" />
    </svg>
  );
}

/** A branching graph - reads as both "git fork" and a particle-line split,
 * echoing the Physlib wordmark's own diagram lines. */
export function BranchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="6" cy="6" r="2.1" />
      <circle cx="6" cy="18" r="2.1" />
      <circle cx="18" cy="12" r="2.1" />
      <path d="M6 8.1V15M7.6 7.2C11 8 14 9.4 15.8 11" />
    </svg>
  );
}

/** A folder - the workspace/files step. */
export function FolderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M3.5 7a1.8 1.8 0 0 1 1.8-1.8h3.6l2 2h7.8A1.8 1.8 0 0 1 20.5 9v8a1.8 1.8 0 0 1-1.8 1.8H5.3A1.8 1.8 0 0 1 3.5 17V7z" />
    </svg>
  );
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)} strokeWidth={2.2}>
      <path d="M4.5 12.5l4.5 4.5 10.5-11" />
    </svg>
  );
}

/** A gear - settings, where accounts can be changed. */
export function GearIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M17.7 6.3l-1.7 1.7M8 16l-1.7 1.7M17.7 17.7 16 16M8 8 6.3 6.3" />
    </svg>
  );
}

/** A person - the profile menu, where the API token, accounts and preferences
 * are changed. Replaces the gear in the header: what sits behind it is mostly
 * "who am I signed in as", not machine settings. */
export function ProfileIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8.5" r="3.75" />
      <path d="M4.5 20.2a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}

/** A key - the API token section. */
export function KeyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="12" r="3.5" />
      <path d="M11.5 12H21M18 12v3.2M15 12v2.2" />
    </svg>
  );
}

/** Sliders - the preferences section. */
export function SlidersIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </svg>
  );
}
