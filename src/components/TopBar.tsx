import { Menu, Plus, X } from 'lucide-react';
import { useState } from 'react';

export type ActiveTab = 'calendar' | 'orders' | 'standing' | 'snippet' | 'settings';

interface TopBarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onQuickAdd: () => void;
}

const NAV_ITEMS: Array<{ id: ActiveTab; label: string; testId: string }> = [
  { id: 'calendar', label: 'Calendar', testId: 'nav-calendar' },
  { id: 'orders', label: 'Orders', testId: 'nav-orders' },
  { id: 'standing', label: 'Standing Orders', testId: 'nav-standing' },
  { id: 'snippet', label: 'Availability Snippet', testId: 'nav-snippet' },
  { id: 'settings', label: 'Settings', testId: 'nav-settings' },
];

export function TopBar({ activeTab, onSelectTab, onQuickAdd }: TopBarProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleSelect = (tab: ActiveTab) => {
    onSelectTab(tab);
    setMobileMenuOpen(false);
  };

  return (
    <header className="sticky top-0 z-30 border-b border-[#283340] bg-[#0F1419]">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 md:gap-8 md:px-6 md:py-3.5">
        <button
          type="button"
          onClick={() => handleSelect('calendar')}
          data-testid="brand-title"
          className="shrink-0 whitespace-nowrap font-['Plus_Jakarta_Sans'] text-base font-bold tracking-tight text-[#F0F6FC] transition-colors hover:text-[#38BDF8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#38BDF8] md:text-lg"
        >
          Farm Waitlist
        </button>

        {/* Desktop 3-Zone Navigation */}
        <nav className="hidden items-center gap-6 md:flex" aria-label="Primary Navigation">
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-testid={item.testId}
                onClick={() => handleSelect(item.id)}
                className={`relative shrink-0 whitespace-nowrap py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#38BDF8] ${
                  isActive
                    ? 'text-[#F0F6FC] after:absolute after:inset-x-0 after:-bottom-[15px] after:h-[2px] after:bg-[#38BDF8]'
                    : 'text-[#8B949E] hover:text-[#E6EDF3]'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            data-testid="quick-add-order-btn"
            onClick={onQuickAdd}
            className="inline-flex min-h-[38px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-[#0EA5E9] px-3 py-1.5 text-xs font-semibold text-[#0B1117] transition-colors hover:bg-[#38BDF8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#38BDF8] md:min-h-[40px] md:gap-2 md:px-4 md:py-2 md:text-sm"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Quick Add Order</span>
            <span className="sm:hidden">Add Order</span>
          </button>

          {/* Mobile Menu Toggle */}
          <button
            type="button"
            data-testid="mobile-nav-toggle"
            aria-expanded={mobileMenuOpen}
            aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-md border border-[#283340] bg-[#161D24] text-[#E6EDF3] hover:border-[#38BDF8] md:hidden"
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Non-overlapping Mobile Slide-Down Navigation Sheet */}
      {mobileMenuOpen && (
        <>
          <div
            className="fixed inset-0 top-[59px] z-20 bg-black/60 md:hidden"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <nav
            data-testid="mobile-nav-drawer"
            aria-label="Mobile Navigation"
            className="relative z-30 border-t border-[#283340] bg-[#161D24] px-4 py-2 md:hidden"
          >
            <div className="flex flex-col divide-y divide-[#283340]/70">
              {NAV_ITEMS.map((item) => {
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`mobile-${item.testId}`}
                    onClick={() => handleSelect(item.id)}
                    className={`flex min-h-[44px] w-full items-center justify-between px-2 py-2.5 text-left text-sm font-medium ${
                      isActive ? 'text-[#38BDF8]' : 'text-[#E6EDF3]'
                    }`}
                  >
                    <span>{item.label}</span>
                    {isActive && <span className="text-xs font-normal text-[#8B949E]">Current</span>}
                  </button>
                );
              })}
            </div>
          </nav>
        </>
      )}
    </header>
  );
}
