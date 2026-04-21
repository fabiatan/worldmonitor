/**
 * Checkout service for the /pro marketing page.
 *
 * Handles: Clerk sign-in → edge endpoint → Dodo overlay.
 * No Convex client needed — the edge endpoint handles relay.
 */

import * as Sentry from '@sentry/react';
import type { Clerk } from '@clerk/clerk-js';
import type { CheckoutEvent } from 'dodopayments-checkout';

const API_BASE = 'https://api.worldmonitor.app/api';
const DODO_PORTAL_FALLBACK_URL = 'https://customer.dodopayments.com';
const ACTIVE_SUBSCRIPTION_EXISTS = 'ACTIVE_SUBSCRIPTION_EXISTS';

const MONO_FONT = "'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', monospace";

let clerk: InstanceType<typeof Clerk> | null = null;
let pendingProductId: string | null = null;
let pendingOptions: { referralCode?: string; discountCode?: string } | null = null;
let checkoutInFlight = false;
let clerkLoadPromise: Promise<InstanceType<typeof Clerk>> | null = null;

export async function ensureClerk(): Promise<InstanceType<typeof Clerk>> {
  if (clerk) return clerk;
  if (clerkLoadPromise) return clerkLoadPromise;
  clerkLoadPromise = _loadClerk().catch((err) => {
    clerkLoadPromise = null;
    throw err;
  });
  return clerkLoadPromise;
}

async function _loadClerk(): Promise<InstanceType<typeof Clerk>> {
  const { Clerk: C } = await import('@clerk/clerk-js');
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!key) throw new Error('VITE_CLERK_PUBLISHABLE_KEY not set');
  const instance = new C(key);
  await instance.load({
    appearance: {
      variables: {
        colorBackground: '#0f0f0f',
        colorInputBackground: '#141414',
        colorInputText: '#e8e8e8',
        colorText: '#e8e8e8',
        colorTextSecondary: '#aaaaaa',
        colorPrimary: '#44ff88',
        colorNeutral: '#e8e8e8',
        colorDanger: '#ff4444',
        borderRadius: '4px',
        fontFamily: MONO_FONT,
        fontFamilyButtons: MONO_FONT,
      },
      elements: {
        card: { backgroundColor: '#111111', border: '1px solid #2a2a2a', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' },
        formButtonPrimary: { color: '#000000', fontWeight: '600' },
        footerActionLink: { color: '#44ff88' },
        socialButtonsBlockButton: { borderColor: '#2a2a2a', color: '#e8e8e8', backgroundColor: '#141414' },
      },
    },
  });

  // Only publish the instance after load() succeeds, so a failed load
  // doesn't wedge ensureClerk()'s `if (clerk) return clerk;` short-circuit
  // and bypass the retry path.
  clerk = instance;

  // Auto-resume checkout after sign-in
  clerk.addListener(() => {
    if (clerk?.user && pendingProductId) {
      const pid = pendingProductId;
      const opts = pendingOptions;
      pendingProductId = null;
      pendingOptions = null;
      doCheckout(pid, opts ?? {});
    }
  });

  return clerk;
}

export function initOverlay(onSuccess?: () => void): void {
  import('dodopayments-checkout').then(({ DodoPayments }) => {
    const env = import.meta.env.VITE_DODO_ENVIRONMENT;
    DodoPayments.Initialize({
      mode: env === 'live_mode' ? 'live' : 'test',
      displayType: 'overlay',
      onEvent: (event: CheckoutEvent) => {
        if (event.event_type === 'checkout.status') {
          const status = (event.data as Record<string, unknown>)?.status
            ?? ((event.data as Record<string, unknown>)?.message as Record<string, unknown>)?.status;
          if (status === 'succeeded') {
            onSuccess?.();
          }
        }
      },
    });
  }).catch((err) => {
    console.error('[checkout] Failed to load Dodo overlay SDK:', err);
  });
}

