import { Fragment, type ClipboardEvent } from 'react';
import {
  parseSafeRichMessageSegments,
  renderMessageToPlainText,
  renderMessageToSafeHtml,
} from '../shared/generators';

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

  const handleCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!event.clipboardData) return;
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    const selectedText = selection?.toString() ?? '';
    if (!selectedText) return;

    event.preventDefault();
    const fullPlain = renderMessageToPlainText(text).trim();
    if (selectedText.trim() === fullPlain) {
      event.clipboardData.setData('text/html', renderMessageToSafeHtml(text));
      event.clipboardData.setData('text/plain', renderMessageToPlainText(text));
      return;
    }

    // For partial selections inside the dark preview box, clone the selection fragment
    // and strip Tailwind classes / inline styles so pasted text has no dark background.
    if (selection && selection.rangeCount > 0) {
      const wrapper = document.createElement('div');
      wrapper.appendChild(selection.getRangeAt(0).cloneContents());
      wrapper.querySelectorAll('*').forEach((el) => {
        el.removeAttribute('class');
        el.removeAttribute('style');
      });
      event.clipboardData.setData('text/html', `<div>${wrapper.innerHTML}</div>`);
      event.clipboardData.setData('text/plain', selectedText);
    } else {
      event.clipboardData.setData('text/plain', selectedText);
    }
  };

  return (
    <div
      data-testid={testId}
      onCopy={handleCopy}
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
