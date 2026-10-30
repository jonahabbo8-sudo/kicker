// Kicker+ : reçoit les événements Stripe et tient la table subscriptions à jour.
// Déployer SANS vérification JWT (Stripe n'envoie pas de jeton Supabase) :
// la signature Stripe fait office d'authentification.
// Secrets requis : STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_YEAR
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { httpClient: Stripe.createFetchHttpClient() });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const crypto = Stripe.createSubtleCryptoProvider();
const PRICE_YEAR = Deno.env.get("STRIPE_PRICE_YEAR");

async function save(s: Stripe.Subscription) {
  const customer = typeof s.customer === "string" ? s.customer : s.customer.id;
  let userId = s.metadata?.user_id;
  if (!userId) {
    const { data } = await admin.from("subscriptions").select("user_id").eq("stripe_customer_id", customer).maybeSingle();
    userId = data?.user_id;
  }
  if (!userId) { console.warn("abonnement sans utilisateur", s.id); return; }
  const item = s.items?.data?.[0];
  // Selon la version de l'API, la fin de période est sur l'abonnement ou sur la ligne.
  // deno-lint-ignore no-explicit-any
  const end = (s as any).current_period_end ?? (item as any)?.current_period_end;
  const { error } = await admin.from("subscriptions").upsert({
    user_id: userId,
    stripe_customer_id: customer,
    stripe_subscription_id: s.id,
    status: s.status,
    plan: item?.price?.id === PRICE_YEAR ? "year" : "month",
    current_period_end: end ? new Date(end * 1000).toISOString() : null,
    cancel_at_period_end: s.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) throw error;
}

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("signature manquante", { status: 400 });
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, Deno.env.get("STRIPE_WEBHOOK_SECRET")!, undefined, crypto);
  } catch (e) {
    console.error("signature invalide", e);
    return new Response("signature invalide", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const cs = event.data.object as Stripe.Checkout.Session;
        if (cs.subscription) {
          const s = await stripe.subscriptions.retrieve(cs.subscription as string);
          if (!s.metadata?.user_id && cs.client_reference_id) s.metadata = { ...s.metadata, user_id: cs.client_reference_id };
          await save(s);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await save(event.data.object as Stripe.Subscription);
        break;
    }
  } catch (e) {
    console.error(e);
    return new Response("erreur", { status: 500 }); // Stripe réessaiera
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
