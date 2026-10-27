// The workbench has no API to turn Settings Sync on after startup. The one entry point is the
// native action `workbench.userDataSync.actions.turnOn` (userDataSync.ts `turnOn`): it shows a
// "which settings" quick pick, then an account quick pick when the provider has a session.
// Accepting both runs the native flow with its defaults; quick inputs stay hidden meanwhile.

export interface QuickInputWidget {
  style: { display: string };
  querySelector(selector: string): { textContent: string | null } | null;
}

interface QuickInputRoot {
  querySelector(selector: string): QuickInputWidget | null;
}

interface AcceptOptions {
  /** Hides (true) or shows (false) every quick input; called before `run` starts and after it ends. */
  hide(hidden: boolean): void;
  root?: QuickInputRoot;
  timeoutMs?: number;
}

const WIDGET = '.quick-input-widget';
const TITLE = '.quick-input-title';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Runs `run` while accepting every Settings Sync quick input it opens. Other quick inputs are
 * not accepted. Rejects with what `run` rejects with, or when the flow takes longer than `timeoutMs`.
 */
export async function acceptSyncQuickInputs(run: () => Promise<unknown>, accept: () => Promise<unknown>, options: AcceptOptions): Promise<void> {
  const root = options.root ?? document as unknown as QuickInputRoot;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  options.hide(true);
  try {
    let settled = false;
    const pending = run().finally(() => { settled = true; });
    pending.catch(() => undefined);
    while (!settled) {
      if (Date.now() > deadline) throw new Error('Settings Sync turn-on timed out.');
      await Promise.race([sleep(20), pending.catch(() => undefined)]);
      const widget = root.querySelector(WIDGET);
      if (!settled && widget && widget.style.display !== 'none' && /sync/i.test(widget.querySelector(TITLE)?.textContent ?? '')) await accept();
    }
    await pending;
  } finally {
    options.hide(false);
  }
}
