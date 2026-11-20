import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { createHash, randomBytes } from "node:crypto";
import { isFeedmobEmail } from "../config.js";

export interface GoogleSettings { clientId: string; clientSecret: string; callbackUrl: string }
export interface GoogleTransaction { state: string; nonce: string; verifier: string; expires: number }

export function validateGoogleSettings(settings: GoogleSettings): void {
  if (!settings.clientId.trim() || !settings.clientSecret.trim()) throw new Error("Google client ID and secret are required in team mode");
  let url: URL;
  try { url = new URL(settings.callbackUrl); } catch { throw new Error("Google callback must be a valid HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/auth/google/callback") throw new Error("Google callback must be an HTTPS URL ending in /auth/google/callback without credentials, query or fragment");
}

export class GoogleLogin {
  private client: OAuth2Client;
  constructor(readonly settings: GoogleSettings, client?: OAuth2Client) {
    validateGoogleSettings(settings);
    this.client = client ?? new OAuth2Client(settings.clientId, settings.clientSecret, settings.callbackUrl);
  }
  start(now: number): { transaction: GoogleTransaction; url: string } {
    const random = () => randomBytes(32).toString("base64url");
    const transaction = { state: random(), nonce: random(), verifier: random(), expires: now + 5 * 60_000 };
    const challenge = createHash("sha256").update(transaction.verifier).digest("base64url");
    const url = this.client.generateAuthUrl({ redirect_uri: this.settings.callbackUrl, response_type: "code", scope: ["openid", "email"], state: transaction.state, nonce: transaction.nonce, code_challenge: challenge, code_challenge_method: CodeChallengeMethod.S256, hd: "feedmob.com" });
    return { transaction, url };
  }
  async finish(code: string, transaction: GoogleTransaction): Promise<string> {
    const { tokens } = await this.client.getToken({ code, codeVerifier: transaction.verifier, redirect_uri: this.settings.callbackUrl });
    if (!tokens.id_token) throw new Error("Missing identity token");
    const ticket = await this.client.verifyIdToken({ idToken: tokens.id_token, audience: this.settings.clientId });
    const claims = ticket.getPayload();
    const now = Math.floor(Date.now() / 1000);
    if (!claims || !claims.sub || !claims.exp || claims.exp <= now || !claims.iat || claims.iat > now || claims.nonce !== transaction.nonce || claims.email_verified !== true || claims.hd !== "feedmob.com" || !claims.email || !isFeedmobEmail(claims.email) || (claims.azp && claims.azp !== this.settings.clientId)) throw new Error("Identity claims rejected");
    return claims.email.trim().toLowerCase();
  }
}
