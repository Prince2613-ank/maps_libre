// Google sign-in for room booking, following the Cesium app (cesium_demo/src/calendar.ts):
// Google Identity Services token client, same OAuth client and scopes, @flodataanalytics.com accounts only,
// session kept for the token's lifetime. Calendar calls go straight to the REST API with the access token.

const DEFAULT_GOOGLE_CLIENT_ID = "953961693663-56gksfsa1l459umnln85uf8l5vet8fev.apps.googleusercontent.com";
const CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? DEFAULT_GOOGLE_CLIENT_ID;
export const ALLOWED_DOMAIN = "flodataanalytics.com";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile"
].join(" ");
const STORAGE_KEY = "maplibre-indoor:google-auth";
const TOKEN_LIFETIME_MS = 3500 * 1000; // Google access tokens last an hour

export type GoogleUser = { email: string; name: string; token: string };

declare const google: any;

let tokenClient: any = null;
let user: GoogleUser | null = null;
const listeners = new Set<(user: GoogleUser | null) => void>();

export const currentUser = () => user;

export function onUserChange(listener: (user: GoogleUser | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setUser(next: GoogleUser | null): void {
  user = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, expiresAt: Date.now() + TOKEN_LIFETIME_MS }));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the session just won't survive a reload.
  }
  for (const listener of listeners) listener(next);
}

function loadGis(): Promise<void> {
  if ((globalThis as any).google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load Google sign-in"));
    document.head.appendChild(script);
  });
}

/** Check the token belongs to an allowed account and make it the current user. */
async function verify(token: string): Promise<GoogleUser> {
  const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`Sign-in check failed (${response.status})`);
  const info = (await response.json()) as { email?: string; name?: string };
  const email = info.email ?? "";
  if (!email.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`)) {
    try {
      google.accounts.oauth2.revoke(token, () => {});
    } catch {
      // GIS not loaded (restored session): nothing to revoke through.
    }
    throw new Error(`Room booking is limited to @${ALLOWED_DOMAIN} accounts (signed in as ${email || "unknown"}).`);
  }
  const verified = { email, name: info.name ?? email.split("@")[0], token };
  setUser(verified);
  return verified;
}

/** Restore a saved session from this browser, if it hasn't expired. */
export async function restoreSession(): Promise<GoogleUser | null> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!saved?.token || !(saved.expiresAt > Date.now())) return null;
    return await verify(saved.token);
  } catch {
    setUser(null);
    return null;
  }
}

/** Open the Google sign-in popup (call from a click). */
export async function signIn(): Promise<GoogleUser> {
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient ??= google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPES, callback: () => {} });
    tokenClient.callback = (response: { access_token?: string; error?: string; error_description?: string }) => {
      if (!response.access_token) return reject(new Error(response.error_description || response.error || "Sign-in cancelled"));
      verify(response.access_token).then(resolve, reject);
    };
    tokenClient.error_callback = (error: { type?: string; message?: string }) =>
      reject(new Error(error.type === "popup_closed" ? "Sign-in cancelled" : error.message || error.type || "Sign-in failed"));
    tokenClient.requestAccessToken({ prompt: "consent" });
  });
}

export function signOut(): void {
  const token = user?.token;
  if (token) {
    try {
      google.accounts.oauth2.revoke(token, () => {});
    } catch {
      // GIS not loaded: the token simply expires.
    }
  }
  setUser(null);
}

/** Authenticated Google API call; signs out when the token is no longer valid. */
export async function googleApi<T>(url: string, init: RequestInit = {}): Promise<T> {
  if (!user) throw new Error("Not signed in");
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" }
  });
  if (response.status === 401) {
    setUser(null);
    throw new Error("Your Google session expired. Please sign in again.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Google API error ${response.status}`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}
