// Kicker+ : ouverture du paiement Stripe et du portail d'abonnement.
// Appelée par l'app connectée (JWT requis).
//   POST { action: "checkout", plan: "month" | "year", waiver: true }
//   POST { action: "portal" }
// Secrets requis : STRIPE_SECRET_KEY, STRIPE_PRICE_MONTH, STRIPE_PRICE_YEAR, APP_URL
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { httpClient: Stripe.createFetchHttpClient() });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const APP_URL = (Deno.env.get("APP_URL") || "https://www.kicker-game.com").replace(/\/$/, "");
const PRICES: Record<string, string | undefined> = {
  month: Deno.env.get("STRIPE_PRICE_MONTH"),
  year: Deno.env.get("STRIPE_PRICE_YEAR"),
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: "auth" }, 401);

  let body: { action?: string; plan?: string; waiver?: boolean } = {};
  try { body = await req.json(); } catch { /* corps vide */ }

  const { data: sub } = await admin.from("subscriptions")
    .select("stripe_customer_id,status").eq("user_id", user.id).maybeSingle();

  try {
    if (body.action === "portal") {
      if (!sub?.stripe_customer_id) return json({ error: "no_customer" }, 400);
      const s = await stripe.billingPortal.sessions.create({
        customer: sub.stripe_customer_id, return_url: `${APP_URL}/?plus=portal`,
      });
      return json({ url: s.url });
    }

    if (body.action === "checkout") {
      const price = PRICES[body.plan || ""];
      if (!price) return json({ error: "plan" }, 400);
      // Droit de rétractation : l'accès démarre tout de suite, l'utilisateur doit l'avoir accepté.
      if (body.waiver !== true) return json({ error: "waiver" }, 400);
      if (sub && ["active", "trialing", "past_due"].includes(sub.status)) return json({ error: "already" }, 409);

      let customer = sub?.stripe_customer_id;
      if (!customer) {
        const c = await stripe.customers.create({ email: user.email, metadata: { user_id: user.id } });
        customer = c.id;
        await admin.from("subscriptions").upsert(
          { user_id: user.id, stripe_customer_id: customer, updated_at: new Date().toISOString() },
          { onConflict: "user_id" },
        );
      }
      const s = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer,
        client_reference_id: user.id,
        line_items: [{ price, quantity: 1 }],
        allow_promotion_codes: true,
        locale: "fr",
        metadata: { user_id: user.id, waiver_at: new Date().toISOString() },
        subscription_data: { metadata: { user_id: user.id } },
        success_url: `${APP_URL}/?plus=ok`,
        cancel_url: `${APP_URL}/?plus=cancel`,
      });
      return json({ url: s.url });
    }

    return json({ error: "action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "stripe" }, 502);
  }
});
