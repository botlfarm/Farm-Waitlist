import { Check, Copy, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { copyTextToClipboard } from '../lib/api';

interface PreApprovalModalProps {
  open: boolean;
  customerName: string;
  initialMessage: string;
  onClose: () => void;
}

export function PreApprovalModal({
  open,
  customerName,
  initialMessage,
  onClose,
}: PreApprovalModalProps) {
  const [message, setMessage] = useState(initialMessage);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setMessage(initialMessage);
    setCopied(false);
  }, [initialMessage, open]);

  if (!open) return null;

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(message);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4"
      data-testid="pre-approval-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Pre-Approval Copy Message"
    >
      <div className="w-full max-w-lg rounded-lg border border-[#283340] bg-[#161D24] text-[#E6EDF3]">
        <div className="flex items-center justify-between border-b border-[#283340] px-6 py-4">
          <div>
            <h2 className="font-['Plus_Jakarta_Sans'] text-lg font-bold text-[#F0F6FC]">
              Pre-Approved — Ready to Copy
            </h2>
            <p className="mt-0.5 text-xs text-[#8B949E]">
              {customerName} has been marked Pre-Approved. Copy and paste this message to send manually.
            </p>
          </div>
          <button
            type="button"
            data-testid="close-pre-approval-modal-btn"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-md text-[#8B949E] hover:bg-[#1E2730] hover:text-[#F0F6FC]"
            aria-label="Close pre-approval modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-5">
          <label htmlFor="pre-approve-msg" className="mb-1.5 block text-xs font-medium text-[#C9D1D9]">
            Message Text (Editable before copying)
          </label>
          <textarea
            id="pre-approve-msg"
            data-testid="pre-approval-message-textarea"
            rows={5}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="w-full rounded-md border border-[#283340] bg-[#0F1419] p-3 text-sm leading-relaxed text-[#F0F6FC] focus:border-[#38BDF8] focus:outline-none"
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[#283340] px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] rounded-md border border-[#283340] bg-[#1E2730] px-4 py-2 text-sm font-medium text-[#C9D1D9]"
          >
            Done
          </button>
          <button
            type="button"
            data-testid="copy-pre-approval-btn"
            onClick={() => void handleCopy()}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-md bg-[#0EA5E9] px-5 py-2 text-sm font-semibold text-[#0B1117] transition-colors hover:bg-[#38BDF8]"
          >
            {copied ? (
              <>
                <Check className="h-4 w-4" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" />
                Copy Message
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
