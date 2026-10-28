// Inline 16px stroke icons for the pane (no remote content under the CSP).

import type { ReactElement } from 'react';

const Svg = ({ children, label }: { children: ReactElement | ReactElement[]; label?: string }) => (
  <svg
    className="icon"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden={label ? undefined : true}
    role={label ? 'img' : undefined}
    aria-label={label}
  >
    {children}
  </svg>
);

export const Check = () => (
  <Svg>
    <path d="M3 8.5l3 3 7-7" />
  </Svg>
);

export const CheckAll = () => (
  <Svg>
    <path d="M1.5 8.5l3 3 6-7" />
    <path d="M8 11.5l6-7" />
  </Svg>
);

export const External = () => (
  <Svg>
    <path d="M9 2.5h4.5V7" />
    <path d="M13.5 2.5L7 9" />
    <path d="M11.5 9.5v3.5h-9v-9H6" />
  </Svg>
);

export const Copy = () => (
  <Svg>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
    <path d="M10.5 3V2.5h-8v8H3" />
  </Svg>
);

export const Refresh = () => (
  <Svg>
    <path d="M13.5 3v3.5H10" />
    <path d="M13 6.5A5.5 5.5 0 1 0 13.5 9" />
  </Svg>
);

export const Info = () => (
  <Svg>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.25V11" />
    <path d="M8 5h.01" />
  </Svg>
);

export const Close = () => (
  <Svg>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);

// Status shapes: filled dot (triggered), ring with centre (acknowledged), tick in ring (resolved).
export const StatusShape = ({ status }: { status: string }) => {
  if (status === 'triggered')
    return (
      <Svg>
        <circle cx="8" cy="8" r="4.5" fill="currentColor" />
      </Svg>
    );
  if (status === 'acknowledged')
    return (
      <Svg>
        <circle cx="8" cy="8" r="5" />
        <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      </Svg>
    );
  return (
    <Svg>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 8.25l1.75 1.75 3.25-3.5" />
    </Svg>
  );
};

export const Sparkle = () => (
  <Svg>
    <path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z" />
    <path d="M13 11.5v3M11.5 13h3" />
  </Svg>
);

// Timeline markers by log entry kind.
export const KindMarker = ({ kind }: { kind: string }) => {
  switch (kind) {
    case 'trigger':
      return <StatusShape status="triggered" />;
    case 'acknowledge':
      return <StatusShape status="acknowledged" />;
    case 'resolve':
      return <StatusShape status="resolved" />;
    case 'assign':
    case 'reassign':
      return (
        <Svg>
          <circle cx="8" cy="5.5" r="2.5" />
          <path d="M3 13.5c.75-2.5 2.75-3.75 5-3.75s4.25 1.25 5 3.75" />
        </Svg>
      );
    case 'escalate':
      return (
        <Svg>
          <path d="M8 13V3M4 7l4-4 4 4" />
        </Svg>
      );
    case 'notify':
      return (
        <Svg>
          <path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z" />
          <path d="M6.5 14h3" />
        </Svg>
      );
    case 'change':
      return (
        <Svg>
          <path d="M8 2v4M8 10v4" />
          <circle cx="8" cy="8" r="2" />
          <path d="M3 4.5h3M10 11.5h3" />
        </Svg>
      );
    case 'commit':
      return (
        <Svg>
          <circle cx="8" cy="8" r="2.5" />
          <path d="M1.5 8h4M10.5 8h4" />
        </Svg>
      );
    case 'annotate':
      return (
        <Svg>
          <path d="M3 2.5h10v8l-3 3H3z" />
          <path d="M5.5 6h5M5.5 8.5h3" />
        </Svg>
      );
    default:
      return (
        <Svg>
          <circle cx="8" cy="8" r="1.75" fill="currentColor" />
        </Svg>
      );
  }
};
