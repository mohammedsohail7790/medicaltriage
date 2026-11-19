// NFR-020: client side of the sign-in security check.

export type SelfChallenge = { algorithm: "SHA-256"; salt: string; challenge: string; maxnumber: number; signature: string };
export type CaptchaPrompt = {
  provider: "self" | "turnstile" | "hcaptcha" | "recaptcha" | "custom";
  reason?: string;
  siteKey?: string;
  challenge?: SelfChallenge;
};

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Finds the number the server hid in the challenge. A fraction of a second at the default difficulty. */
export async function solveSelfChallenge(challenge: SelfChallenge): Promise<string> {
  for (let n = 0; n <= challenge.maxnumber; n += 1) {
    if ((await sha256Hex(`${challenge.salt}${n}`)) === challenge.challenge) {
      return btoa(JSON.stringify({ salt: challenge.salt, challenge: challenge.challenge, number: n, signature: challenge.signature }));
    }
  }
  throw new Error("The security check could not be completed.");
}

const WIDGETS: Record<string, { script: string; global: string }> = {
  turnstile: { script: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", global: "turnstile" },
  hcaptcha: { script: "https://js.hcaptcha.com/1/api.js?render=explicit", global: "hcaptcha" },
  recaptcha: { script: "https://www.google.com/recaptcha/api.js?render=explicit", global: "grecaptcha" }
};

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("The security check could not be loaded."));
    document.head.appendChild(el);
  });
}

/** Shows a third-party widget in `container` and calls `onToken` with the answer. */
export async function renderCaptchaWidget(prompt: CaptchaPrompt, container: HTMLElement, onToken: (token: string) => void): Promise<void> {
  const widget = WIDGETS[prompt.provider];
  if (!widget || !prompt.siteKey) throw new Error("This security check method is not supported here.");
  await loadScript(widget.script);
  const api = (window as unknown as Record<string, { render: (el: HTMLElement, options: Record<string, unknown>) => void; ready?: (fn: () => void) => void }>)[widget.global];
  const render = () => api.render(container, { sitekey: prompt.siteKey, callback: onToken });
  if (api.ready) api.ready(render);
  else render();
}
