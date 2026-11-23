import { Fragment } from 'react';
import { parseSafeRichMessageSegments } from '../shared/generators';

interface RichMessagePreviewProps {
  text: string;
  testId?: string;
}

/**
 * Safely renders a message containing optional HTML <a href="https://...">,
 * Markdown [label](https://...), or bare https:// URLs using pure React elements
 * (never uses dangerouslySetInnerHTML).
 */
export function RichMessagePreview({ text, testId }: RichMessagePreviewProps) {
  const segments = parseSafeRichMessageSegments(text);

  return (
    <div
      data-testid={testId}
      className="rounded-md border border-[#283340] bg-[#0B1117] px-3.5 py-3 text-sm leading-relaxed text-[#E6EDF3]"
    >
      {segments.length === 0 ? (
        <span className="text-xs text-[#6E7681]">Message preview will appear here...</span>
      ) : (
        segments.map((seg, idx) => {
          if (seg.type === 'newline') {
            return <br key={idx} />;
          }
          if (seg.type === 'link') {
            return (
              <a
                key={idx}
                href={seg.href}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-[#38BDF8] underline decoration-[#38BDF8]/60 underline-offset-2 hover:text-[#7DD3FC]"
              >
                {seg.label}
              </a>
            );
          }
          return <Fragment key={idx}>{seg.text}</Fragment>;
        })
      )}
    </div>
  );
}