export async function startCheckout(
  productId: string,
  options?: { referralCode?: string; discountCode?: string },
): Promise<boolean> {
  if (checkoutInFlight) return false;

  let c: InstanceType<typeof Clerk>;
  try {
    c = await ensureClerk();
  } catch (err) {
    console.error('[checkout] Failed to load Clerk:', err);
    Sentry.captureException(err, { tags: { surface: 'pro-marketing', action: 'load-clerk' } });
    return false;
  }

  if (!c.user) {
    pendingProductId = productId;
    pendingOptions = options ?? null;
    try {
      c.openSignIn();
    } catch (err) {
      console.error('[checkout] Failed to open sign in:', err);
      Sentry.captureException(err, { tags: { surface: 'pro-marketing', action: 'checkout-sign-in' } });
      pendingProductId = null;
      pendingOptions = null;
    }
    return false;
  }

  return doCheckout(productId, options ?? {});
}

async function doCheckout(
  productId: string,
  options: { referralCode?: string; discountCode?: string },
): Promise<boolean> {
  if (checkoutInFlight) return false;
  checkoutInFlight = true;

  try {
    const token = await getAuthToken();
    if (!token) {
      console.error('[checkout] No auth token after retry');
      return false;
    }

    const resp = await fetch(`${API_BASE}/create-checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        productId,
        returnUrl: 'https://worldmonitor.app',
        discountCode: options.discountCode,
        referralCode: options.referralCode,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('[checkout] Edge error:', resp.status, err);
      if (resp.status === 409 && err?.error === ACTIVE_SUBSCRIPTION_EXISTS) {
        // Confirm with the user before taking them to the portal.
        // Uses the whitelisted plan name ONLY — raw server message is
        // logged to Sentry above but never rendered. Dialog is inline
        // here (no shared component with main app — /pro is a separate
        // build). Same semantics: confirm → new-tab portal, dismiss →
        // stay in place.
        const planKey = err?.subscription?.planKey;
        showProDuplicateSubscriptionDialog({
          planDisplayName: resolveProPlanDisplayName(planKey),
          onConfirm: () => { void openBillingPortal(token); },
          onDismiss: () => { /* stay on /pro */ },
        });
        Sentry.captureMessage('Duplicate subscription checkout attempt', {
          level: 'info',
          tags: { surface: 'pro-marketing', code: 'duplicate_subscription' },
          extra: { serverMessage: err?.message },
        });
      }
      return false;
    }

    const result = await resp.json();
    if (!result?.checkout_url) {
      console.error('[checkout] No checkout_url in response');
      return false;
    }

    const { DodoPayments } = await import('dodopayments-checkout');
    DodoPayments.Checkout.open({
      checkoutUrl: result.checkout_url,
      options: {
        manualRedirect: true,
        themeConfig: {
          dark: {
            bgPrimary: '#0d0d0d',
            bgSecondary: '#1a1a1a',
            borderPrimary: '#323232',
            textPrimary: '#ffffff',
            textSecondary: '#909090',
            buttonPrimary: '#22c55e',
            buttonPrimaryHover: '#16a34a',
            buttonTextPrimary: '#0d0d0d',
          },
          light: {
            bgPrimary: '#ffffff',
            bgSecondary: '#f8f9fa',
            borderPrimary: '#d4d4d4',
            textPrimary: '#1a1a1a',
            textSecondary: '#555555',
            buttonPrimary: '#16a34a',
            buttonPrimaryHover: '#15803d',
            buttonTextPrimary: '#ffffff',
          },
          radius: '4px',
        },
      },
    });

    return true;
  } catch (err) {
    console.error('[checkout] Failed:', err);
    return false;
  } finally {
    checkoutInFlight = false;
  }
}

async function getAuthToken(): Promise<string | null> {
  let token = await clerk?.session?.getToken({ template: 'convex' }).catch(() => null)
    ?? await clerk?.session?.getToken().catch(() => null);
  if (!token) {
    await new Promise((r) => setTimeout(r, 2000));
    token = await clerk?.session?.getToken({ template: 'convex' }).catch(() => null)
      ?? await clerk?.session?.getToken().catch(() => null);
  }
  return token;
}

async function openBillingPortal(token: string): Promise<void> {
  // Opens in a new tab to match the main-app surface — the /pro page
  // shouldn't disappear underneath the user when they acknowledge
  // "yes, take me to the portal." Previously this used
  // window.location.assign() which replaced /pro with the Dodo portal
  // in the same tab, disorienting the visitor.
  try {
    const resp = await fetch(`${API_BASE}/customer-portal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    const result = await resp.json().catch(() => ({}));
    const url = typeof result?.portal_url === 'string'
      ? result.portal_url
      : DODO_PORTAL_FALLBACK_URL;

    if (!resp.ok) {
      console.error('[checkout] Customer portal error:', resp.status, result);
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (err) {
    console.error('[checkout] Failed to open billing portal:', err);
    window.open(DODO_PORTAL_FALLBACK_URL, '_blank', 'noopener,noreferrer');
  }
}

// ---------------------------------------------------------------------------
// Duplicate-subscription dialog (inline to /pro — separate build from main app)
// ---------------------------------------------------------------------------

const PRO_PLAN_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  pro_monthly: 'Pro Monthly',
  pro_annual: 'Pro Annual',
  api_starter: 'API Starter',
  api_business: 'API Business',
};

function resolveProPlanDisplayName(planKey: unknown): string {
  if (typeof planKey !== 'string' || planKey.length === 0) return 'Pro';
  return PRO_PLAN_DISPLAY_NAMES[planKey] ?? 'Pro';
}

interface ProDuplicateDialogOptions {
  planDisplayName: string;
  onConfirm: () => void;
  onDismiss: () => void;
}

const PRO_DUP_DIALOG_ID = 'wm-pro-duplicate-subscription-dialog';

function showProDuplicateSubscriptionDialog(options: ProDuplicateDialogOptions): void {
  if (document.getElementById(PRO_DUP_DIALOG_ID)) return;

  const backdrop = document.createElement('div');
  backdrop.id = PRO_DUP_DIALOG_ID;
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  Object.assign(backdrop.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '99990',
    background: 'rgba(10, 10, 10, 0.72)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
  });

  const card = document.createElement('div');
  Object.assign(card.style, {
    background: '#141414',
    border: '1px solid #2a2a2a',
    borderRadius: '8px',
    padding: '20px 22px',
    maxWidth: '440px',
    width: '100%',
    color: '#e8e8e8',
    fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', monospace",
    boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
  });

  card.innerHTML = `
    <h2 style="font-size:16px;font-weight:600;margin:0 0 10px 0;color:#fff;">Subscription already active</h2>
    <p style="font-size:13px;line-height:1.5;margin:0 0 18px 0;color:#c8c8c8;">
      Your account already has an active ${escapeHtml(options.planDisplayName)} subscription. Open the billing portal to manage it — you won't be charged twice.
    </p>
    <div style="display:flex;justify-content:flex-end;gap:10px;">
      <button id="${PRO_DUP_DIALOG_ID}-dismiss" type="button" style="background:transparent;color:#aaa;border:1px solid #2a2a2a;border-radius:4px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">Dismiss</button>
      <button id="${PRO_DUP_DIALOG_ID}-confirm" type="button" style="background:#44ff88;color:#0a0a0a;border:none;border-radius:4px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">Open billing portal</button>
    </div>
  `;

  backdrop.appendChild(card);

  let resolved = false;
  const close = () => backdrop.remove();

  document.getElementById(`${PRO_DUP_DIALOG_ID}-confirm`)?.addEventListener('click', () => {
    if (resolved) return;
    resolved = true;
    close();
    options.onConfirm();
  });
  const dismiss = () => {
    if (resolved) return;
    resolved = true;
    close();
    options.onDismiss();
  };
  document.getElementById(`${PRO_DUP_DIALOG_ID}-dismiss`)?.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });
  const keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      document.removeEventListener('keydown', keyHandler, true);
      dismiss();
    }
  };
  document.addEventListener('keydown', keyHandler, true);

  document.body.appendChild(backdrop);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
}
