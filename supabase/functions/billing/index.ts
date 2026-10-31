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

// Configuration du portail client : créée une fois puis réutilisée, sans passer par le Dashboard.
async function portalConfig(): Promise<string> {
  const list = await stripe.billingPortal.configurations.list({ active: true, limit: 10 });
  const mine = list.data.find((c) => c.metadata?.app === "kicker-plus") || list.data.find((c) => c.is_default);
  if (mine) return mine.id;
  const prices = [PRICES.month, PRICES.year].filter(Boolean) as string[];
  const product = prices.length ? (await stripe.prices.retrieve(prices[0])).product as string : undefined;
  const c = await stripe.billingPortal.configurations.create({
    metadata: { app: "kicker-plus" },
    business_profile: { headline: "Gère ton abonnement Kicker+" },
    default_return_url: `${APP_URL}/?plus=portal`,
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      ...(product ? { subscription_update: { enabled: true, default_allowed_updates: ["price"], proration_behavior: "create_prorations", products: [{ product, prices }] } } : {}),
    },
  });
  return c.id;
}

// TVA française 20 % incluse dans les prix (2,99 € et 24,99 € sont TTC).
// Créée une fois dans le compte Stripe puis réutilisée, pour qu'elle apparaisse sur les factures.
async function vatRate(): Promise<string> {
  const list = await stripe.taxRates.list({ active: true, limit: 100 });
  const mine = list.data.find((t) => t.metadata?.app === "kicker-plus" && t.inclusive && t.percentage === 20);
  if (mine) return mine.id;
  const t = await stripe.taxRates.create({
    display_name: "TVA", description: "TVA France 20 %", jurisdiction: "FR", country: "FR",
    percentage: 20, inclusive: true, tax_type: "vat", metadata: { app: "kicker-plus" },
  });
  return t.id;
}

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
        configuration: await portalConfig(),
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
        subscription_data: { metadata: { user_id: user.id }, default_tax_rates: [await vatRate()] },
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
