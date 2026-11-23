import { Check, Copy, Link2, Mail, MessageSquare, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { copyRichMessageToClipboard, copyTextToClipboard } from '../lib/api';
import {
  messageHasLinks,
  renderMessageToPlainText,
  renderPreApprovalMessage,
} from '../shared/generators';
import type {
  OrderRecord,
  PickupChannel,
  PreApprovalTemplate,
  TrackedItem,
} from '../shared/types';
import { RichMessagePreview } from './RichMessagePreview';

interface PreApprovalModalProps {
  open: boolean;
  order: OrderRecord | null;
  customerName: string;
  initialMessage: string;
  initialTemplateId?: string | null;
  templates: PreApprovalTemplate[];
  items: TrackedItem[];
  channels: PickupChannel[];
  onClose: () => void;
}

export function PreApprovalModal({
  open,
  order,
  customerName,
  initialMessage,
  initialTemplateId,
  templates,
  items,
  channels,
  onClose,
}: PreApprovalModalProps) {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [message, setMessage] = useState(initialMessage);
  const [copiedMode, setCopiedMode] = useState<'rich' | 'plain' | null>(null);

  useEffect(() => {
    if (!open) return;
    setMessage(initialMessage);
    setCopiedMode(null);
    const defaultId =
      (initialTemplateId && templates.some((t) => t.id === initialTemplateId)
        ? initialTemplateId
        : templates.find((t) => t.isDefault)?.id ?? templates[0]?.id) ?? '';
    setSelectedTemplateId(defaultId);
  }, [initialMessage, initialTemplateId, open, templates]);

  const activeTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId]
  );

  if (!open) return null;

  const hasLinks = messageHasLinks(message);
  const isHtmlTemplate = (activeTemplate?.format ?? 'html') === 'html';

  const handleSelectTemplate = (tmpl: PreApprovalTemplate) => {
    setSelectedTemplateId(tmpl.id);
    setCopiedMode(null);
    if (order) {
      setMessage(
        renderPreApprovalMessage({
          template: tmpl.body,
          order,
          items,
          channels,
        })
      );
    } else {
      setMessage(tmpl.body);
    }
  };

  const handlePrimaryCopy = async () => {
    const ok =
      isHtmlTemplate && hasLinks
        ? await copyRichMessageToClipboard(message)
        : await copyTextToClipboard(renderMessageToPlainText(message));
    if (ok) {
      setCopiedMode(isHtmlTemplate && hasLinks ? 'rich' : 'plain');
      setTimeout(() => setCopiedMode(null), 2500);
    }
  };

  const handleCopyPlain = async () => {
    const ok = await copyTextToClipboard(renderMessageToPlainText(message));
    if (ok) {
      setCopiedMode('plain');
      setTimeout(() => setCopiedMode(null), 2500);
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
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-lg border border-[#283340] bg-[#161D24] text-[#E6EDF3]">
        <div className="flex items-center justify-between border-b border-[#283340] px-6 py-4">
          <div>
            <h2 className="font-['Plus_Jakarta_Sans'] text-lg font-bold text-[#F0F6FC]">
              Pre-Approved — Ready to Copy
            </h2>
            <p className="mt-0.5 text-xs text-[#8B949E]">
              {customerName} has been marked Pre-Approved. Pick a template and copy to send.
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

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {/* Template Switcher */}
          {templates.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-[#C9D1D9]">Template</span>
                {activeTemplate &&
                  (activeTemplate.channelIds.length > 0 || activeTemplate.itemIds.length > 0) &&
                  activeTemplate.id === initialTemplateId && (
                    <span className="text-[11px] font-medium text-[#4ADE80]">
                      Auto-matched for this order
                    </span>
                  )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {templates.map((tmpl) => {
                  const selected = tmpl.id === selectedTemplateId;
                  return (
                    <button
                      key={tmpl.id}
                      type="button"
                      data-testid={`pre-approval-template-btn-${tmpl.id}`}
                      onClick={() => handleSelectTemplate(tmpl)}
                      className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                        selected
                          ? 'border-[#38BDF8] bg-[#0EA5E9]/20 text-[#F0F6FC]'
                          : 'border-[#283340] bg-[#0F1419] text-[#C9D1D9] hover:border-[#38BDF8]/60'
                      }`}
                    >
                      {tmpl.format === 'html' ? (
                        <Mail className="h-3.5 w-3.5 text-[#38BDF8]" aria-hidden="true" />
                      ) : (
                        <MessageSquare className="h-3.5 w-3.5 text-[#8B949E]" aria-hidden="true" />
                      )}
                      <span>{tmpl.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Live Preview when HTML / Links are present */}
          {(isHtmlTemplate || hasLinks) && (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="inline-flex items-center gap-1.5 font-medium text-[#C9D1D9]">
                  <Link2 className="h-3.5 w-3.5 text-[#38BDF8]" aria-hidden="true" />
                  Preview (How links appear in Email)
                </span>
                {hasLinks && (
                  <span className="text-[11px] text-[#8B949E]">
                    Copies clickable links for Gmail / Mail
                  </span>
                )}
              </div>
              <RichMessagePreview text={message} testId="pre-approval-preview" />
            </div>
          )}

          <div>
            <label
              htmlFor="pre-approve-msg"
              className="mb-1.5 block text-xs font-medium text-[#C9D1D9]"
            >
              Message Source (Editable before copying — supports{' '}
              <code className="font-mono text-[11px] text-[#38BDF8]">
                &lt;a href=&quot;https://...&quot;&gt;text&lt;/a&gt;
              </code>
              )
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
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#283340] px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] rounded-md border border-[#283340] bg-[#1E2730] px-4 py-2 text-sm font-medium text-[#C9D1D9]"
          >
            Done
          </button>

          {isHtmlTemplate && hasLinks && (
            <button
              type="button"
              data-testid="copy-pre-approval-plain-btn"
              onClick={() => void handleCopyPlain()}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-[#283340] bg-[#0F1419] px-3.5 py-2 text-xs font-semibold text-[#E6EDF3] transition-colors hover:border-[#38BDF8]"
            >
              {copiedMode === 'plain' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-[#4ADE80]" />
                  Copied Plain Text!
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy Plain Text
                </>
              )}
            </button>
          )}

          <button
            type="button"
            data-testid="copy-pre-approval-btn"
            onClick={() => void handlePrimaryCopy()}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-md bg-[#0EA5E9] px-5 py-2 text-sm font-semibold text-[#0B1117] transition-colors hover:bg-[#38BDF8]"
          >
            {copiedMode === 'rich' || (copiedMode === 'plain' && !(isHtmlTemplate && hasLinks)) ? (
              <>
                <Check className="h-4 w-4" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" />
                {isHtmlTemplate && hasLinks ? 'Copy Email (with Links)' : 'Copy Message'}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
