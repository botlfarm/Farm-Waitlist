import { Check, Copy, Link2, Mail, MessageSquare, Phone, Send, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { copyRichMessageToClipboard, copyTextToClipboard } from '../lib/api';
import {
  buildPreApprovalMailtoHref,
  messageHasLinks,
  renderMessageToPlainText,
  renderPreApprovalMessage,
} from '../shared/generators';
import type {
  OrderRecord,
  PickupChannel,
  PreApprovalTemplate,
  SnippetCutoffRule,
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
  holdThresholdHours?: number;
  timezone?: string;
  publicSnippetCutoffRules?: SnippetCutoffRule[];
  publicSnippetShowSameDay?: boolean;
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
  holdThresholdHours,
  timezone,
  publicSnippetCutoffRules,
  publicSnippetShowSameDay,
  onClose,
}: PreApprovalModalProps) {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [message, setMessage] = useState(initialMessage);
  const [copiedMode, setCopiedMode] = useState<'rich' | 'plain' | null>(null);
  const [copiedContact, setCopiedContact] = useState<'email' | 'phone' | null>(null);

  useEffect(() => {
    if (!open) return;
    setMessage(initialMessage);
    setCopiedMode(null);
    setCopiedContact(null);
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

  const customerEmail = (order?.customerEmail ?? '').trim();
  const customerPhone = (order?.customerPhone ?? '').trim();

  const mailtoHref = useMemo(
    () =>
      buildPreApprovalMailtoHref({
        email: customerEmail,
        order,
        message,
      }),
    [customerEmail, order, message]
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
          holdThresholdHours,
          timezone,
          publicSnippetCutoffRules,
          publicSnippetShowSameDay,
        })
      );
    } else {
      setMessage(tmpl.body);
    }
  };

  const handleCopyContact = async (kind: 'email' | 'phone', value: string) => {
    if (!value) return;
    const ok = await copyTextToClipboard(value);
    if (ok) {
      setCopiedContact(kind);
      setTimeout(() => setCopiedContact((curr) => (curr === kind ? null : curr)), 2200);
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
              {customerName} has been marked Pre-Approved. Pick a template and copy or email to send.
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
          {/* Customer Contact Details (Direct Copy + Mailto) */}
          <div
            data-testid="pre-approval-contact-card"
            className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
          >
            <div className="flex items-center justify-between gap-2 rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#8B949E]">
                  <Mail className="h-3 w-3 text-[#38BDF8]" aria-hidden="true" />
                  Email
                </div>
                <div
                  data-testid="pre-approval-customer-email"
                  title={customerEmail || 'No email on file'}
                  className={`mt-0.5 truncate text-xs font-medium select-all ${
                    customerEmail ? 'text-[#F0F6FC]' : 'italic text-[#6E7681]'
                  }`}
                >
                  {customerEmail || 'Not on file'}
                </div>
              </div>
              {customerEmail && (
                <button
                  type="button"
                  data-testid="pre-approval-copy-email-btn"
                  onClick={() => void handleCopyContact('email', customerEmail)}
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded border border-[#283340] bg-[#161D24] px-2 text-[11px] font-medium text-[#C9D1D9] transition-colors hover:border-[#38BDF8] hover:text-[#F0F6FC]"
                  title="Copy customer email"
                >
                  {copiedContact === 'email' ? (
                    <>
                      <Check className="h-3 w-3 text-[#4ADE80]" />
                      <span className="text-[#4ADE80]">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 rounded-md border border-[#283340] bg-[#0F1419] px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#8B949E]">
                  <Phone className="h-3 w-3 text-[#38BDF8]" aria-hidden="true" />
                  Phone
                </div>
                <div
                  data-testid="pre-approval-customer-phone"
                  title={customerPhone || 'No phone on file'}
                  className={`mt-0.5 truncate text-xs font-medium select-all ${
                    customerPhone ? 'text-[#F0F6FC]' : 'italic text-[#6E7681]'
                  }`}
                >
                  {customerPhone || 'Not on file'}
                </div>
              </div>
              {customerPhone && (
                <button
                  type="button"
                  data-testid="pre-approval-copy-phone-btn"
                  onClick={() => void handleCopyContact('phone', customerPhone)}
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded border border-[#283340] bg-[#161D24] px-2 text-[11px] font-medium text-[#C9D1D9] transition-colors hover:border-[#38BDF8] hover:text-[#F0F6FC]"
                  title="Copy customer phone"
                >
                  {copiedContact === 'phone' ? (
                    <>
                      <Check className="h-3 w-3 text-[#4ADE80]" />
                      <span className="text-[#4ADE80]">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>

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

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#283340] px-6 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] rounded-md border border-[#283340] bg-[#1E2730] px-4 py-2 text-sm font-medium text-[#C9D1D9] hover:text-[#F0F6FC]"
            >
              Done
            </button>

            {mailtoHref && (
              <a
                href={mailtoHref}
                data-testid="pre-approval-mailto-link"
                title={
                  customerEmail
                    ? `Open your email app addressed to ${customerEmail} with plain-text message pre-filled`
                    : 'Open your email app with plain-text message pre-filled'
                }
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-[#38BDF8]/50 bg-[#0EA5E9]/10 px-3.5 py-2 text-xs font-semibold text-[#38BDF8] transition-colors hover:border-[#38BDF8] hover:bg-[#0EA5E9]/20"
              >
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
                Open in Email
              </a>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
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
    </div>
  );
}
